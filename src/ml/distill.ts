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
import { scatter, type Decision, type SearchRecord, type Sparse } from './dataset';
import { INPUT_SIZE, STATE_SIZE } from './features';
import type { Mlp } from './mlp';
import { sampleTrainingStart, type TrainOptions } from './train';

export interface GenerateOptions {
  search: IsmctsOptions;
  /** Chance of playing a visit-weighted random move instead of the best, for variety. */
  exploreProb: number;
}

/** Play one training hand with ISMCTS at the learner seats, recording every searched decision. */
export function generateHand(opts: TrainOptions, gen: GenerateOptions, rng: Rng, heur: Agent): SearchRecord[] {
  const { state: s, learnerSeat } = sampleTrainingStart(opts, rng);
  const recorded: { d: SearchRecord; p: number }[] = [];

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
    const d: SearchRecord = {
      obs,
      moves: obs.legalMoves.map((m) => {
        const st = byKey.get(moveKey(m));
        return { value: st?.value ?? 0, visits: st?.visits ?? 0, chosen: moveKey(m) === moveKey(chosen) };
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
  /**
   * 'value': regress each move's value. 'policy': also match the search's
   * visit distribution with softmax(Q / tau), which trains the *differences*
   * between moves directly (what decides play) instead of absolute values.
   */
  loss: 'value' | 'policy';
  tau: number;
  policyWeight: number;
  /** Decisions per minibatch in 'policy' mode. */
  decisionsPerBatch: number;
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
  loss: 'policy',
  tau: 0.05,
  policyWeight: 1,
  decisionsPerBatch: 64,
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

/** Fraction of decisions where the network's best move is the search's most-visited move. */
export function agreement(net: Mlp, decisions: Decision[]): number {
  let hit = 0;
  for (const d of decisions) {
    const state = new Float32Array(STATE_SIZE);
    scatter(d.state, state);
    const q = net.predictShared(
      state,
      d.actions.map((a) => {
        const x = new Float32Array(INPUT_SIZE - STATE_SIZE);
        scatter(a.feat, x);
        return x;
      }),
    );
    let best = 0;
    let top = 0;
    d.actions.forEach((a, i) => {
      if (q[i] > q[best]) best = i;
      if (a.visits > d.actions[top].visits) top = i;
    });
    if (best === top) hit++;
  }
  return decisions.length ? hit / decisions.length : NaN;
}

/** One minibatch of the combined policy + value loss over whole decisions. */
function policyStep(net: Mlp, batch: Decision[], o: DistillOptions, lr: number): number {
  const xs: Float32Array[] = [];
  const spans: [number, number][] = [];
  for (const d of batch) {
    const start = xs.length;
    for (const a of d.actions) {
      const x = new Float32Array(INPUT_SIZE);
      scatter(d.state, x);
      scatter(a.feat, x, STATE_SIZE);
      xs.push(x);
    }
    spans.push([start, xs.length]);
  }
  return net.trainWith(
    xs,
    (q) => {
      const dy = new Array(q.length).fill(0);
      let ce = 0;
      let se = 0;
      let nv = 0;
      batch.forEach((d) => d.actions.forEach((a) => (a.chosen || a.visits >= o.minVisits) && nv++));
      batch.forEach((d, k) => {
        const [lo, hi] = spans[k];
        const total = d.actions.reduce((s, a) => s + a.visits, 0) || 1;
        let max = -Infinity;
        for (let i = lo; i < hi; i++) max = Math.max(max, q[i] / o.tau);
        let z = 0;
        for (let i = lo; i < hi; i++) z += Math.exp(q[i] / o.tau - max);
        d.actions.forEach((a, j) => {
          const i = lo + j;
          const p = Math.exp(q[i] / o.tau - max) / z;
          const pi = a.visits / total;
          if (pi > 0) ce -= pi * Math.log(Math.max(p, 1e-12));
          dy[i] += (o.policyWeight * (p - pi)) / o.tau / batch.length;
          if (a.chosen || a.visits >= o.minVisits) {
            const t = a.chosen ? o.alpha * a.value + (1 - o.alpha) * d.outcome : a.value;
            se += (q[i] - t) ** 2;
            dy[i] += (2 * (q[i] - t)) / nv;
          }
        });
      });
      return { loss: (o.policyWeight * ce) / batch.length + se / Math.max(1, nv), dy };
    },
    lr,
  );
}

/**
 * Supervised training on searched decisions. The validation split is by
 * decision (not by sample) so moves from one position never straddle it.
 */
export function distill(
  net: Mlp,
  decisions: Decision[],
  o: DistillOptions,
  onEpoch: (epoch: number, trainLoss: number, valLoss: number, valAgreement: number) => void = () => {},
): void {
  const rng = mulberry32(o.seed);
  const ds = shuffle(decisions.slice(), rng);
  const nVal = Math.floor(ds.length * o.valFrac);
  const valDecisions = ds.slice(0, nVal);
  const val = buildSamples(valDecisions, o);
  const train = buildSamples(ds.slice(nVal), o);
  const trainDecisions = ds.slice(nVal);
  const perEpoch = o.loss === 'policy' ? Math.floor(trainDecisions.length / o.decisionsPerBatch) : Math.floor(train.length / o.batchSize);
  const steps = o.epochs * perEpoch;
  let step = 0;

  for (let e = 1; e <= o.epochs; e++) {
    let sum = 0;
    let n = 0;
    const lrNow = () => o.lr * (1 - (1 - o.lrEndFrac) * (step++ / steps));
    if (o.loss === 'policy') {
      shuffle(trainDecisions, rng);
      for (let i = 0; i + o.decisionsPerBatch <= trainDecisions.length; i += o.decisionsPerBatch) {
        sum += policyStep(net, trainDecisions.slice(i, i + o.decisionsPerBatch), o, lrNow());
        n++;
      }
    } else {
      shuffle(train, rng);
      for (let i = 0; i + o.batchSize <= train.length; i += o.batchSize) {
        const batch = train.slice(i, i + o.batchSize);
        sum += net.trainBatch(batch.map(densify), batch.map((s) => s.target), lrNow());
        n++;
      }
    }
    onEpoch(e, sum / Math.max(1, n), mse(net, val), agreement(net, valDecisions));
  }
}

