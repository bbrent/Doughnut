import { describe, expect, it } from 'vitest';
import { DOUGHNUT, applyMove, legalMoves, mulberry32, newGame, observe, pick, type GameState } from '../src/engine';
import {
  ACTION_SIZE,
  FEATURE_VERSION,
  Mlp,
  STATE_SIZE,
  createModel,
  dmcAgent,
  encodeAction,
  encodeState,
  evaluateMoves,
  loadModel,
  makeContext,
  concatInput,
} from '../src/ml';
import { playGame } from '../src/runner';
import { heuristicAgent } from '../src/ai';

describe('mlp', () => {
  it('backprop matches numerical gradient', () => {
    const net = Mlp.create([5, 6, 4, 1], mulberry32(1));
    const xs = [new Float32Array([0.5, 0, -1, 2, 0.3]), new Float32Array([0, 1, 0.2, 0, -0.4])];
    const ys = [0.7, -0.3];
    const { gW, gb } = net.gradients(xs, ys);
    const loss = () => xs.reduce((a, x, i) => a + (net.predict(x) - ys[i]) ** 2, 0) / xs.length;
    const eps = 1e-2;
    const check = (arr: Float32Array, grad: Float32Array) => {
      for (let k = 0; k < arr.length; k++) {
        const w = arr[k];
        arr[k] = w + eps;
        const up = loss();
        arr[k] = w - eps;
        const down = loss();
        arr[k] = w;
        expect(grad[k]).toBeCloseTo((up - down) / (2 * eps), 2);
      }
    };
    net.W.forEach((w, l) => check(w, gW[l]));
    net.b.forEach((b, l) => check(b, gb[l]));

    const before = loss();
    for (let i = 0; i < 200; i++) net.trainBatch(xs, ys, 1e-2);
    expect(loss()).toBeLessThan(before * 0.05);
  });

  it('predictShared equals predict on the concatenated input', () => {
    const rng = mulberry32(2);
    const net = Mlp.create([6, 8, 4, 1], rng);
    const s = new Float32Array([1, 0, 0.5, 0]);
    const a = [new Float32Array([0, 1]), new Float32Array([1, 0.25])];
    const shared = net.predictShared(s, a);
    a.forEach((ai, i) => expect(shared[i]).toBeCloseTo(net.predict(concatInput(s, ai)), 5));
  });

  it('round-trips through JSON', () => {
    const net = createModel(mulberry32(3), [16, 8]);
    const j = net.toJSON({ featureVersion: FEATURE_VERSION });
    const back = loadModel(JSON.parse(JSON.stringify(j)));
    const x = new Float32Array(STATE_SIZE + ACTION_SIZE).map((_, i) => (i % 7 === 0 ? 1 : 0));
    expect(back.predict(x)).toBe(net.predict(x));
    expect(() => loadModel({ ...j, meta: { featureVersion: -1 } })).toThrow();
  });
});

