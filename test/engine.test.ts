import { describe, expect, it } from 'vitest';
import {
  DOUGHNUT,
  DOUGHNUT_20_HANDS,
  applyMove,
  cardToString,
  cloneState,
  determinize,
  legalMoves,
  mulberry32,
  newGame,
  observe,
  parseCard,
  pick,
  rankOf,
  startNextHand,
  suitOf,
  type GameConfig,
  type GameState,
} from '../src/engine';

const cards = (s: string) => s.split(' ').map(parseCard);

/** Find a seed whose turn-up satisfies `pred`. */
function gameWhere(pred: (s: GameState) => boolean, n = 4, config: GameConfig = DOUGHNUT): GameState {
  for (let seed = 1; seed < 10000; seed++) {
    const s = newGame(config, n, seed);
    if (pred(s)) return s;
  }
  throw new Error('no seed');
}
const forced = (s: GameState) => [8, 12].includes(rankOf(s.turnUp)); // 10 or A

/** Set up a 'play' phase with given hands; everyone playing, dealer 3, trump from turnUp. */
function playState(hands: string[], turnUp: string, playing = [true, true, true, true]): GameState {
  const s = cloneState(gameWhere(forced));
  s.hands = hands.map(cards);
  s.turnUp = parseCard(turnUp);
  s.trump = suitOf(s.turnUp);
  s.dealer = 3;
  s.playing = playing;
  s.phase = 'play';
  s.trickLeader = s.toAct = playing.indexOf(true);
  s.startScores = s.scores.slice();
  return s;
}

describe('deal', () => {
  it('deals 5 cards each plus a turn-up, no duplicates', () => {
    for (const n of [2, 4, 10]) {
      const s = newGame(DOUGHNUT, n, 7);
      expect(s.hands.every((h) => h.length === 5)).toBe(true);
      const all = [...s.hands.flat(), s.turnUp, ...s.stock];
      expect(all.length).toBe(52);
      expect(new Set(all).size).toBe(52);
      expect(s.trump).toBe(suitOf(s.turnUp));
    }
  });

  it('rejects bad player counts', () => {
    expect(() => newGame(DOUGHNUT, 1, 1)).toThrow();
    expect(() => newGame(DOUGHNUT, 11, 1)).toThrow();
  });
});

describe('participation', () => {
  it('10 or Ace turn-up: everyone plays, dealer may exchange', () => {
    const s = gameWhere(forced);
    expect(s.phase).toBe('exchange');
    expect(s.toAct).toBe(s.dealer);
    expect(s.playing.every(Boolean)).toBe(true);
    const swap = applyMove(s, { kind: 'exchange', discard: s.hands[s.dealer][0] });
    expect(swap.hands[s.dealer]).toContain(s.turnUp);
    expect(swap.hands[s.dealer]).toHaveLength(5);
    expect(swap.phase).toBe('play');
    expect(swap.toAct).toBe((s.dealer + 1) % 4);
  });

  it('other turn-ups: declare clockwise from dealer left, dealer last must pick up to play', () => {
    const s0 = gameWhere((s) => !forced(s));
    expect(s0.phase).toBe('declare');
    let s = s0;
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      order.push(s.toAct);
      expect(legalMoves(s)).toEqual([
        { kind: 'declare', play: true },
        { kind: 'declare', play: false },
      ]);
      s = applyMove(s, { kind: 'declare', play: i !== 1 });
    }
    expect(order).toEqual([1, 2, 3].map((k) => (s0.dealer + k) % 4));
    expect(s.toAct).toBe(s0.dealer);
    const moves = legalMoves(s);
    expect(moves.some((m) => m.kind === 'declare' && m.play)).toBe(false);
    expect(moves.filter((m) => m.kind === 'pickup')).toHaveLength(6);
    s = applyMove(s, { kind: 'pickup', discard: s.hands[s.dealer][0] });
    expect(s.hands[s.dealer]).toContain(s0.turnUp);
    expect(s.phase).toBe('play');
    expect(s.toAct).toBe(order[0]); // dealer's left leads
  });

  it('lead skips folded players', () => {
    let s = gameWhere((s) => !forced(s));
    s = applyMove(s, { kind: 'declare', play: false });
    s = applyMove(s, { kind: 'declare', play: true });
    s = applyMove(s, { kind: 'declare', play: true });
    s = applyMove(s, { kind: 'declare', play: false });
    expect(s.toAct).toBe((s.dealer + 2) % 4);
  });

  it('everyone folds: hand ends immediately', () => {
    let s = gameWhere((s) => !forced(s));
    for (let i = 0; i < 4; i++) s = applyMove(s, { kind: 'declare', play: false });
    expect(s.phase).toBe('handOver');
    expect(s.lastHand!.deltas).toEqual([0, 0, 0, 0]);
  });
});

