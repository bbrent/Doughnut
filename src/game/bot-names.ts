/**
 * Names for AI players. Kept to 12 characters so they fit on a seat plate.
 * Bots are marked with a robot icon, so these can be anything fun.
 */
import { randInt, type Rng } from '../engine';

export const BOT_NAMES = [
  'Sir Bitsalot', 'Deep Blew', 'Clanky', 'Beep Boop', 'Glitchard', 'Trumpinator',
  'Sprocket', 'Doughbot', 'Ctrl Alt Del', 'Al Gorithm', 'Rusty Bolts', 'Nibbles',
  'HAL 9001', 'Turing Tess', 'Captain Byte', 'Wattson', 'Bitty Boop', 'Ada Bytelace',
  'Chip Shuffle', 'Mr. Roboto', 'Dealer.exe', 'Captcha Kate', 'Gizmo', 'Pixel Pete',
  'Null Pointer', 'Sir Loops', 'Overclocked', 'Bleep Bloop', 'Cogsworth', 'Doughnut AI',
  'Sparky', 'Col. Kernel', 'Rob Ott', 'Bit Shifter', 'Polly Gone', 'Botticelli',
  'Tin Can Tim', 'Lord Bytes', 'Fuzzy Logic', 'Data Dave', 'Unit 404', 'Trick-E',
  'Robo Rita', 'Lag Monster', 'Mainframe Mo', 'Dot Matrix', 'Cache Money', 'Buzz Kernel',
];

/** Pick `n` distinct names, avoiding any already taken (case-insensitive). */
export function pickBotNames(n: number, taken: string[], rng: Rng): string[] {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const pool = BOT_NAMES.filter((b) => !used.has(b.toLowerCase()));
  const out: string[] = [];
  let extra = 0;
  for (let i = 0; i < n; i++) {
    if (pool.length) out.push(pool.splice(randInt(rng, pool.length), 1)[0]);
    else out.push(`Robot ${++extra}`);
  }
  return out;
}