describe('features', () => {
  function randomStates(count: number): GameState[] {
    const rng = mulberry32(4);
    const out: GameState[] = [];
    for (let i = 0; out.length < count; i++) {
      let s = newGame(DOUGHNUT, 2 + (i % 5), i);
      const steps = Math.floor(rng() * 30);
      for (let k = 0; k < steps && legalMoves(s).length; k++) s = applyMove(s, pick(legalMoves(s), rng));
      if (s.toAct >= 0) out.push(s);
    }
    return out;
  }

  it('produce fixed-size finite vectors for every legal move', () => {
    for (const s of randomStates(300)) {
      const o = observe(s, s.toAct);
      const ctx = makeContext(o);
      const st = encodeState(ctx);
      expect(st.length).toBe(STATE_SIZE);
      expect(st.every(Number.isFinite)).toBe(true);
      for (const m of o.legalMoves) {
        const a = encodeAction(ctx, m);
        expect(a.length).toBe(ACTION_SIZE);
        expect(a.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('are invariant to relabelling suits (trump is always slot 0)', () => {
    const perm = [2, 0, 3, 1]; // C->H, D->C, H->S, S->D
    const mapCard = (c: number) => perm[Math.floor(c / 13)] * 13 + (c % 13);
    let compared = 0;
    for (const s of randomStates(200)) {
      const t: GameState = {
        ...s,
        hands: s.hands.map((h) => h.map(mapCard)),
        stock: s.stock.map(mapCard),
        turnUp: mapCard(s.turnUp),
        trump: s.trump === null ? null : perm[s.trump],
        discard: s.discard === null ? null : mapCard(s.discard),
        currentTrick: s.currentTrick.map((p) => ({ ...p, card: mapCard(p.card) })),
        tricks: s.tricks.map((tr) => ({ ...tr, plays: tr.plays.map((p) => ({ ...p, card: mapCard(p.card) })) })),
        voids: s.voids.map((v) => [0, 1, 2, 3].map((x) => v[perm.indexOf(x)])),
      };
      const a = observe(s, s.toAct);
      const b = observe(t, t.toAct);
      // Ties in suit ordering are broken by suit index, so only compare when unambiguous.
      const ca = makeContext(a);
      const cb = makeContext(b);
      if (ca.slotOfSuit.some((slot, suit) => cb.slotOfSuit[perm[suit]] !== slot)) continue;
      expect(Array.from(encodeState(cb))).toEqual(Array.from(encodeState(ca)));
      for (const m of a.legalMoves) {
        const mm = JSON.parse(JSON.stringify(m), (k, v) => ((k === 'card' || k === 'discard') && v !== null ? mapCard(v) : v));
        expect(Array.from(encodeAction(cb, mm))).toEqual(Array.from(encodeAction(ca, m)));
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(100);
  });
});

describe('dmc agent', () => {
  it('plays legal games with an untrained model', () => {
    const net = createModel(mulberry32(5), [32, 16]);
    const rng = mulberry32(6);
    const log = playGame(DOUGHNUT, [dmcAgent(net), heuristicAgent(), dmcAgent(net, { epsilon: 0.5 })], 9, rng);
    expect(log.final.phase).toBe('gameOver');
    const s = newGame(DOUGHNUT, 3, 1);
    expect(evaluateMoves(net, observe(s, s.toAct)).q).toHaveLength(legalMoves(s).length);
  });
});

describe('training', () => {
  const small = { hands: 150, evalEvery: 150, evalGames: 2, evalPlayers: 3, bufferSize: 5000, batchSize: 32 };

  it('single-threaded trainer runs and reports', async () => {
    const { DEFAULT_TRAIN, train } = await import('../src/ml');
    const net = createModel(mulberry32(7), [32, 16]);
    const evals: number[] = [];
    train(net, { ...DEFAULT_TRAIN, ...small, config: DOUGHNUT }, (r) => evals.push(r.loss));
    expect(evals).toHaveLength(1);
    expect(Number.isFinite(evals[0])).toBe(true);
  });

  it('parallel trainer runs with worker threads', async () => {
    const { DEFAULT_TRAIN, trainParallel } = await import('../src/ml');
    const net = createModel(mulberry32(8), [32, 16]);
    const evals: number[] = [];
    await trainParallel(net, { ...DEFAULT_TRAIN, ...small, config: DOUGHNUT }, (r) => evals.push(r.hands), { workers: 2, chunk: 10 });
    expect(evals.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe('distillation', () => {
  it('dataset stores raw observations that round-trip exactly', async () => {
    const { encodeRecords, decodeRecords, generateHand, featurize, DEFAULT_TRAIN } = await import('../src/ml');
    const { DEFAULT_ISMCTS } = await import('../src/ai');
    const rng = mulberry32(11);
    const opts = { ...DEFAULT_TRAIN, config: DOUGHNUT };
    const rs = [0, 1, 2, 3].flatMap(() => generateHand(opts, { search: { ...DEFAULT_ISMCTS, iterations: 40 }, exploreProb: 0.2 }, rng, heuristicAgent()));
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) {
      expect(r.moves.filter((m) => m.chosen)).toHaveLength(1);
      expect(r.moves).toHaveLength(r.obs.legalMoves.length);
    }
    const bytes = encodeRecords(rs);
    const back = decodeRecords(bytes, DOUGHNUT);
    expect(back).toHaveLength(rs.length);
    back.forEach((b, i) => {
      const { config: _c1, ...a } = rs[i].obs;
      const { config: _c2, ...bb } = b.obs;
      expect(bb).toEqual(a);
      expect(b.moves.map((m) => m.visits)).toEqual(rs[i].moves.map((m) => m.visits));
      expect(b.outcome).toBeCloseTo(rs[i].outcome, 6);
      expect(Array.from(featurize(b).state.val)).toEqual(Array.from(featurize(rs[i]).state.val));
    });
    expect(decodeRecords(bytes.subarray(0, bytes.length - 3), DOUGHNUT)).toHaveLength(rs.length - 1);
  });

  it('distil reduces loss on searched decisions', async () => {
    const { generateHand, distill, featurize, DEFAULT_TRAIN, DEFAULT_DISTILL } = await import('../src/ml');
    const { DEFAULT_ISMCTS } = await import('../src/ai');
    const rng = mulberry32(12);
    const opts = { ...DEFAULT_TRAIN, config: DOUGHNUT };
    const ds = Array.from({ length: 30 })
      .flatMap(() => generateHand(opts, { search: { ...DEFAULT_ISMCTS, iterations: 40 }, exploreProb: 0.1 }, rng, heuristicAgent()))
      .map(featurize);
    for (const loss of ['value', 'policy'] as const) {
      const net = createModel(mulberry32(13), [32, 16]);
      const losses: number[] = [];
      distill(net, ds, { ...DEFAULT_DISTILL, loss, epochs: 8, batchSize: 32, decisionsPerBatch: 8, lr: 3e-3, valFrac: 0 }, (_e, train) => losses.push(train));
      expect(losses[losses.length - 1]).toBeLessThan(losses[0]);
    }
  });
});

describe('features v2', () => {
  it('flags safe and wasted winning cards for the last player in a trick', async () => {
    const { cloneState, parseCard, suitOf } = await import('../src/engine');
    const c = (x: string) => x.split(' ').map(parseCard);
    let s = cloneState(newGame(DOUGHNUT, 3, 1));
    s.hands = [c('2H 3C 4C 5C 6C'), c('3H 7C 8C 9C 10C'), c('KH AH 2S 3S 4S')];
    s.turnUp = parseCard('2D');
    s.trump = suitOf(s.turnUp);
    s.dealer = 2;
    s.playing = [true, true, true];
    s.phase = 'play';
    s.toAct = s.trickLeader = 0;
    s.startScores = s.scores.slice();
    s = applyMove(s, { kind: 'card', card: parseCard('2H') });
    s = applyMove(s, { kind: 'card', card: parseCard('3H') });
    const o = observe(s, 2);
    const ctx = makeContext(o);
    const enc = (card: string) => encodeAction(ctx, { kind: 'card', card: parseCard(card) });
    const tail = (a: Float32Array) => Array.from(a.slice(ACTION_SIZE - 9));
    const [, safeK, wastedK] = tail(enc('KH'));
    const [, safeA, wastedA] = tail(enc('AH'));
    expect([safeK, wastedK]).toEqual([1, 0]);
    expect([safeA, wastedA]).toEqual([1, 1]); // K would also win
  });
});
