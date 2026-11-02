import type { Agent } from './ai';
import { applyMove, newGame, observe, startNextHand, type GameConfig, type GameState, type Rng } from './engine';

export interface GameLog {
  final: GameState;
  /** Per seat: hands played, doughnuts, folds. */
  stats: { played: number; doughnuts: number; folds: number; tricks: number }[];
  moveMs: number[];
  moves: number[];
}

/** Play a full game with one agent per seat. */
export function playGame(
  config: GameConfig,
  agents: Agent[],
  seed: number,
  rng: Rng,
  onHand?: (s: GameState) => void,
): GameLog {
  let s = newGame(config, agents.length, seed, seed % agents.length);
  const stats = agents.map(() => ({ played: 0, doughnuts: 0, folds: 0, tricks: 0 }));
  const moveMs = agents.map(() => 0);
  const moves = agents.map(() => 0);
  for (;;) {
    while (s.phase !== 'handOver' && s.phase !== 'gameOver') {
      const p = s.toAct;
      const t = performance.now();
      const m = agents[p].chooseMove(observe(s, p), rng);
      moveMs[p] += performance.now() - t;
      moves[p]++;
      s = applyMove(s, m);
    }
    const h = s.lastHand!;
    h.played.forEach((pl, p) => {
      if (pl) {
        stats[p].played++;
        stats[p].tricks += h.tricks[p];
        if (h.tricks[p] === 0) stats[p].doughnuts++;
      } else stats[p].folds++;
    });
    onHand?.(s);
    if (s.phase === 'gameOver') return { final: s, stats, moveMs, moves };
    s = startNextHand(s);
  }
}
