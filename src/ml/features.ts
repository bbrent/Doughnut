/**
 * The one shared encoding of what a player sees, used for training and in the
 * browser. Cards are encoded by role, not identity: suits are re-ordered so
 * slot 0 is always trump, slot 1 the led suit (if any), then the rest by how
 * many the player holds. "Highest remaining trump" therefore looks the same
 * whatever the actual suit is.
 *
 * Bump FEATURE_VERSION whenever the layout changes; saved models record it.
 */
import { playStrength, rankOf, rulesFor, type Card, type Move, type Observation, playedCards } from '../engine';
import { estimateTricks, viewFromObservation } from '../ai/heuristic';

export const FEATURE_VERSION = 1;

class Writer {
  i = 0;
  constructor(readonly out: Float32Array) {}
  push(...xs: number[]) {
    for (const x of xs) this.out[this.i++] = x;
  }
  oneHot(n: number, k: number) {
    if (k >= 0 && k < n) this.out[this.i + k] = 1;
    this.i += n;
  }
  cards(slotIndex: (c: Card) => number, cs: Iterable<Card>) {
    for (const c of cs) this.out[this.i + slotIndex(c)] = 1;
    this.i += 52;
  }
}

/** Per-decision context shared by the state and action encoders. */
export interface EncodeContext {
  obs: Observation;
  /** Canonical 0..51 index for a card. */
  slotIndex: (c: Card) => number;
  slotOfSuit: number[];
  outOfPlay: Set<Card>;
  ledSuit: number | null;
  bestStrength: number;
  opponents: number;
}

export function makeContext(o: Observation): EncodeContext {
  const rules = rulesFor(o.config);
  const eff = (c: Card) => rules.effectiveSuit(c, o.trump);
  const ledSuit = o.currentTrick.length ? eff(o.currentTrick[0].card) : null;

  const count = [0, 0, 0, 0];
  const top = [-1, -1, -1, -1];
  for (const c of o.hand) {
    count[eff(c)]++;
    top[eff(c)] = Math.max(top[eff(c)], rankOf(c));
  }
  const key = (s: number) => (s === o.trump ? 1e6 : 0) + (s === ledSuit ? 1e5 : 0) + count[s] * 100 + top[s] + s * 1e-3;
  const order = [0, 1, 2, 3].sort((a, b) => key(b) - key(a));
  const slotOfSuit = [0, 0, 0, 0];
  order.forEach((s, slot) => (slotOfSuit[s] = slot));

  const bestStrength =
    ledSuit === null ? -Infinity : Math.max(...o.currentTrick.map((p) => playStrength(rules, p.card, ledSuit, o.trump)));
  let opponents = 0;
  o.playing.forEach((pl, p) => {
    if (p !== o.player) opponents += pl === true ? 1 : pl === null ? 0.5 : 0;
  });

  return {
    obs: o,
    slotIndex: (c) => slotOfSuit[eff(c)] * 13 + rankOf(c),
    slotOfSuit,
    outOfPlay: new Set(playedCards(o)),
    ledSuit,
    bestStrength,
    opponents: Math.max(1, opponents),
  };
}

export const STATE_SIZE = 3 + 4 + 5 + 13 + 7 + 5 + 5 + 1 + 5 + 52 * 3 + 4 + 1;
export const ACTION_SIZE = 6 + 52 + 6;
export const INPUT_SIZE = STATE_SIZE + ACTION_SIZE;

const PHASES = ['exchange', 'declare', 'play'];

