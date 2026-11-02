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
      let s = newGame(DOUGHNUT, 2 + (i % 9), i);
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
