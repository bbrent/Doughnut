// How many hands do games last? Usage: npx tsx scripts/game-length.ts
import { heuristicAgent } from '../src/ai';
import { DOUGHNUT, mulberry32 } from '../src/engine';
import { playGame } from '../src/runner';
const cfg = { ...DOUGHNUT, end: { targetScore: 0, maxHands: 2000 } };
for (const n of [2, 3, 4, 5, 6]) {
  const lens: number[] = [];
  for (let g = 0; g < 200; g++) lens.push(playGame(cfg, Array.from({ length: n }, () => heuristicAgent()), g, mulberry32(g)).final.handsPlayed);
  lens.sort((a, b) => a - b);
  console.log(`${n} players: median ${lens[100]}, p90 ${lens[180]}, max ${lens[199]}`);
}
