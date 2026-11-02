import {
  applyUnchecked,
  cloneState,
  determinize,
  isHandDone,
  legalMoves,
  moveKey,
  pick,
  type GameState,
  type Move,
  type Observation,
  type Rng,
} from '../engine';
import type { Agent } from './agent';
import { heuristicMove, viewFromState } from './heuristic';

export interface IsmctsOptions {
  /** Search iterations per decision (each samples a fresh hidden deal). */
  iterations: number;
  /** Optional wall-clock cap per decision, in ms. */
  timeLimitMs?: number;
  /** UCB exploration constant. */
  exploration: number;
  /** Playout policy after leaving the tree. */
  rollout: 'random' | 'heuristic';
  /** Chance of a random move during heuristic playouts. */
  rolloutEpsilon: number;
}

export const DEFAULT_ISMCTS: IsmctsOptions = {
  iterations: 1500,
  exploration: 0.7,
  rollout: 'heuristic',
  rolloutEpsilon: 0.1,
};

class Node {
  children = new Map<string, Node>();
  visits = 0;
  available = 0;
  reward = 0;
  constructor(
    readonly move: Move | null,
    /** Player who made `move` — rewards are stored from their perspective. */
    readonly player: number,
  ) {}
}

/** Per-player utility at the end of a hand, roughly in [-1, 1] plus a game-win bonus. */
export function handRewards(s: GameState): number[] {
  const deltas = s.lastHand!.deltas;
  const { perTrick, noTrickPenalty } = s.config.scoring;
  const scale = Math.max(Math.abs(perTrick) * s.config.handSize, Math.abs(noTrickPenalty), 1);
  return deltas.map((d, p) => {
    // Lower score is better, so reward is the negated change.
    let r = -d / scale;
    if (s.phase === 'gameOver') r += s.winners.includes(p) ? 1 : 0;
    return r;
  });
}

function rolloutMove(s: GameState, opts: IsmctsOptions, rng: Rng): Move {
  if (opts.rollout === 'random' || rng() < opts.rolloutEpsilon) return pick(legalMoves(s), rng);
  return heuristicMove(viewFromState(s));
}

/** Single-observer Information Set MCTS. Returns visit counts per root move. */
export function ismctsSearch(obs: Observation, rng: Rng, opts: IsmctsOptions = DEFAULT_ISMCTS) {
  const root = new Node(null, -1);
  const deadline = opts.timeLimitMs ? performance.now() + opts.timeLimitMs : Infinity;

  for (let it = 0; it < opts.iterations && performance.now() < deadline; it++) {
    const s = cloneState(determinize(obs, rng));
    let node = root;
    const path: Node[] = [];

    // Selection / expansion.
    while (!isHandDone(s)) {
      const legal = legalMoves(s);
      const untried = legal.filter((m) => !node.children.has(moveKey(m)));
      if (untried.length) {
        const m = pick(untried, rng);
        const child = new Node(m, s.toAct);
        node.children.set(moveKey(m), child);
        for (const l of legal) {
          const c = node.children.get(moveKey(l));
          if (c) c.available++;
        }
        applyUnchecked(s, m);
        node = child;
        path.push(child);
        break;
      }
      let best: Node | null = null;
      let bestScore = -Infinity;
      for (const l of legal) {
        const c = node.children.get(moveKey(l))!;
        c.available++;
        const score = c.reward / c.visits + opts.exploration * Math.sqrt(Math.log(c.available) / c.visits);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      applyUnchecked(s, best!.move!);
      node = best!;
      path.push(best!);
    }

    // Playout to the end of the hand.
    while (!isHandDone(s)) applyUnchecked(s, rolloutMove(s, opts, rng));

    const rewards = handRewards(s);
    for (const n of path) {
      n.visits++;
      n.reward += rewards[n.player];
    }
    root.visits++;
  }

  return [...root.children.values()]
    .filter((c) => obs.legalMoves.some((m) => moveKey(m) === moveKey(c.move!)))
    .map((c) => ({ move: c.move!, visits: c.visits, value: c.visits ? c.reward / c.visits : 0 }))
    .sort((a, b) => b.visits - a.visits);
}

export const ismctsAgent = (opts: Partial<IsmctsOptions> = {}): Agent => {
  const o = { ...DEFAULT_ISMCTS, ...opts };
  return {
    name: `ismcts${o.iterations}`,
    chooseMove(obs, rng) {
      if (obs.legalMoves.length === 1) return obs.legalMoves[0];
      const stats = ismctsSearch(obs, rng, o);
      return stats.length ? stats[0].move : pick(obs.legalMoves, rng);
    },
  };
};