describe('trick play', () => {
  it('must follow suit; void players may play anything', () => {
    const s = playState(['AH 2C 3C 4C 5C', '3H 9S 8S 7S 6S', 'KD QD JD 10D 9D', '2S 3S 4S 5S 6D'], '2D');
    const s1 = applyMove(s, { kind: 'card', card: parseCard('AH') });
    expect(legalMoves(s1).map((m) => (m.kind === 'card' ? cardToString(m.card) : ''))).toEqual(['3H']);
    const s2 = applyMove(s1, { kind: 'card', card: parseCard('3H') });
    expect(legalMoves(s2)).toHaveLength(5); // void in hearts
    expect(() => applyMove(s1, { kind: 'card', card: parseCard('9S') })).toThrow();
  });

  it('highest of led suit wins; any trump beats it; highest trump wins', () => {
    let s = playState(['KH 2C 3C 4C 5C', 'AH 9S 8S 7S 6S', '2D QD JD 10D 9D', '3D 3S 4S 5S 6C'], '4D');
    s = applyMove(s, { kind: 'card', card: parseCard('KH') });
    s = applyMove(s, { kind: 'card', card: parseCard('AH') });
    s = applyMove(s, { kind: 'card', card: parseCard('2D') });
    s = applyMove(s, { kind: 'card', card: parseCard('3D') });
    expect(s.tricks[0].winner).toBe(3);
    expect(s.toAct).toBe(3); // winner leads

    let t = playState(['KH 2C 3C 4C 5C', 'AH 9S 8S 7S 6S', '2C QD JD 10D 9D', '3S 4S 5S 6S 6C'], '4D');
    for (const c of ['KH', 'AH', '2C', '3S']) t = applyMove(t, { kind: 'card', card: parseCard(c) });
    expect(t.tricks[0].winner).toBe(1);
  });

  it('records voids when a player fails to follow', () => {
    let s = playState(['AH 2C 3C 4C 5C', '9S 8S 7S 6S 5S', 'KD QD JD 10D 9D', '2S 3S 4S 5H 6D'], '2D');
    s = applyMove(s, { kind: 'card', card: parseCard('AH') });
    s = applyMove(s, { kind: 'card', card: parseCard('9S') });
    expect(s.voids[1][suitOf(parseCard('AH'))]).toBe(true);
    expect(s.voids[2].some(Boolean)).toBe(false);
  });
});

