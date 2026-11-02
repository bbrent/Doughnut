import {
  legalMoves,
  playStrength,
  rankOf,
  rulesFor,
  type Card,
  type GameConfig,
  type GameState,
  type Move,
  type Observation,
  type Phase,
  type Play,
  type Suit,
} from '../engine';
import type { Agent } from './agent';

/** The minimal view the heuristic needs; built from an Observation or a full state. */
export interface PolicyView {
  config: GameConfig;
  phase: Phase;
  player: number;
  dealer: number;
  numPlayers: number;
  hand: Card[];
  trump: Suit | null;
  turnUp: Card;
  playing: (boolean | null)[];
  startScores: number[];
  currentTrick: Play[];
  legal: Move[];
}

export const viewFromObservation = (o: Observation): PolicyView => ({ ...o, legal: o.legalMoves });

export const viewFromState = (s: GameState): PolicyView => ({
  config: s.config,
  phase: s.phase,
  player: s.toAct,
  dealer: s.dealer,
  numPlayers: s.numPlayers,
  hand: s.hands[s.toAct],
  trump: s.trump,
  turnUp: s.turnUp,
  playing: s.playing,
  startScores: s.startScores,
  currentTrick: s.currentTrick,
  legal: legalMoves(s),
});

// Rough chance a card wins a trick, indexed by rank (0 = '2' .. 12 = 'A').
const TRUMP_VALUE = [0.2, 0.2, 0.2, 0.2, 0.22, 0.25, 0.28, 0.32, 0.4, 0.5, 0.65, 0.8, 0.97];

export interface HeuristicParams {
  /** Expected tricks needed to play a hand. */
  playThreshold: number;
  /** Lower threshold when folding would cost a penalty. */
  playThresholdWhenFoldCosts: number;
}

export const DEFAULT_HEURISTIC: HeuristicParams = { playThreshold: 0.85, playThresholdWhenFoldCosts: 0.55 };

function cardValue(v: PolicyView, c: Card, hand: Card[], opponents: number): number {
  const rules = rulesFor(v.config);
  const s = rules.effectiveSuit(c, v.trump);
  const r = rankOf(c);
  if (s === v.trump) return r === 12 ? TRUMP_VALUE[r] : TRUMP_VALUE[r] * Math.max(0.5, 1 - 0.04 * opponents);
  const suitCount = hand.filter((x) => rules.effectiveSuit(x, v.trump) === s).length;
  if (r === 12) return Math.max(0.15, 0.8 - 0.08 * opponents);
  if (r === 11 && suitCount >= 2) return Math.max(0.05, 0.4 - 0.07 * opponents);
  return 0;
}

export function estimateTricks(v: PolicyView, hand: Card[], opponents: number): number {
  return hand.reduce((e, c) => e + cardValue(v, c, hand, opponents), 0);
}

function expectedOpponents(v: PolicyView): number {
  let n = 0;
  for (let p = 0; p < v.numPlayers; p++) {
    if (p === v.player) continue;
    const pl = v.playing[p];
    n += pl === true ? 1 : pl === null ? 0.5 : 0;
  }
  return Math.max(1, n);
}

/** Card to throw away: lowest value, then lowest rank, preferring short suits. */
function worstCard(v: PolicyView, cards: Card[], opponents: number): Card {
  const rules = rulesFor(v.config);
  const score = (c: Card) => {
    const s = rules.effectiveSuit(c, v.trump);
    const shortSuit = cards.filter((x) => rules.effectiveSuit(x, v.trump) === s).length === 1 ? -0.01 : 0;
    return cardValue(v, c, cards, opponents) + rankOf(c) * 0.001 + shortSuit;
  };
  return cards.reduce((a, b) => (score(b) < score(a) ? b : a));
}

function threshold(v: PolicyView, p: HeuristicParams): number {
  const fp = v.config.scoring.foldPenalty;
  return fp && v.startScores[v.player] <= fp.atOrBelow ? p.playThresholdWhenFoldCosts : p.playThreshold;
}

function chooseCard(v: PolicyView): Move {
  const rules = rulesFor(v.config);
  const cards = v.legal.flatMap((m) => (m.kind === 'card' ? [m.card] : []));
  const isTrump = (c: Card) => rules.effectiveSuit(c, v.trump) === v.trump;
  const lowest = (cs: Card[]) =>
    cs.reduce((a, b) => {
      const ka = (isTrump(a) ? 100 : 0) + rankOf(a);
      const kb = (isTrump(b) ? 100 : 0) + rankOf(b);
      return kb < ka ? b : a;
    });
  const highest = (cs: Card[]) => cs.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));
  const card = (c: Card): Move => ({ kind: 'card', card: c });

  if (v.currentTrick.length === 0) {
    const trumps = cards.filter(isTrump);
    const offAces = cards.filter((c) => !isTrump(c) && rankOf(c) === 12);
    if (offAces.length) return card(offAces[0]);
    if (trumps.length >= 2 && rankOf(highest(trumps)) >= 10) return card(highest(trumps));
    if (trumps.length === cards.length) return card(highest(trumps));
    return card(lowest(cards.filter((c) => !isTrump(c))));
  }

  const led = rules.effectiveSuit(v.currentTrick[0].card, v.trump);
  const strength = (c: Card) => playStrength(rules, c, led, v.trump);
  const best = Math.max(...v.currentTrick.map((p) => strength(p.card)));
  const winners = cards.filter((c) => strength(c) > best);
  if (!winners.length) return card(lowest(cards));

  const active = v.playing.filter(Boolean).length;
  const last = v.currentTrick.length === active - 1;
  const byStrength = winners.slice().sort((a, b) => strength(a) - strength(b));
  if (last) return card(byStrength[0]);
  // Not last: play the strongest card in the led suit, or the cheapest winning trump.
  const ledWinners = byStrength.filter((c) => !isTrump(c));
  return card(ledWinners.length ? ledWinners[ledWinners.length - 1] : byStrength[0]);
}

export function heuristicMove(v: PolicyView, params: HeuristicParams = DEFAULT_HEURISTIC): Move {
  const opp = expectedOpponents(v);
  switch (v.phase) {
    case 'exchange': {
      const worst = worstCard(v, v.hand, opp);
      return cardValue(v, worst, v.hand, opp) < cardValue(v, v.turnUp, v.hand, opp)
        ? { kind: 'exchange', discard: worst }
        : { kind: 'exchange', discard: null };
    }
    case 'declare': {
      const canPickup = v.legal.some((m) => m.kind === 'pickup');
      if (canPickup) {
        const six = [...v.hand, v.turnUp];
        const discard = worstCard(v, six, opp);
        const five = six.filter((c) => c !== discard);
        return estimateTricks(v, five, opp) >= threshold(v, params)
          ? { kind: 'pickup', discard }
          : { kind: 'declare', play: false };
      }
      return { kind: 'declare', play: estimateTricks(v, v.hand, opp) >= threshold(v, params) };
    }
    case 'play':
      return chooseCard(v);
    default:
      throw new Error(`No move in phase ${v.phase}`);
  }
}

export const heuristicAgent = (params: HeuristicParams = DEFAULT_HEURISTIC): Agent => ({
  name: 'heuristic',
  chooseMove: (obs) => heuristicMove(viewFromObservation(obs), params),
});
