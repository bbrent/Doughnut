import { describe, expect, it } from 'vitest';
import { heuristicAgent, ismctsAgent, randomAgent } from '../src/ai';
import { DOUGHNUT, mulberry32 } from '../src/engine';
import { playGame } from '../src/runner';

describe('agents', () => {
  it('every agent completes games with only legal moves', () => {
    const rng = mulberry32(1);
    const log = playGame(DOUGHNUT, [randomAgent(), heuristicAgent(), ismctsAgent({ iterations: 50 })], 5, rng);
    expect(log.final.phase).toBe('gameOver');
  });

  it('heuristic beats random', () => {
    const rng = mulberry32(2);
    let wins = 0;
    const games = 60;
    for (let g = 0; g < games; g++) {
      const seats = [heuristicAgent(), randomAgent(), randomAgent()];
      const seat = g % 3;
      [seats[0], seats[seat]] = [seats[seat], seats[0]];
      const log = playGame(DOUGHNUT, seats, g, rng);
      if (log.final.winners.includes(seat)) wins++;
    }
    expect(wins / games).toBeGreaterThan(0.45);
  });
});
