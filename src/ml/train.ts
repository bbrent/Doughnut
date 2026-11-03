/**
 * Self-play training loop for the DMC model.
 *
 * Episodes are single hands starting from a randomly sampled scoreboard, so
 * every episode is short and bounded no matter how many players there are,
 * while the model still sees end-game situations (near zero, fold penalty).
 */
import type { Agent } from '../ai/agent';
import { heuristicAgent } from '../ai/heuristic';
import { handRewards } from '../ai/ismcts';
import { applyUnchecked, mulberry32, newGame, observe, randInt, type GameConfig, type Rng } from '../engine';
import { playGame } from '../runner';
import { argmax, concatInput, dmcAgent, evaluateMoves } from './dmc';
import type { Mlp } from './mlp';

export interface TrainOptions {
  config: GameConfig;
  hands: number;
  /** Player counts to sample for training hands, with relative weights. */
  playerWeights: Record<number, number>;
  batchSize: number;
  lr: number;
  bufferSize: number;
  /** Gradient samples per fresh sample (1 = each sample used about once). */
  replayRatio: number;
  epsilonStart: number;
  epsilonEnd: number;
  /** Fraction of seats played by the heuristic bot instead of the model. */
  heuristicSeatFrac: number;
  /** Fraction of hands where everyone starts at startScore. */
  freshStartFrac: number;
  scoreRange: [number, number];
  evalEvery: number;
  evalGames: number;
  evalPlayers: number;
  seed: number;
}

export const DEFAULT_TRAIN: Omit<TrainOptions, 'config'> = {
  hands: 200_000,
  playerWeights: { 2: 1, 3: 2, 4: 3, 5: 3, 6: 2, 7: 1, 8: 1, 9: 0.5, 10: 0.5 },
  batchSize: 256,
  lr: 5e-4,
  bufferSize: 200_000,
  replayRatio: 2,
  epsilonStart: 0.2,
  epsilonEnd: 0.02,
  heuristicSeatFrac: 0.25,
  freshStartFrac: 0.3,
  scoreRange: [1, 28],
  evalEvery: 20_000,
  evalGames: 100,
  evalPlayers: 4,
  seed: 1,
};

export interface EvalResult {
  hands: number;
  winRate: number;
  fairShare: number;
  avgScore: number;
  loss: number;
  handsPerSec: number;
}

function samplePlayers(weights: Record<number, number>, rng: Rng): number {
  const entries = Object.entries(weights).map(([k, w]) => [Number(k), w] as const);
  let r = rng() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of entries) if ((r -= w) <= 0) return k;
  return entries[entries.length - 1][0];
}

/** Win rate of the model vs heuristic bots in full games (seats rotate). */
export function evaluate(net: Mlp, config: GameConfig, players: number, games: number, seed: number) {
  const rng = mulberry32(seed);
  const model = dmcAgent(net);
  const heur = heuristicAgent();
  let wins = 0;
  let score = 0;
  for (let g = 0; g < games; g++) {
    const seat = g % players;
    const agents: Agent[] = Array.from({ length: players }, (_, i) => (i === seat ? model : heur));
    const s = playGame(config, agents, seed * 7919 + g, rng).final;
    if (s.winners.includes(seat)) wins += 1 / s.winners.length;
    score += s.scores[seat];
  }
  return { winRate: wins / games, fairShare: 1 / players, avgScore: score / games };
}

export interface HandSamples {
  xs: Float32Array[];
  ys: number[];
}

/**
 * Start a training hand: random player count, random scoreboard (or a fresh
 * game), random dealer. `learnerSeat[p]` marks seats played by the learner;
 * the rest are heuristic bots. At least one seat is always a learner seat.
 */
export function sampleTrainingStart(opts: TrainOptions, rng: Rng) {
  const n = samplePlayers(opts.playerWeights, rng);
  const [lo, hi] = opts.scoreRange;
  const scores =
    rng() < opts.freshStartFrac
      ? Array(n).fill(opts.config.scoring.startScore)
      : Array.from({ length: n }, () => lo + randInt(rng, hi - lo + 1));
  const state = newGame(opts.config, n, Math.floor(rng() * 2 ** 32), randInt(rng, n), scores);
  const learnerSeat = Array.from({ length: n }, () => rng() >= opts.heuristicSeatFrac);
  learnerSeat[randInt(rng, n)] = true;
  return { state, learnerSeat };
}

