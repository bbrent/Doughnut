import { rankOf, suitOf, type Card, type Suit } from './cards';
import type { GameConfig } from './config';

/**
 * Rule plugins: the hooks every card question goes through, so oddities like
 * Euchre's bowers live here rather than in the engine.
 */
export interface RulePlugins {
  /** Suit a card counts as, given trump (e.g. left bower => trump). */
  effectiveSuit(card: Card, trump: Suit | null): Suit;
  /** Strength of a card within its effective suit (higher wins). */
  trickRank(card: Card, trump: Suit | null): number;
}

const standard: RulePlugins = {
  effectiveSuit: (card) => suitOf(card),
  trickRank: (card) => rankOf(card),
};

const EFFECTIVE_SUIT: Record<string, RulePlugins['effectiveSuit']> = { standard: standard.effectiveSuit };
const TRICK_RANK: Record<string, RulePlugins['trickRank']> = { standard: standard.trickRank };

export function getRules(config: GameConfig): RulePlugins {
  const effectiveSuit = EFFECTIVE_SUIT[config.rules.effectiveSuit];
  const trickRank = TRICK_RANK[config.rules.trickRank];
  if (!effectiveSuit || !trickRank) throw new Error(`Unknown rule plugin in ${config.id}`);
  return { effectiveSuit, trickRank };
}

export interface Play {
  player: number;
  card: Card;
}

/** Comparable strength of a card in a trick: trump > led suit > anything else. */
export function playStrength(rules: RulePlugins, card: Card, led: Suit, trump: Suit | null): number {
  const s = rules.effectiveSuit(card, trump);
  const r = rules.trickRank(card, trump);
  if (trump !== null && s === trump) return 200 + r;
  if (s === led) return 100 + r;
  return -1;
}

export function trickWinner(rules: RulePlugins, plays: readonly Play[], trump: Suit | null): number {
  const led = rules.effectiveSuit(plays[0].card, trump);
  let best = plays[0];
  let bestStrength = playStrength(rules, best.card, led, trump);
  for (let i = 1; i < plays.length; i++) {
    const st = playStrength(rules, plays[i].card, led, trump);
    if (st > bestStrength) {
      best = plays[i];
      bestStrength = st;
    }
  }
  return best.player;
}
