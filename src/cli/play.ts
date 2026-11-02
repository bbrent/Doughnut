/**
 * Play against bots in the terminal. You are seat 0.
 *
 *   npm run play -- --bots ismcts,heuristic,heuristic --mode doughnut
 */
import { createInterface } from 'node:readline/promises';
import {
  MODES,
  applyMove,
  cardToString,
  mulberry32,
  newGame,
  observe,
  startNextHand,
  type Card,
  type Move,
} from '../engine';
import { makeBot, parseArgs } from './bots';

const args = parseArgs(process.argv.slice(2));
const bots = (args.bots ?? 'ismcts,heuristic,heuristic').split(',').map(makeBot);
const mode = MODES[args.mode ?? 'doughnut'];
const seed = Number(args.seed ?? Date.now() % 1e9);
const rng = mulberry32(seed);
const names = ['You', ...bots.map((b, i) => `P${i + 1} (${b.name})`)];
const c = (x: Card) => cardToString(x, true);

function describe(m: Move): string {
  switch (m.kind) {
    case 'exchange':
      return m.discard === null ? 'keep hand' : `swap ${c(m.discard)} for the turn-up`;
    case 'declare':
      return m.play ? 'play' : 'fold';
    case 'pickup':
      return `pick up, discard ${c(m.discard)}`;
    case 'card':
      return c(m.card);
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let s = newGame(mode, bots.length + 1, seed);
for (;;) {
  console.log(`\n=== Hand ${s.handsPlayed + 1} — dealer ${names[s.dealer]} — turn-up ${c(s.turnUp)}${s.forced ? ' (everyone plays)' : ''}`);
  console.log('Scores: ' + names.map((n, p) => `${n} ${s.scores[p]}`).join(', '));
  let trickCount = 0;
  while (s.phase !== 'handOver' && s.phase !== 'gameOver') {
    const p = s.toAct;
    const obs = observe(s, p);
    let m: Move;
    if (p === 0) {
      const lead = s.currentTrick.length ? `  trick so far: ${s.currentTrick.map((x) => `${names[x.player]} ${c(x.card)}`).join(', ')}` : '';
      console.log(`\nYour hand: ${obs.hand.map(c).join(' ')}   trump ${c(s.turnUp).slice(-1)}${lead}`);
      obs.legalMoves.forEach((lm, i) => console.log(`  ${i + 1}) ${describe(lm)}`));
      let i = NaN;
      while (!(i >= 1 && i <= obs.legalMoves.length)) i = Number(await rl.question('> '));
      m = obs.legalMoves[i - 1];
    } else {
      m = bots[p - 1].chooseMove(obs, rng);
      const shown = m.kind === 'pickup' ? 'picks up' : m.kind === 'exchange' ? (m.discard === null ? 'keeps hand' : 'takes the turn-up') : describe(m);
      console.log(`${names[p]}: ${shown}`);
    }
    s = applyMove(s, m);
    if (s.tricks.length > trickCount) {
      trickCount = s.tricks.length;
      console.log(`  -> ${names[s.tricks[trickCount - 1].winner]} takes the trick`);
    }
  }
  const h = s.lastHand!;
  console.log('Hand result: ' + names.map((n, p) => `${n} ${h.played[p] ? `${h.tricks[p]} tricks` : 'folded'} (${h.deltas[p] >= 0 ? '+' : ''}${h.deltas[p]})`).join(', '));
  if (s.phase === 'gameOver') {
    console.log(`\nGame over after ${s.handsPlayed} hands. Winner: ${s.winners.map((w) => names[w]).join(' & ')}`);
    break;
  }
  s = startNextHand(s);
}
rl.close();