/** Play one training hand from a random scoreboard; returns the model's (input, reward) samples. */
export function playTrainingHand(net: Mlp, opts: TrainOptions, epsilon: number, rng: Rng, heur: Agent): HandSamples {
  const { state: s, learnerSeat: modelSeat } = sampleTrainingStart(opts, rng);

  const pending: { x: Float32Array; p: number }[] = [];
  while (s.phase !== 'handOver' && s.phase !== 'gameOver') {
    const p = s.toAct;
    const obs = observe(s, p);
    let move;
    if (!modelSeat[p]) {
      move = heur.chooseMove(obs, rng);
    } else if (obs.legalMoves.length === 1) {
      move = obs.legalMoves[0];
    } else {
      const ev = evaluateMoves(net, obs);
      const i = rng() < epsilon ? randInt(rng, obs.legalMoves.length) : argmax(ev.q);
      move = obs.legalMoves[i];
      pending.push({ x: concatInput(ev.state, ev.actions[i]), p });
    }
    applyUnchecked(s, move);
  }
  const rewards = handRewards(s);
  return { xs: pending.map((e) => e.x), ys: pending.map((e) => rewards[e.p]) };
}

export const epsilonAt = (opts: TrainOptions, progress: number) =>
  opts.epsilonStart + (opts.epsilonEnd - opts.epsilonStart) * Math.min(1, progress);

/** Replay buffer + learner, shared by the single- and multi-threaded trainers. */
export class Learner {
  private xs: Float32Array[] = [];
  private ys: number[] = [];
  private writeAt = 0;
  private fresh = 0;
  private lossSum = 0;
  private lossN = 0;
  updates = 0;

  constructor(
    readonly net: Mlp,
    readonly opts: TrainOptions,
    private rng: Rng,
  ) {}

  add(xs: Float32Array[], ys: number[]): void {
    for (let i = 0; i < xs.length; i++) {
      if (this.xs.length < this.opts.bufferSize) {
        this.xs.push(xs[i]);
        this.ys.push(ys[i]);
      } else {
        this.xs[this.writeAt] = xs[i];
        this.ys[this.writeAt] = ys[i];
        this.writeAt = (this.writeAt + 1) % this.opts.bufferSize;
      }
    }
    this.fresh += xs.length * this.opts.replayRatio;
  }

  /** Run as many minibatch updates as the fresh data allows (at most `max`). */
  step(max = Infinity): number {
    const { batchSize, lr } = this.opts;
    let done = 0;
    while (done < max && this.fresh >= batchSize && this.xs.length >= batchSize * 4) {
      const bx: Float32Array[] = [];
      const by: number[] = [];
      for (let k = 0; k < batchSize; k++) {
        const j = randInt(this.rng, this.xs.length);
        bx.push(this.xs[j]);
        by.push(this.ys[j]);
      }
      this.lossSum += this.net.trainBatch(bx, by, lr);
      this.lossN++;
      this.fresh -= batchSize;
      this.updates++;
      done++;
    }
    return done;
  }

  /** More fresh data queued than one minibatch: train before ingesting more. */
  hasBacklog(): boolean {
    return this.fresh >= this.opts.batchSize && this.xs.length >= this.opts.batchSize * 4;
  }

  takeLoss(): number {
    const l = this.lossN ? this.lossSum / this.lossN : NaN;
    this.lossSum = this.lossN = 0;
    return l;
  }
}

/** Single-threaded trainer. See trainParallel for the worker-based version. */
export function train(net: Mlp, opts: TrainOptions, onEval: (r: EvalResult) => void = () => {}): void {
  const rng = mulberry32(opts.seed);
  const heur = heuristicAgent();
  const learner = new Learner(net, opts, rng);
  let t0 = performance.now();
  let handsSinceEval = 0;
  for (let h = 1; h <= opts.hands; h++) {
    const { xs, ys } = playTrainingHand(net, opts, epsilonAt(opts, h / opts.hands), rng, heur);
    learner.add(xs, ys);
    learner.step();
    handsSinceEval++;
    if (h % opts.evalEvery === 0 || h === opts.hands) {
      const handsPerSec = handsSinceEval / ((performance.now() - t0) / 1000);
      const ev = evaluate(net, opts.config, opts.evalPlayers, opts.evalGames, 12345);
      onEval({ hands: h, ...ev, loss: learner.takeLoss(), handsPerSec });
      handsSinceEval = 0;
      t0 = performance.now();
    }
  }
}