describe('scoring', () => {
  /** Play a hand to completion by always playing the first legal card. */
  function finish(s: GameState): GameState {
    while (s.phase === 'play') s = applyMove(s, legalMoves(s)[0]);
    return s;
  }

  it('-1 per trick, +5 for a doughnut', () => {
    const s = finish(playState(['AH AC AS KH KC', '2H 2C 2S 3H 3C', '4H 4C 4S 5H 5C', '6H 6C 6S 7H 7C'], '2D'));
    expect(s.lastHand!.tricks).toEqual([5, 0, 0, 0]);
    expect(s.lastHand!.deltas).toEqual([-5, 5, 5, 5]);
    expect(s.scores).toEqual([15, 25, 25, 25]);
  });

  it('folding at 5 or less costs 1 (chicken penalty); above 5 is free', () => {
    const base = playState(['AH AC AS KH KC', '2H 2C 2S 3H 3C', '4H 4C 4S 5H 5C', '6H 6C 6S 7H 7C'], '2D', [
      true,
      true,
      false,
      false,
    ]);
    base.startScores = base.scores = [20, 20, 5, 6];
    const s = finish(base);
    expect(s.lastHand!.deltas).toEqual([-5, 5, 1, 0]);
  });

  it('game ends when someone reaches zero; lowest score wins', () => {
    const base = playState(['AH AC AS KH KC', '2H 2C 2S 3H 3C', '4H 4C 4S 5H 5C', '6H 6C 6S 7H 7C'], '2D');
    base.scores = [4, 10, 10, 10];
    const s = finish(base);
    expect(s.phase).toBe('gameOver');
    expect(s.scores[0]).toBe(-1);
    expect(s.winners).toEqual([0]);
  });

  it('20-hand variant ends after 20 hands', () => {
    const rng = mulberry32(3);
    let s = newGame(DOUGHNUT_20_HANDS, 5, 3);
    for (;;) {
      while (s.phase !== 'handOver' && s.phase !== 'gameOver') s = applyMove(s, pick(legalMoves(s), rng));
      if (s.phase === 'gameOver') break;
      s = startNextHand(s);
    }
    expect(s.handsPlayed).toBe(20);
    expect(s.winners.every((w) => s.scores[w] === Math.min(...s.scores))).toBe(true);
  });
});

describe('random games', () => {
  it('play to completion with consistent card counts, 2-10 players', () => {
    const rng = mulberry32(42);
    for (let n = 2; n <= 10; n++) {
      for (let g = 0; g < 5; g++) {
        let s = newGame(DOUGHNUT_20_HANDS, n, n * 100 + g);
        let hands = 0;
        while (s.phase !== 'gameOver') {
          while (s.phase !== 'handOver' && s.phase !== 'gameOver') s = applyMove(s, pick(legalMoves(s), rng));
          const total = s.lastHand!.played.filter(Boolean).length ? s.tricks.length : 0;
          expect([0, 5]).toContain(total);
          hands++;
          if (s.phase === 'handOver') s = startNextHand(s);
        }
        expect(hands).toBe(20);
      }
    }
  });
});

describe('determinize', () => {
  it('keeps own hand and public info, respects voids, never duplicates cards', () => {
    const rng = mulberry32(9);
    for (let seed = 0; seed < 200; seed++) {
      let s = newGame(DOUGHNUT, 2 + (seed % 9), seed);
      const steps = Math.floor(rng() * 25);
      for (let i = 0; i < steps && (s.phase === 'play' || s.phase === 'declare' || s.phase === 'exchange'); i++) {
        s = applyMove(s, pick(legalMoves(s), rng));
      }
      if (s.toAct < 0) continue;
      const me = s.toAct;
      const o = observe(s, me);
      const d = determinize(o, rng);
      expect(d.hands[me].sort()).toEqual(s.hands[me].slice().sort());
      expect(d.hands.map((h) => h.length)).toEqual(s.hands.map((h) => h.length));
      const all = [...d.hands.flat(), ...d.stock, ...(d.discard !== null ? [d.discard] : [])];
      const played = [...d.tricks.flatMap((t) => t.plays.map((p) => p.card)), ...d.currentTrick.map((p) => p.card)];
      const everything = [...all, ...played, ...(all.includes(d.turnUp) || played.includes(d.turnUp) ? [] : [d.turnUp])];
      expect(new Set(everything).size).toBe(everything.length);
      expect(everything.length).toBe(52);
      expect(legalMoves(d).map((m) => JSON.stringify(m)).sort()).toEqual(o.legalMoves.map((m) => JSON.stringify(m)).sort());
      d.hands.forEach((h, p) => {
        if (p !== me) for (const c of h) expect(s.voids[p][suitOf(c)] && c !== s.turnUp).toBe(false);
      });
    }
  });
});
