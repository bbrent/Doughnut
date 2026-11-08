/**
 * Deep Monte Carlo (DouZero-style): a network Q(state, action) predicts the
 * final hand reward of taking `action`. Play = argmax over legal moves.
 */
import type { Agent } from '../ai/agent';
import { pick, type Move, type Observation, type Rng } from '../engine';
import { encodeAction, encodeState, makeContext, ACTION_SIZE, FEATURE_VERSION, STATE_SIZE } from './features';
import { Mlp, type MlpJSON } from './mlp';

export const DEFAULT_HIDDEN = [256, 128];

export function createModel(rng: Rng, hidden = DEFAULT_HIDDEN): Mlp {
  return Mlp.create([STATE_SIZE + ACTION_SIZE, ...hidden, 1], rng);
}

export function loadModel(j: MlpJSON): Mlp {
  if (j.meta?.featureVersion !== FEATURE_VERSION) {
    throw new Error(`Model feature version ${j.meta?.featureVersion} != ${FEATURE_VERSION}; retrain`);
  }
  return Mlp.fromJSON(j);
}

export interface Evaluated {
  state: Float32Array;
  actions: Float32Array[];
  q: number[];
}

export function evaluateMoves(net: Mlp, obs: Observation): Evaluated {
  const ctx = makeContext(obs);
  const state = encodeState(ctx);
  const actions = obs.legalMoves.map((m) => encodeAction(ctx, m));
  return { state, actions, q: net.predictShared(state, actions) };
}

export function concatInput(state: Float32Array, action: Float32Array): Float32Array {
  const x = new Float32Array(state.length + action.length);
  x.set(state);
  x.set(action, state.length);
  return x;
}

export function argmax(xs: number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

/**
 * Options: `epsilon` plays a uniformly random move that often (training
 * exploration). `temperature` > 0 picks moves with probability
 * softmax(Q / temperature): mostly the best, sometimes one rated nearly as
 * well, which makes believable mistakes for easier bots.
 */
export function dmcAgent(net: Mlp, opts: { epsilon?: number; temperature?: number; name?: string } = {}): Agent {
  const epsilon = opts.epsilon ?? 0;
  const temperature = opts.temperature ?? 0;
  return {
    name: opts.name ?? 'dmc',
    chooseMove(obs: Observation, rng: Rng): Move {
      if (obs.legalMoves.length === 1) return obs.legalMoves[0];
      if (epsilon > 0 && rng() < epsilon) return pick(obs.legalMoves, rng);
      const q = evaluateMoves(net, obs).q;
      if (temperature <= 0) return obs.legalMoves[argmax(q)];
      const max = Math.max(...q);
      const w = q.map((x) => Math.exp((x - max) / temperature));
      let r = rng() * w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < w.length; i++) if ((r -= w[i]) <= 0) return obs.legalMoves[i];
      return obs.legalMoves[argmax(q)];
    },
  };
}

