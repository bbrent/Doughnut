/** Cards are ints: suit * 13 + rank, rank 0 = '2' ... 12 = 'A'. */
export type Card = number;
export type Suit = number;

export const SUITS = ['C', 'D', 'H', 'S'] as const;
export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'] as const;
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export type RankName = (typeof RANKS)[number];
export type SuitName = (typeof SUITS)[number];

export const suitOf = (c: Card): Suit => Math.floor(c / 13);
export const rankOf = (c: Card): number => c % 13;
export const makeCard = (suit: Suit, rank: number): Card => suit * 13 + rank;
export const rankIndex = (r: RankName): number => RANKS.indexOf(r);
export const suitIndex = (s: SuitName): number => SUITS.indexOf(s);

export function cardToString(c: Card, pretty = false): string {
  return RANKS[rankOf(c)] + (pretty ? SUIT_SYMBOLS : SUITS)[suitOf(c)];
}

export function parseCard(s: string): Card {
  const m = /^(10|[2-9JQKA])([CDHS])$/i.exec(s.trim());
  if (!m) throw new Error(`Bad card: ${s}`);
  return makeCard(suitIndex(m[2].toUpperCase() as SuitName), rankIndex(m[1].toUpperCase() as RankName));
}

export function buildDeck(suits: readonly SuitName[], ranks: readonly RankName[]): Card[] {
  const deck: Card[] = [];
  for (const s of suits) for (const r of ranks) deck.push(makeCard(suitIndex(s), rankIndex(r)));
  return deck;
}
