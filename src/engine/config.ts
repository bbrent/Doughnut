import type { RankName, SuitName } from './cards';

/**
 * Declarative description of a game mode. Anything that can't be expressed
 * as data is referenced by name from the rule-plugin registry (rules.ts).
 */
export interface GameConfig {
  id: string;
  name: string;
  deck: { suits: SuitName[]; ranks: RankName[] };
  players: { min: number; max: number };
  handSize: number;
  trump: {
    /** How trump is chosen. Only 'turnUp' so far. */
    source: 'turnUp';
    /** Turn-up ranks that force everyone to play the hand. */
    forcedPlayRanks: RankName[];
    /** On a forced hand, dealer may swap a card for the turn-up. */
    dealerExchangeOnForced: boolean;
  };
  participation: {
    /** 'declare': each player plays or folds; 'all': everyone always plays. */
    mode: 'declare' | 'all';
    /** Dealer plays by picking up the turn-up (and discarding one). */
    dealerPlaysByPickup: boolean;
  };
  play: {
    mustFollow: boolean;
    /** If void in the led suit, must play trump when able. */
    mustTrumpIfVoid: boolean;
    lead: 'leftOfDealer';
  };
  rules: { effectiveSuit: string; trickRank: string };
  scoring: {
    startScore: number;
    /** Score change per trick taken (negative = good in a race to zero). */
    perTrick: number;
    /** Score change for playing a hand and taking no tricks (the doughnut). */
    noTrickPenalty: number;
    /** Penalty for folding while at or below a score threshold. */
    foldPenalty: { atOrBelow: number; points: number } | null;
  };
  end: {
    /** Game ends once any score is at or below this. null = disabled. */
    targetScore: number | null;
    /** Game ends after this many hands. null = disabled. */
    maxHands: number | null;
  };
}

export function validateConfig(c: GameConfig, numPlayers: number): void {
  if (numPlayers < c.players.min || numPlayers > c.players.max) {
    throw new Error(`${c.name} needs ${c.players.min}-${c.players.max} players, got ${numPlayers}`);
  }
  const deckSize = c.deck.suits.length * c.deck.ranks.length;
  if (numPlayers * c.handSize + 1 > deckSize) {
    throw new Error(`Deck of ${deckSize} too small for ${numPlayers} x ${c.handSize} + turn-up`);
  }
  if (c.end.targetScore === null && c.end.maxHands === null) {
    throw new Error('Config needs an end condition');
  }
}
