import { buildDeck, rankIndex, rankOf, suitOf, type Card, type Suit } from './cards';
import { validateConfig, type GameConfig } from './config';
import { mulberry32, shuffle } from './rng';
import { getRules, trickWinner, type Play, type RulePlugins } from './rules';

export type Phase = 'exchange' | 'declare' | 'play' | 'handOver' | 'gameOver';

export type Move =
  /** Forced hand: dealer swaps `discard` for the turn-up, or keeps their hand (null). */
  | { kind: 'exchange'; discard: Card | null }
  /** Non-dealer (or dealer when pickup isn't required) chooses to play or fold. */
  | { kind: 'declare'; play: boolean }
  /** Dealer plays: takes the turn-up and discards a card (may be the turn-up). */
  | { kind: 'pickup'; discard: Card }
  | { kind: 'card'; card: Card };

export interface Trick {
  leader: number;
  plays: Play[];
  winner: number;
}

export interface HandResult {
  deltas: number[];
  tricks: number[];
  played: boolean[];
}

export interface GameState {
  config: GameConfig;
  numPlayers: number;
  scores: number[];
  /** Scores at the start of the current hand (fold penalty uses these). */
  startScores: number[];
  handsPlayed: number;
  dealer: number;
  phase: Phase;
  toAct: number;
  hands: Card[][];
  turnUp: Card;
  trump: Suit | null;
  /** Everyone must play this hand (turn-up was a forced rank). */
  forced: boolean;
  /** Undealt cards (excluding turn-up). */
  stock: Card[];
  /** Whether the turn-up went into the dealer's hand (public). */
  dealerTookTurnUp: boolean;
  /** Dealer's hidden discard, if any. */
  discard: Card | null;
  /** null = not yet decided. */
  playing: (boolean | null)[];
  currentTrick: Play[];
  trickLeader: number;
  tricks: Trick[];
  tricksWon: number[];
  /** Public inference: voids[p][suit] = p failed to follow that suit this hand. */
  voids: boolean[][];
  lastHand: HandResult | null;
  winners: number[];
  /** Seed for the next deal, so games are reproducible. */
  seed: number;
}

const rulesCache = new WeakMap<GameConfig, RulePlugins>();
export function rulesFor(config: GameConfig): RulePlugins {
  let r = rulesCache.get(config);
  if (!r) rulesCache.set(config, (r = getRules(config)));
  return r;
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    scores: s.scores.slice(),
    startScores: s.startScores.slice(),
    hands: s.hands.map((h) => h.slice()),
    stock: s.stock.slice(),
    playing: s.playing.slice(),
    currentTrick: s.currentTrick.slice(),
    tricks: s.tricks.slice(),
    tricksWon: s.tricksWon.slice(),
    voids: s.voids.map((v) => v.slice()),
    winners: s.winners.slice(),
  };
}

export function newGame(config: GameConfig, numPlayers: number, seed: number, firstDealer = 0): GameState {
  validateConfig(config, numPlayers);
  const s: GameState = {
    config,
    numPlayers,
    scores: Array(numPlayers).fill(config.scoring.startScore),
    startScores: [],
    handsPlayed: 0,
    dealer: firstDealer,
    phase: 'handOver',
    toAct: -1,
    hands: [],
    turnUp: -1,
    trump: null,
    forced: false,
    stock: [],
    dealerTookTurnUp: false,
    discard: null,
    playing: [],
    currentTrick: [],
    trickLeader: -1,
    tricks: [],
    tricksWon: [],
    voids: [],
    lastHand: null,
    winners: [],
    seed: seed >>> 0,
  };
  return deal(s);
}

const left = (s: GameState, p: number) => (p + 1) % s.numPlayers;

/** Deal a fresh hand into `s` (mutates; callers pass a clone). */
function deal(s: GameState): GameState {
  const { config, numPlayers } = s;
  const rng = mulberry32(s.seed);
  const deck = shuffle(buildDeck(config.deck.suits, config.deck.ranks), rng);
  s.seed = Math.floor(rng() * 2 ** 32) >>> 0;

  s.hands = Array.from({ length: numPlayers }, () => []);
  let i = 0;
  for (let c = 0; c < config.handSize; c++) {
    for (let k = 1; k <= numPlayers; k++) s.hands[(s.dealer + k) % numPlayers].push(deck[i++]);
  }
  s.turnUp = deck[i++];
  s.stock = deck.slice(i);
  s.trump = suitOf(s.turnUp);
  s.startScores = s.scores.slice();
  s.dealerTookTurnUp = false;
  s.discard = null;
  s.currentTrick = [];
  s.tricks = [];
  s.tricksWon = Array(numPlayers).fill(0);
  s.voids = Array.from({ length: numPlayers }, () => [false, false, false, false]);
  s.forced =
    config.participation.mode === 'all' ||
    config.trump.forcedPlayRanks.some((r) => rankIndex(r) === rankOf(s.turnUp));

  if (s.forced) {
    s.playing = Array(numPlayers).fill(true);
    if (config.trump.dealerExchangeOnForced) {
      s.phase = 'exchange';
      s.toAct = s.dealer;
    } else {
      beginPlay(s);
    }
  } else {
    s.playing = Array(numPlayers).fill(null);
    s.phase = 'declare';
    s.toAct = left(s, s.dealer);
  }
  return s;
}

function beginPlay(s: GameState): void {
  const active = s.playing.filter(Boolean).length;
  if (active === 0) return finishHand(s);
  s.phase = 'play';
  let p = left(s, s.dealer);
  while (!s.playing[p]) p = left(s, p);
  s.trickLeader = p;
  s.toAct = p;
}

function nextActive(s: GameState, p: number): number {
  let q = left(s, p);
  while (!s.playing[q]) q = left(s, q);
  return q;
}

