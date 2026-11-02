import type { GameConfig } from './config';

const FULL_DECK: GameConfig['deck'] = {
  suits: ['C', 'D', 'H', 'S'],
  ranks: ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'],
};

export const DOUGHNUT: GameConfig = {
  id: 'doughnut',
  name: 'Doughnut',
  deck: FULL_DECK,
  players: { min: 2, max: 10 },
  handSize: 5,
  trump: { source: 'turnUp', forcedPlayRanks: ['10', 'A'], dealerExchangeOnForced: true },
  participation: { mode: 'declare', dealerPlaysByPickup: true },
  play: { mustFollow: true, mustTrumpIfVoid: false, lead: 'leftOfDealer' },
  rules: { effectiveSuit: 'standard', trickRank: 'standard' },
  scoring: {
    startScore: 20,
    perTrick: -1,
    noTrickPenalty: 5,
    foldPenalty: { atOrBelow: 5, points: 1 },
  },
  // maxHands is a safety cap: with many players folding is often free, and
  // games can otherwise stall indefinitely. Lowest score wins at the cap.
  end: { targetScore: 0, maxHands: 100 },
};

/** Variant: lowest score after 20 hands wins. */
export const DOUGHNUT_20_HANDS: GameConfig = {
  ...DOUGHNUT,
  id: 'doughnut-20',
  name: 'Doughnut (20 hands)',
  end: { targetScore: null, maxHands: 20 },
};

export const MODES: Record<string, GameConfig> = {
  [DOUGHNUT.id]: DOUGHNUT,
  [DOUGHNUT_20_HANDS.id]: DOUGHNUT_20_HANDS,
};
