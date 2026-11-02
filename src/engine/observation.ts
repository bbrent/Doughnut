import { buildDeck, type Card, type Suit } from './cards';
import type { GameConfig } from './config';
import { legalMoves, rulesFor, type GameState, type Move, type Phase, type Trick } from './game';
import type { Play } from './rules';
import { randInt, shuffle, type Rng } from './rng';

/** Everything one player can legitimately know. Agents only ever see this. */
export interface Observation {
  config: GameConfig;
  numPlayers: number;
  player: number;
  scores: number[];
  startScores: number[];
  handsPlayed: number;
  dealer: number;
  phase: Phase;
  toAct: number;
  hand: Card[];
  handSizes: number[];
  turnUp: Card;
  trump: Suit | null;
  forced: boolean;
  dealerTookTurnUp: boolean;
  /** Own hidden discard (only if this player is the dealer). */
  ownDiscard: Card | null;
  playing: (boolean | null)[];
  currentTrick: Play[];
  trickLeader: number;
  tricks: Trick[];
  tricksWon: number[];
  voids: boolean[][];
  legalMoves: Move[];
}

export function observe(s: GameState, player: number): Observation {
  return {
    config: s.config,
    numPlayers: s.numPlayers,
    player,
    scores: s.scores.slice(),
    startScores: s.startScores.slice(),
    handsPlayed: s.handsPlayed,
    dealer: s.dealer,
    phase: s.phase,
    toAct: s.toAct,
    hand: s.hands[player].slice(),
    handSizes: s.hands.map((h) => h.length),
    turnUp: s.turnUp,
    trump: s.trump,
    forced: s.forced,
    dealerTookTurnUp: s.dealerTookTurnUp,
    ownDiscard: player === s.dealer ? s.discard : null,
    playing: s.playing.slice(),
    currentTrick: s.currentTrick.slice(),
    trickLeader: s.trickLeader,
    tricks: s.tricks.slice(),
    tricksWon: s.tricksWon.slice(),
    voids: s.voids.map((v) => v.slice()),
    legalMoves: s.toAct === player ? legalMoves(s) : [],
  };
}

/** Cards the observer has seen leave play or knows the location of. */
export function playedCards(o: Observation): Card[] {
  return [...o.tricks.flatMap((t) => t.plays.map((p) => p.card)), ...o.currentTrick.map((p) => p.card)];
}

/**
 * Sample a full game state consistent with an observation: hidden cards are
 * dealt randomly to the other players, respecting known voids and the dealer
 * holding the turn-up when they took it.
 */
export function determinize(o: Observation, rng: Rng, maxAttempts = 50): GameState {
  const rules = rulesFor(o.config);
  const played = new Set(playedCards(o));
  const turnUpWithDealer = o.dealerTookTurnUp && o.dealer !== o.player && !played.has(o.turnUp);

  const known = new Set<Card>([...o.hand, ...played, o.turnUp]);
  if (o.ownDiscard !== null) known.add(o.ownDiscard);
  const pool = buildDeck(o.config.deck.suits, o.config.deck.ranks).filter((c) => !known.has(c));

  const need = o.handSizes.map((n, p) => (p === o.player ? 0 : n - (p === o.dealer && turnUpWithDealer ? 1 : 0)));
  const others = need.flatMap((n, p) => (p !== o.player && n > 0 ? [p] : []));
  const allowed = (p: number, c: Card) => !o.voids[p][rules.effectiveSuit(c, o.trump)];

  let hands: Card[][] | null = null;
  let rest: Card[] = [];
  for (let attempt = 0; attempt <= maxAttempts && !hands; attempt++) {
    const ignoreVoids = attempt === maxAttempts;
    const remaining = shuffle(pool.slice(), rng);
    const h: Card[][] = Array.from({ length: o.numPlayers }, () => []);
    // Most constrained players first.
    const order = others
      .map((p) => ({ p, k: ignoreVoids ? 0 : remaining.filter((c) => allowed(p, c)).length - need[p] }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.p);
    let ok = true;
    for (const p of order) {
      for (let i = 0; i < need[p]; i++) {
        const idx = ignoreVoids ? 0 : remaining.findIndex((c) => allowed(p, c));
        if (idx < 0) {
          ok = false;
          break;
        }
        h[p].push(remaining.splice(idx, 1)[0]);
      }
      if (!ok) break;
    }
    if (ok) {
      hands = h;
      rest = remaining;
    }
  }
  if (!hands) throw new Error('determinize failed');

  hands[o.player] = o.hand.slice();
  if (turnUpWithDealer) hands[o.dealer].push(o.turnUp);

  let discard = o.ownDiscard;
  if (o.dealerTookTurnUp && o.dealer !== o.player) {
    discard = rest.splice(randInt(rng, rest.length), 1)[0] ?? null;
  }
  return {
    config: o.config,
    numPlayers: o.numPlayers,
    scores: o.scores.slice(),
    startScores: o.startScores.slice(),
    handsPlayed: o.handsPlayed,
    dealer: o.dealer,
    phase: o.phase,
    toAct: o.toAct,
    hands,
    turnUp: o.turnUp,
    trump: o.trump,
    forced: o.forced,
    stock: rest,
    dealerTookTurnUp: o.dealerTookTurnUp,
    discard,
    playing: o.playing.slice(),
    currentTrick: o.currentTrick.slice(),
    trickLeader: o.trickLeader,
    tricks: o.tricks.slice(),
    tricksWon: o.tricksWon.slice(),
    voids: o.voids.map((v) => v.slice()),
    lastHand: null,
    winners: [],
    seed: Math.floor(rng() * 2 ** 32) >>> 0,
  };
}