export function encodeState(ctx: EncodeContext): Float32Array {
  const o = ctx.obs;
  const { scoring, end, handSize } = o.config;
  const w = new Writer(new Float32Array(STATE_SIZE));
  const n = o.numPlayers;
  const me = o.player;
  const others = [...Array(n).keys()].filter((p) => p !== me);

  w.oneHot(3, PHASES.indexOf(o.phase));

  const active = o.playing.filter((x) => x === true).length;
  const undecided = o.playing.filter((x) => x === null).length;
  const folded = o.playing.filter((x) => x === false).length;
  w.push(n / 10, active / 10, undecided / 10, folded / 10);

  const turnUpWithDealer = o.dealerTookTurnUp && !ctx.outOfPlay.has(o.turnUp) && o.dealer !== me ? 1 : 0;
  w.push(o.dealer === me ? 1 : 0, ((me - o.dealer + n) % n) / n, o.forced ? 1 : 0, o.dealerTookTurnUp ? 1 : 0, turnUpWithDealer);
  w.oneHot(13, rankOf(o.turnUp));

  // Scoreboard.
  const opp = others.map((p) => o.startScores[p]);
  const fp = scoring.foldPenalty;
  w.push(
    o.scores[me] / 20,
    o.startScores[me] / 20,
    Math.min(...opp) / 20,
    opp.reduce((a, b) => a + b, 0) / opp.length / 20,
    opp.filter((x) => x < o.startScores[me]).length / opp.length,
    fp && o.startScores[me] <= fp.atOrBelow ? 1 : 0,
    o.startScores[me] <= Math.min(...opp) ? 1 : 0,
  );

  // Hand progress.
  const myTricks = o.tricksWon[me];
  const oppTricks = others.map((p) => o.tricksWon[p]);
  w.push(o.tricks.length / handSize, myTricks / handSize, Math.max(...oppTricks) / handSize, myTricks === 0 ? 1 : 0, (handSize - o.tricks.length) / handSize);

  // Current trick.
  const rules = rulesFor(o.config);
  const bestIsTrump = ctx.bestStrength >= 200 ? 1 : 0;
  const bestRank = ctx.bestStrength >= 0 ? (ctx.bestStrength % 100) / 12 : 0;
  const canWin = o.legalMoves.some((m) => m.kind === 'card' && ctx.ledSuit !== null && playStrength(rules, m.card, ctx.ledSuit, o.trump) > ctx.bestStrength);
  w.push(o.currentTrick.length / 10, Math.max(0, active - o.currentTrick.length - 1) / 10, bestIsTrump, bestRank, canWin ? 1 : 0);

  w.push(estimateTricks(viewFromObservation(o), o.hand, ctx.opponents) / handSize);

  // Mode knobs, so one model can cover a family of variants.
  w.push(
    scoring.noTrickPenalty / 5,
    scoring.perTrick,
    scoring.startScore / 20,
    end.maxHands ? (end.maxHands - o.handsPlayed) / end.maxHands : 1,
    end.targetScore !== null ? 1 : 0,
  );

  w.cards(ctx.slotIndex, o.hand);
  w.cards(ctx.slotIndex, ctx.outOfPlay);
  w.cards(ctx.slotIndex, o.currentTrick.map((p) => p.card));

  // Fraction of live opponents known void in each suit slot.
  const live = others.filter((p) => o.playing[p] !== false);
  const voidFrac = [0, 0, 0, 0];
  for (const p of live) for (let s = 0; s < 4; s++) if (o.voids[p][s]) voidFrac[ctx.slotOfSuit[s]] += 1 / live.length;
  w.push(...voidFrac);

  w.push(others.filter((p) => o.playing[p] === true && o.tricksWon[p] === 0).length / 10);

  if (w.i !== STATE_SIZE) throw new Error(`state size ${w.i} != ${STATE_SIZE}`);
  return w.out;
}

const KINDS = ['exchangeKeep', 'exchangeSwap', 'declarePlay', 'declareFold', 'pickup', 'card'];

export function encodeAction(ctx: EncodeContext, m: Move): Float32Array {
  const o = ctx.obs;
  const rules = rulesFor(o.config);
  const w = new Writer(new Float32Array(ACTION_SIZE));
  const kind =
    m.kind === 'exchange' ? (m.discard === null ? 0 : 1) : m.kind === 'declare' ? (m.play ? 2 : 3) : m.kind === 'pickup' ? 4 : 5;
  w.oneHot(6, kind);

  const card = m.kind === 'card' ? m.card : m.kind === 'pickup' || m.kind === 'exchange' ? m.discard : null;
  w.cards(ctx.slotIndex, card === null ? [] : [card]);

  if (card === null) {
    const est = m.kind === 'declare' && m.play ? estimateTricks(viewFromObservation(o), o.hand, ctx.opponents) : 0;
    w.push(0, 0, 0, 0, 0, est / o.config.handSize);
  } else {
    const s = rules.effectiveSuit(card, o.trump);
    const isTrump = s === o.trump ? 1 : 0;
    const winsNow = m.kind === 'card' && ctx.ledSuit !== null && playStrength(rules, card, ctx.ledSuit, o.trump) > ctx.bestStrength ? 1 : 0;
    // Boss: every higher card of this suit is already out or in our hand.
    let boss = 1;
    for (let r = rankOf(card) + 1; r < 13; r++) {
      const higher = o.hand.find((c) => rules.effectiveSuit(c, o.trump) === s && rankOf(c) === r);
      const hc = s * 13 + r; // assumes effectiveSuit === suit (true for 'standard')
      // An untaken turn-up is dead; one the dealer took is live.
      const dead = ctx.outOfPlay.has(hc) || (hc === o.turnUp && !o.dealerTookTurnUp);
      if (higher === undefined && !dead) boss = 0;
    }
    const suitCount = o.hand.filter((c) => rules.effectiveSuit(c, o.trump) === s).length;
    let after = 0;
    if (m.kind === 'pickup' || m.kind === 'exchange') {
      const five = [...o.hand, o.turnUp].filter((c) => c !== card);
      after = estimateTricks(viewFromObservation(o), five, ctx.opponents) / o.config.handSize;
    }
    w.push(isTrump, rankOf(card) / 12, winsNow, boss, suitCount / 5, after);
  }

  if (w.i !== ACTION_SIZE) throw new Error(`action size ${w.i} != ${ACTION_SIZE}`);
  return w.out;
}
