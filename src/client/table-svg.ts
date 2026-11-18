/**
 * The card table as one SVG: a felt oval inside a stitched leather rail
 * ("belt"), seats on the rail, played cards on the felt in front of each
 * player, and the turn-up in the middle. You always sit at the bottom;
 * the others follow clockwise in playing order.
 */
import { RANKS, SUIT_SYMBOLS, rankOf, suitOf, type Card } from '../engine';
import type { TableView, WireObservation } from '../game/protocol';
import { robotSvg } from './icons';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

interface Layout {
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** Felt, rail (outer edge) and seat ellipses. */
  felt: [number, number];
  rail: [number, number];
  seat: [number, number];
  plate: [number, number];
  card: [number, number];
  /** How far from the centre (0..1 of the seat ellipse) played cards land. */
  playRadius: number;
}

const LANDSCAPE: Layout = {
  w: 1000, h: 620, cx: 500, cy: 300,
  felt: [370, 195], rail: [425, 245], seat: [400, 252],
  plate: [158, 66], card: [62, 88], playRadius: 0.52,
};

const PORTRAIT: Layout = {
  w: 620, h: 880, cx: 310, cy: 430,
  felt: [205, 330], rail: [250, 380], seat: [228, 382],
  plate: [150, 66], card: [56, 80], playRadius: 0.5,
};

export function chooseLayout(viewportWidth: number): Layout {
  return viewportWidth < 640 ? PORTRAIT : LANDSCAPE;
}

/** Seat i's angle: you at the bottom, then clockwise (to your left first). */
function seatAngle(i: number, you: number, n: number): number {
  const k = (i - Math.max(0, you) + n) % n;
  return Math.PI / 2 + (k * 2 * Math.PI) / n;
}

function point(L: Layout, angle: number, [rx, ry]: [number, number], scale = 1): [number, number] {
  return [L.cx + Math.cos(angle) * rx * scale, L.cy + Math.sin(angle) * ry * scale];
}

export function cardSvg(c: Card, x: number, y: number, [w, h]: [number, number], opts: { rotate?: number; highlight?: boolean; faded?: boolean } = {}): string {
  const red = suitOf(c) === 1 || suitOf(c) === 2;
  const rank = RANKS[rankOf(c)];
  const suit = SUIT_SYMBOLS[suitOf(c)];
  const fs = w * 0.3;
  return `<g class="svg-card${red ? ' red' : ''}${opts.faded ? ' faded' : ''}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(opts.rotate ?? 0).toFixed(1)})">
    ${opts.highlight ? `<rect x="${-w / 2 - 5}" y="${-h / 2 - 5}" width="${w + 10}" height="${h + 10}" rx="11" class="card-glow"/>` : ''}
    <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="7" class="card-face"/>
    <text x="${-w / 2 + 6}" y="${-h / 2 + fs + 2}" font-size="${fs}" class="card-ink" font-weight="700">${rank}</text>
    <text x="${-w / 2 + 6}" y="${-h / 2 + fs * 2 + 2}" font-size="${fs * 0.85}" class="card-ink">${suit}</text>
    <text x="${w * 0.08}" y="${h * 0.32}" font-size="${w * 0.55}" text-anchor="middle" class="card-ink">${suit}</text>
  </g>`;
}

function defs(): string {
  return `<defs>
    <radialGradient id="felt" cx="50%" cy="45%" r="65%">
      <stop offset="0" style="stop-color:var(--felt-hi)"/>
      <stop offset="0.7" style="stop-color:var(--felt)"/>
      <stop offset="1" style="stop-color:var(--felt-dark)"/>
    </radialGradient>
    <linearGradient id="belt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--belt-hi)"/>
      <stop offset="0.5" style="stop-color:var(--belt)"/>
      <stop offset="1" style="stop-color:var(--belt-dark)"/>
    </linearGradient>
    <pattern id="feltpat" width="56" height="56" patternUnits="userSpaceOnUse">
      <text x="10" y="22" font-size="14" fill="#fff" opacity="0.035">♠</text>
      <text x="38" y="50" font-size="14" fill="#fff" opacity="0.035">♥</text>
    </pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-opacity="0.35"/>
    </filter>
  </defs>`;
}

