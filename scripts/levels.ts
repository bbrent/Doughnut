// Calibrate bot difficulty levels: candidates play 4-player games against each other,
// seats rotating. npx tsx scripts/levels.ts [games] [--explore]
import { readFileSync } from 'node:fs';
import { heuristicAgent, type Agent } from '../src/ai';
import { DOUGHNUT, mulberry32 } from '../src/engine';
import { dmcAgent, loadModel } from '../src/ml';
import { playGame } from '../src/runner';
import { BOT_LEVEL_IDS, botFactory } from '../src/game/bots';

const games = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 600);
const net = loadModel(JSON.parse(readFileSync('models/doughnut.json', 'utf8')));
const candidates: Record<string, () => Agent> = process.argv.includes('--explore')
  ? {
      'heuristic': () => heuristicAgent(),
      'dmc t=0.30': () => dmcAgent(net, { temperature: 0.3 }),
      'dmc t=0.15': () => dmcAgent(net, { temperature: 0.15 }),
      'dmc t=0.08': () => dmcAgent(net, { temperature: 0.08 }),
      'dmc t=0.04': () => dmcAgent(net, { temperature: 0.04 }),
      'dmc greedy': () => dmcAgent(net),
      'dmc eps=0.15': () => dmcAgent(net, { epsilon: 0.15 }),
    }
  : {
      // The shipped levels (src/game/bots.ts), with the rule-based bot as a reference.
      ...Object.fromEntries(BOT_LEVEL_IDS.map((l) => [l, () => botFactory(net)(l)])),
      'rule-based': () => heuristicAgent(),
    };
const names = Object.keys(candidates);
// Each game: 4 distinct candidates, chosen round-robin so every pair meets equally often.
const wins: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
const played: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
const rng = mulberry32(7);
for (let g = 0; g < games; g++) {
  const pool = names.slice();
  const seats: string[] = [];
  for (let k = 0; k < 4; k++) seats.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  const s = playGame(DOUGHNUT, seats.map((n) => candidates[n]()), 1000 + g, rng).final;
  seats.forEach((n, i) => {
    played[n]++;
    if (s.winners.includes(i)) wins[n] += 1 / s.winners.length;
  });
}
console.log(`${games} four-player games, fair share 25%`);
for (const n of names.sort((a, b) => wins[b] / played[b] - wins[a] / played[a])) {
  console.log(`${n.padEnd(14)} ${((100 * wins[n]) / played[n]).toFixed(1).padStart(5)}%  (${played[n]} games)`);
}
