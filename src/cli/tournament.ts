/**
 * Bot-vs-bot tournament. Seats rotate every game so no bot keeps a seat advantage.
 *
 *   npm run tournament -- --bots ismcts,heuristic,heuristic,random --games 100 --mode doughnut
 */
import { MODES, mulberry32 } from '../engine';
import { playGame } from '../runner';
import { makeBot, parseArgs } from './bots';

const args = parseArgs(process.argv.slice(2));
const specs = (args.bots ?? 'ismcts,heuristic,heuristic,random').split(',');
const games = Number(args.games ?? 50);
const mode = MODES[args.mode ?? 'doughnut'];
if (!mode) throw new Error(`Unknown mode. Available: ${Object.keys(MODES).join(', ')}`);
const seed = Number(args.seed ?? 1);

const n = specs.length;
const agents = specs.map(makeBot);
const totals = specs.map((spec) => ({
  spec,
  wins: 0,
  score: 0,
  hands: 0,
  played: 0,
  doughnuts: 0,
  folds: 0,
  tricks: 0,
  ms: 0,
  moves: 0,
}));

const rng = mulberry32(seed);
const t0 = performance.now();
for (let g = 0; g < games; g++) {
  // seat i is played by bot (i + g) % n
  const seatBot = Array.from({ length: n }, (_, i) => (i + g) % n);
  const log = playGame(mode, seatBot.map((b) => agents[b]), seed * 100003 + g, rng);
  const s = log.final;
  seatBot.forEach((b, seat) => {
    const t = totals[b];
    if (s.winners.includes(seat)) t.wins += 1 / s.winners.length;
    t.score += s.scores[seat];
    t.hands += s.handsPlayed;
    t.played += log.stats[seat].played;
    t.doughnuts += log.stats[seat].doughnuts;
    t.folds += log.stats[seat].folds;
    t.tricks += log.stats[seat].tricks;
    t.ms += log.moveMs[seat];
    t.moves += log.moves[seat];
  });
  if (args.verbose) console.log(`game ${g + 1}: winners ${s.winners.map((w) => specs[seatBot[w]]).join(', ')}`);
}

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
console.log(`\n${mode.name}: ${games} games, ${n} players, ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
console.table(
  totals.map((t) => ({
    bot: t.spec,
    'win %': pct(t.wins, games),
    'expected win %': pct(1, n),
    'avg final score': (t.score / games).toFixed(2),
    'play rate': pct(t.played, t.hands),
    'doughnut rate': pct(t.doughnuts, t.played),
    'tricks / hand played': (t.tricks / Math.max(1, t.played)).toFixed(2),
    'ms / move': (t.ms / Math.max(1, t.moves)).toFixed(1),
  })),
);