/** Cards `p` may legally play in the current trick. */
export function legalCards(s: GameState, p: number): Card[] {
  const hand = s.hands[p];
  if (s.currentTrick.length === 0 || !s.config.play.mustFollow) return hand.slice();
  const rules = rulesFor(s.config);
  const led = rules.effectiveSuit(s.currentTrick[0].card, s.trump);
  const follow = hand.filter((c) => rules.effectiveSuit(c, s.trump) === led);
  if (follow.length) return follow;
  if (s.config.play.mustTrumpIfVoid && s.trump !== null) {
    const trumps = hand.filter((c) => rules.effectiveSuit(c, s.trump) === s.trump);
    if (trumps.length) return trumps;
  }
  return hand.slice();
}

export function legalMoves(s: GameState): Move[] {
  switch (s.phase) {
    case 'exchange':
      return [{ kind: 'exchange', discard: null }, ...s.hands[s.dealer].map((c) => ({ kind: 'exchange' as const, discard: c }))];
    case 'declare':
      if (s.toAct === s.dealer && s.config.participation.dealerPlaysByPickup) {
        return [
          { kind: 'declare', play: false },
          ...[...s.hands[s.dealer], s.turnUp].map((c) => ({ kind: 'pickup' as const, discard: c })),
        ];
      }
      return [
        { kind: 'declare', play: true },
        { kind: 'declare', play: false },
      ];
    case 'play':
      return legalCards(s, s.toAct).map((card) => ({ kind: 'card', card }));
    default:
      return [];
  }
}

export function moveKey(m: Move): string {
  switch (m.kind) {
    case 'exchange':
      return `x${m.discard ?? '-'}`;
    case 'declare':
      return m.play ? 'd1' : 'd0';
    case 'pickup':
      return `p${m.discard}`;
    case 'card':
      return `c${m.card}`;
  }
}

function removeCard(hand: Card[], c: Card): void {
  const i = hand.indexOf(c);
  if (i < 0) throw new Error(`Card ${c} not in hand`);
  hand.splice(i, 1);
}

/** Apply a move, returning a new state. Throws on illegal moves. */
export function applyMove(state: GameState, move: Move): GameState {
  if (!legalMoves(state).some((m) => moveKey(m) === moveKey(move))) {
    throw new Error(`Illegal move ${moveKey(move)} in phase ${state.phase}`);
  }
  const s = cloneState(state);
  applyUnchecked(s, move);
  return s;
}

/** Mutating apply without legality checks — for fast search on cloned states. */
export function applyUnchecked(s: GameState, move: Move): void {
  const p = s.toAct;
  switch (move.kind) {
    case 'exchange': {
      if (move.discard !== null) {
        removeCard(s.hands[p], move.discard);
        s.hands[p].push(s.turnUp);
        s.discard = move.discard;
        s.dealerTookTurnUp = true;
      }
      return beginPlay(s);
    }
    case 'declare': {
      s.playing[p] = move.play;
      if (p === s.dealer) return beginPlay(s);
      s.toAct = left(s, p);
      return;
    }
    case 'pickup': {
      s.playing[p] = true;
      s.hands[p].push(s.turnUp);
      removeCard(s.hands[p], move.discard);
      s.discard = move.discard;
      s.dealerTookTurnUp = true;
      return beginPlay(s);
    }
    case 'card': {
      const rules = rulesFor(s.config);
      if (s.currentTrick.length > 0) {
        const led = rules.effectiveSuit(s.currentTrick[0].card, s.trump);
        if (rules.effectiveSuit(move.card, s.trump) !== led) s.voids[p][led] = true;
      }
      removeCard(s.hands[p], move.card);
      s.currentTrick.push({ player: p, card: move.card });
      const active = s.playing.filter(Boolean).length;
      if (s.currentTrick.length < active) {
        s.toAct = nextActive(s, p);
        return;
      }
      const winner = trickWinner(rules, s.currentTrick, s.trump);
      s.tricks.push({ leader: s.trickLeader, plays: s.currentTrick, winner });
      s.tricksWon[winner]++;
      s.currentTrick = [];
      if (s.tricks.length === s.config.handSize) return finishHand(s);
      s.trickLeader = winner;
      s.toAct = winner;
      return;
    }
  }
}

function finishHand(s: GameState): void {
  const { scoring, end } = s.config;
  const played = s.playing.map(Boolean);
  const deltas = played.map((pl, p) => {
    if (pl) return s.tricksWon[p] > 0 ? scoring.perTrick * s.tricksWon[p] : scoring.noTrickPenalty;
    const fp = scoring.foldPenalty;
    return fp && s.startScores[p] <= fp.atOrBelow ? fp.points : 0;
  });
  for (let p = 0; p < s.numPlayers; p++) s.scores[p] += deltas[p];
  s.handsPlayed++;
  s.lastHand = { deltas, tricks: s.tricksWon.slice(), played };
  s.toAct = -1;

  const hitTarget = end.targetScore !== null && s.scores.some((x) => x <= end.targetScore!);
  const outOfHands = end.maxHands !== null && s.handsPlayed >= end.maxHands;
  if (hitTarget || outOfHands) {
    const best = Math.min(...s.scores);
    s.winners = s.scores.flatMap((x, p) => (x === best ? [p] : []));
    s.phase = 'gameOver';
  } else {
    s.phase = 'handOver';
  }
}

export function startNextHand(state: GameState): GameState {
  if (state.phase !== 'handOver') throw new Error(`Can't deal in phase ${state.phase}`);
  const s = cloneState(state);
  s.dealer = left(s, s.dealer);
  return deal(s);
}

export const isHandDone = (s: GameState) => s.phase === 'handOver' || s.phase === 'gameOver';
