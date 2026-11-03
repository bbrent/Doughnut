/**
 * Expert iteration, step 1: distil ISMCTS into the network.
 *
 * ISMCTS plays training hands and, at each decision, we record its value
 * estimate for *every* legal move, not just the one played. The network is
 * then trained to predict those values, so it learns from a stronger player
 * than itself instead of only from its own games.
 */
import type { Agent } from '../ai/agent';
import { handRewards, ismctsSearch, type IsmctsOptions } from '../ai/ismcts';
import { applyUnchecked, moveKey, mulberry32, observe, shuffle, type Rng } from '../engine';
import { scatter, toSparse, type Decision, type Sparse } from './dataset';
import { encodeAction, encodeState, makeContext, INPUT_SIZE, STATE_SIZE } from './features';
import type { Mlp } from './mlp';
import { sampleTrainingStart, type TrainOptions } from './train';

export interface GenerateOptions {
  search: IsmctsOptions;
  /** Chance of playing a visit-weighted random move instead of the best, for variety. */
  exploreProb: number;
}

/** Play one training hand with ISMCTS at the learner seats, recording every searched decision. */
export function generateHand(opts: TrainOptions, gen: GenerateOptions, rng: Rng, heur: Agent): Decision[] {
  const { state: s, learnerSeat } = sampleTrainingStart(opts, rng);
  const recorded: { d: Decision; p: number }[] = [];

  while (s.phase !== 'handOver' && s.phase !== 'gameOver') {
    const p = s.toAct;
    const obs = observe(s, p);
    if (!learnerSeat[p]) {
      applyUnchecked(s, heur.chooseMove(obs, rng));
      continue;
    }
    if (obs.legalMoves.length === 1) {
      applyUnchecked(s, obs.legalMoves[0]);
      continue;
    }
    const stats = ismctsSearch(obs, rng, gen.search);
    const byKey = new Map(stats.map((st) => [moveKey(st.move), st]));
    let chosen = stats[0].move;
    if (rng() < gen.exploreProb) {
      let r = rng() * stats.reduce((a, st) => a + st.visits, 0);
      for (const st of stats) if ((r -= st.visits) <= 0) {
        chosen = st.move;
        break;
      }
    }
    const ctx = makeContext(obs);
    const d: Decision = {
      state: toSparse(encodeState(ctx)),
      actions: obs.legalMoves.map((m) => {
        const st = byKey.get(moveKey(m));
        return {
          feat: toSparse(encodeAction(ctx, m)),
          value: st?.value ?? 0,
          visits: st?.visits ?? 0,
          chosen: moveKey(m) === moveKey(chosen),
        };
      }),
      outcome: 0,
    };
    recorded.push({ d, p });
    applyUnchecked(s, chosen);
  }

  const rewards = handRewards(s);
  for (const r of recorded) r.d.outcome = rewards[r.p];
  return recorded.map((r) => r.d);
}

export interface DistillOptions {
  epochs: number;
  batchSize: number;
  lr: number;
  /** Final learning rate as a fraction of lr (linear decay). */
  lrEndFrac: number;
  /** Chosen move's target = alpha * search value + (1 - alpha) * actual outcome. */
  alpha: number;
  /** Skip unchosen moves the search visited fewer times than this (too noisy). */
  minVisits: number;
  valFrac: number;
  seed: number;
}

export const DEFAULT_DISTILL: DistillOptions = {
  epochs: 6,
  batchSize: 256,
  lr: 5e-4,
  lrEndFrac: 0.1,
  alpha: 0.5,
  minVisits: 20,
  valFrac: 0.05,
  seed: 1,
};

export interface Sample {
  state: Sparse;
  action: Sparse;
  target: number;
}

export function buildSamples(decisions: Decision[], o: DistillOptions): Sample[] {
  const out: Sample[] = [];
  for (const d of decisions) {
    for (const a of d.actions) {
      if (a.chosen) out.push({ state: d.state, action: a.feat, target: o.alpha * a.value + (1 - o.alpha) * d.outcome });
      else if (a.visits >= o.minVisits) out.push({ state: d.state, action: a.feat, target: a.value });
    }
  }
  return out;
}

function densify(s: Sample): Float32Array {
  const x = new Float32Array(INPUT_SIZE);
  scatter(s.state, x);
  scatter(s.action, x, STATE_SIZE);
  return x;
}

export function mse(net: Mlp, samples: Sample[]): number {
  let sum = 0;
  for (const s of samples) sum += (net.predict(densify(s)) - s.target) ** 2;
  return samples.length ? sum / samples.length : NaN;
}

/**
 * Supervised training on searched decisions. The validation split is by
 * decision (not by sample) so moves from one position never straddle it.
 */
export function distill(
  net: Mlp,
  decisions: Decision[],
  o: DistillOptions,
  onEpoch: (epoch: number, trainLoss: number, valLoss: number) => void = () => {},
): void {
  const rng = mulberry32(o.seed);
  const ds = shuffle(decisions.slice(), rng);
  const nVal = Math.floor(ds.length * o.valFrac);
  const val = buildSamples(ds.slice(0, nVal), o);
  const train = buildSamples(ds.slice(nVal), o);
  const steps = o.epochs * Math.floor(train.length / o.batchSize);
  let step = 0;

  for (let e = 1; e <= o.epochs; e++) {
    shuffle(train, rng);
    let sum = 0;
    let n = 0;
    for (let i = 0; i + o.batchSize <= train.length; i += o.batchSize) {
      const lr = o.lr * (1 - (1 - o.lrEndFrac) * (step++ / steps));
      const batch = train.slice(i, i + o.batchSize);
      sum += net.trainBatch(batch.map(densify), batch.map((s) => s.target), lr);
      n++;
    }
    onEpoch(e, sum / Math.max(1, n), mse(net, val));
  }
}