function tableShape(L: Layout): string {
  const [frx, fry] = L.felt;
  const [rrx, rry] = L.rail;
  const beltW = rrx - frx;
  const mid: [number, number] = [(rrx + frx) / 2, (rry + fry) / 2];
  return `
    <ellipse cx="${L.cx}" cy="${L.cy}" rx="${rrx}" ry="${rry}" fill="url(#belt)" filter="url(#shadow)"/>
    <ellipse cx="${L.cx}" cy="${L.cy}" rx="${rrx - 3}" ry="${rry - 3}" fill="none" style="stroke:var(--belt-hi)" stroke-width="2" opacity="0.6"/>
    <ellipse cx="${L.cx}" cy="${L.cy}" rx="${mid[0]}" ry="${mid[1]}" fill="none" style="stroke:var(--stitch)" stroke-width="2" stroke-dasharray="7 6" opacity="0.8"/>
    <ellipse cx="${L.cx}" cy="${L.cy}" rx="${frx + beltW * 0.12}" ry="${fry + beltW * 0.12}" fill="none" style="stroke:var(--belt-dark)" stroke-width="${beltW * 0.24}"/>
    <ellipse cx="${L.cx}" cy="${L.cy}" rx="${frx}" ry="${fry}" fill="url(#felt)"/>
    <ellipse cx="${L.cx}" cy="${L.cy}" rx="${frx}" ry="${fry}" fill="url(#feltpat)"/>
    <ellipse cx="${L.cx}" cy="${L.cy}" rx="${frx - 14}" ry="${fry - 14}" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.12"/>`;
}

function seatPlate(L: Layout, t: TableView, o: WireObservation | null, i: number): string {
  const n = t.seats.length;
  const a = seatAngle(i, t.you, n);
  const [x, y] = point(L, a, L.seat);
  const [w, h] = L.plate;
  const seat = t.seats[i];
  const you = i === t.you;
  const turn = !!o && o.toAct === i && (o.phase === 'play' || o.phase === 'declare' || o.phase === 'exchange');
  const out = !!o && o.playing[i] === false;
  const open = seat.kind === 'open';
  const isBot = seat.kind === 'bot';
  const hasIcon = isBot || seat.covered;
  // The name gets the whole top line; ~9px per character at this size.
  const name = clip(seat.name, Math.floor((w - (hasIcon ? 35 : 14) - 10) / 9));

  let status = '';
  if (!o) status = open ? 'waiting…' : isBot ? 'AI player' : i === t.hostSeat ? 'host' : seat.connected ? 'ready' : 'away';
  else if (seat.covered) status = 'away · bot playing';
  else if (o.phase === 'declare' && o.playing[i] === null) status = turn ? 'deciding…' : 'to decide';
  else if (o.playing[i] === false) status = 'folded';
  else if (o.playing[i]) status = `${o.tricksWon[i]} trick${o.tricksWon[i] === 1 ? '' : 's'}`;

  const cls = ['seat-plate', you ? 'you' : '', turn ? 'turn' : '', out ? 'out' : '', open ? 'open' : ''].join(' ');
  const score = o ? `<text x="${w / 2 - 12}" y="${-h / 2 + 48}" text-anchor="end" class="plate-score">${o.scores[i]}</text>` : '';
  const dealer =
    o && o.dealer === i
      ? `<g transform="translate(${-w / 2 + 2} ${-h / 2 + 2})"><circle r="13" class="dealer-chip"/><text y="5" text-anchor="middle" class="dealer-text">D</text></g>`
      : '';
  // Robot icon before the name marks AI players.
  const icon = hasIcon ? robotSvg(-w / 2 + 11, -h / 2 + 8, 20) : '';
  const nameX = -w / 2 + (icon ? 35 : 14);
  // Pips for tricks taken this hand.
  const pips =
    o && o.playing[i]
      ? Array.from({ length: o.tricksWon[i] }, (_, k) => `<circle cx="${-w / 2 + 16 + k * 12}" cy="${h / 2 - 10}" r="4" class="pip"/>`).join('')
      : '';
  return `<g class="${cls}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
    <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="14" class="plate-bg"/>
    ${icon}<text x="${nameX}" y="${-h / 2 + 24}" class="plate-name">${esc(name)}</text>
    <text x="${-w / 2 + 14}" y="${-h / 2 + 44}" class="plate-status">${esc(status)}</text>
    ${score}${pips}${dealer}
  </g>`;
}

// ---- animation clock ---------------------------------------------------------------
// The table is redrawn on every update, which would restart CSS animations.
// Each animation remembers when it first started, so a redraw resumes it with
// a negative animation-delay instead of starting over.
const animStarts = new Map<string, number>();

/** Milliseconds since `key` first appeared (Infinity if never). */
function animAge(key: string): number {
  const t0 = animStarts.get(key);
  return t0 === undefined ? Infinity : performance.now() - t0;
}

/** animation-delay for an animation that should begin `ms` after `key` first appeared. */
export function animDelay(key: string, ms: number): string {
  const now = performance.now();
  if (!animStarts.has(key)) {
    if (animStarts.size > 300) animStarts.clear();
    animStarts.set(key, now);
  }
  return `${Math.round(ms - (now - animStarts.get(key)!))}ms`;
}

/** A face-down card (for trick piles and the deck). */
export function cardBackSvg(x: number, y: number, [w, h]: [number, number], rotate = 0): string {
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rotate.toFixed(1)})">
    <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="6" class="card-back"/>
    <rect x="${-w / 2 + 4}" y="${-h / 2 + 4}" width="${w - 8}" height="${h - 8}" rx="4" class="card-back-inner"/>
    <circle r="${w * 0.17}" class="card-back-ring" stroke-width="${w * 0.11}"/>
  </g>`;
}

/** Where a player's won tricks are stacked: on the felt, just in front of their seat. */
function pilePos(L: Layout, t: TableView, player: number): [number, number] {
  // A little to one side of the line to the centre, so the card a player leads doesn't cover it.
  return point(L, seatAngle(player, t.you, t.seats.length) + 0.2, L.seat, 0.74);
}

/** A small stack of face-down cards (one card per trick, up to 4 drawn). */
function pileSvg(L: Layout, x: number, y: number, count: number, seed: number): string {
  const size: [number, number] = [L.card[0] * 0.55, L.card[1] * 0.55];
  let out = '';
  for (let k = 0; k < Math.min(count, 4); k++) out += cardBackSvg(x + k * 2.5, y - k * 2.5, size, ((seed * 13 + k * 29) % 21) - 10);
  return out;
}

/** Wrap content so it slides from where it is by (dx, dy), shrinking and fading. */
function flying(content: string, dx: number, dy: number, key: string, delayMs: number, cls = 'fly'): string {
  return `<g class="${cls}" style="--dx:${dx.toFixed(1)}px;--dy:${dy.toFixed(1)}px;animation-delay:${animDelay(key, delayMs)}">${content}</g>`;
}

/** Every player's trick pile (static). `except`: the trick still flying in. */
function piles(L: Layout, t: TableView, o: WireObservation, except?: number): string {
  return o.tricksWon
    .map((won, p) => {
      const n = won - (except === p ? 1 : 0);
      if (n <= 0) return '';
      const [x, y] = pilePos(L, t, p);
      return pileSvg(L, x, y, n, p);
    })
    .join('');
}

/**
 * A played card sliding in from its player's seat to its place on the felt.
 * `trick` is the trick's index in the hand, so each card animates once.
 */
function playedCard(L: Layout, t: TableView, o: WireObservation, trick: number, player: number, card: number, highlight = false): string {
  const a = seatAngle(player, t.you, t.seats.length);
  const [x, y] = point(L, a, L.seat, L.playRadius);
  const [sx, sy] = point(L, a, L.seat);
  const tilt = ((card * 37) % 15) - 7;
  const key = `${t.code}:${o.handsPlayed}:${trick}:${player}:play`;
  return `<g class="play-in" style="--fx:${(sx - x).toFixed(1)}px;--fy:${(sy - y).toFixed(1)}px;animation-delay:${animDelay(key, 0)}">${cardSvg(card, x, y, L.card, { rotate: tilt, highlight })}</g>`;
}

/** The last trick's cards sliding over to the winner's pile. */
function trickToWinner(L: Layout, t: TableView, o: WireObservation, key: string, holdMs: number): string {
  const last = o.tricks[o.tricks.length - 1];
  const [wx, wy] = pilePos(L, t, last.winner);
  const trick = o.tricks.length - 1;
  return last.plays
    .map((p) => {
      const [x, y] = point(L, seatAngle(p.player, t.you, t.seats.length), L.seat, L.playRadius);
      // The card that completed the trick still slides in first (the others already have).
      return flying(playedCard(L, t, o, trick, p.player, p.card, p.player === last.winner), wx - x, wy - y, key, holdMs);
    })
    .join('');
}

function centre(L: Layout, t: TableView, o: WireObservation): string {
  const [cw, ch] = L.card;
  const parts: string[] = [];
  const n = t.seats.length;
  // Turn-up and trump in the middle.
  // The turn-up shows trump all hand, so it's a little bigger than a played card.
  const small: [number, number] = [cw * 1.2, ch * 1.2];
  parts.push(cardSvg(o.turnUp, L.cx, L.cy - 12, small, { faded: o.dealerTookTurnUp }));
  const trump = o.trump === null ? '' : SUIT_SYMBOLS[o.trump];
  const red = o.trump === 1 || o.trump === 2;
  parts.push(
    `<text x="${L.cx}" y="${L.cy + small[1] / 2 + 8}" text-anchor="middle" class="felt-label">${o.dealerTookTurnUp ? 'turn-up taken · ' : ''}trump <tspan class="${red ? 'trump-red' : 'trump-black'}">${trump}</tspan></text>`,
  );

  // Just after a trick: its cards stay a moment, then slide to the winner's pile.
  const last = o.tricks[o.tricks.length - 1];
  const showingLast = o.currentTrick.length === 0 && o.phase === 'play' && !!last;
  const lastKey = `${t.code}:${o.handsPlayed}:${o.tricks.length}`;
  // If the winner leads again quickly, let the previous trick finish its slide.
  const stillFlying = !showingLast && !!last && animAge(lastKey) < 550 + 520;
  parts.push(piles(L, t, o, showingLast || stillFlying ? last.winner : undefined));
  if (stillFlying) parts.push(trickToWinner(L, t, o, lastKey, 550));
  if (showingLast) {
    parts.push(trickToWinner(L, t, o, lastKey, 550));
    const who = last.winner === t.you ? 'You take' : `${esc(clip(t.seats[last.winner].name, 16))} takes`;
    parts.push(`<text x="${L.cx}" y="${L.cy + small[1] / 2 + 28}" text-anchor="middle" class="felt-label strong">${who} the trick</text>`);
  }
  for (const p of o.currentTrick) parts.push(playedCard(L, t, o, o.tricks.length, p.player, p.card));
  void n;
  return parts.join('');
}

/** Milliseconds from the end of a hand until the results appear (the overlay waits for this). */
export const HAND_END_MS = 2000;

/**
 * End of a hand: the last trick goes to its winner, then every trick pile and
 * the rest of the deck slide to the next dealer, who gathers the cards.
 */
function handEnd(L: Layout, t: TableView, o: WireObservation): string {
  const key = `${t.code}:${o.handsPlayed}:end`;
  const parts: string[] = [];
  const nextDealer = (o.dealer + 1) % t.seats.length;
  const [dx, dy] = pilePos(L, t, nextDealer);
  const last = o.tricks[o.tricks.length - 1];
  const gatherAt = last ? 950 : 200;
  // Piles (without the trick that's still flying) and the deck, gathered at gatherAt.
  o.tricksWon.forEach((won, p) => {
    const n = won - (last && last.winner === p ? 1 : 0);
    if (n <= 0) return;
    const [x, y] = pilePos(L, t, p);
    parts.push(flying(pileSvg(L, x, y, n, p), dx - x, dy - y, `${key}:pile${p}`, gatherAt, 'gather'));
  });
  if (last) {
    // The final trick lands on the winner's pile, then goes on with it.
    const [wx, wy] = pilePos(L, t, last.winner);
    parts.push(trickToWinner(L, t, o, `${key}:trick`, 250));
    // Hidden for the first 30% of its 1 s animation, so it appears as the trick lands.
    parts.push(flying(pileSvg(L, wx, wy, 1, last.winner), dx - wx, dy - wy, `${key}:last`, gatherAt - 300, 'gather appear'));
  }
  const deck = cardBackSvg(L.cx - 3, L.cy - 5, [L.card[0] * 0.8, L.card[1] * 0.8]) + cardBackSvg(L.cx, L.cy - 8, [L.card[0] * 0.8, L.card[1] * 0.8], 4);
  parts.push(flying(deck, dx - L.cx, dy - L.cy, `${key}:deck`, gatherAt + 150, 'gather'));
  const who = nextDealer === t.you ? 'You deal' : `${esc(clip(t.seats[nextDealer].name, 16))} deals`;
  parts.push(`<text x="${L.cx}" y="${L.cy + 70}" text-anchor="middle" class="felt-label strong">${who} next</text>`);
  return parts.join('');
}

export function tableSvg(t: TableView, L: Layout): string {
  const o = t.obs;
  const plates = t.seats.map((_, i) => seatPlate(L, t, o, i)).join('');
  const middle = !o
    ? ''
    : o.phase === 'handOver' || (o.phase === 'gameOver' && t.lastHand)
      ? handEnd(L, t, o)
      : t.status === 'playing'
        ? centre(L, t, o)
        : '';
  return `<svg class="table-svg" viewBox="0 0 ${L.w} ${L.h}" role="img" aria-label="Card table">
    ${defs()}${tableShape(L)}${middle}${plates}
  </svg>`;
}
