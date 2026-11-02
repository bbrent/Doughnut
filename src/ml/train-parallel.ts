/**
 * Multi-threaded trainer: N worker threads play self-play hands; the main
 * thread owns the replay buffer, trains, and periodically broadcasts weights.
 */
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { mulberry32 } from '../engine';
import type { Mlp } from './mlp';
import { Learner, evaluate, type EvalResult, type TrainOptions } from './train';

export interface ParallelOptions {
  workers?: number;
  /** Hands per message from an actor. */
  chunk?: number;
  /** Broadcast weights after this many minibatch updates. */
  syncEvery?: number;
}

export async function trainParallel(
  net: Mlp,
  opts: TrainOptions,
  onEval: (r: EvalResult) => void = () => {},
  par: ParallelOptions = {},
): Promise<void> {
  const nWorkers = par.workers ?? Math.max(1, cpus().length - 1);
  const chunk = par.chunk ?? 20;
  const syncEvery = par.syncEvery ?? 20;
  const learner = new Learner(net, opts, mulberry32(opts.seed));
  const { config, ...rest } = opts;
  const actorUrl = new URL('./actor.ts', import.meta.url);

  let hands = 0;
  let nextEval = opts.evalEvery;
  let lastSync = 0;
  let t0 = performance.now();
  let handsSinceEval = 0;
  const inbox: { xs: Float32Array; ys: Float32Array; hands: number; from: Worker }[] = [];

  const workers = Array.from(
    { length: nWorkers },
    (_, i) =>
      new Worker(actorUrl, {
        execArgv: ['--import', 'tsx'],
        workerData: { opts: { ...rest, mode: config.id }, seed: opts.seed * 1000 + i + 1, chunk },
      }),
  );
  const broadcast = () => {
    const model = net.toJSON();
    for (const w of workers) w.postMessage({ type: 'weights', model, progress: hands / opts.hands });
  };
  for (const w of workers) {
    w.on('message', (m) => inbox.push({ ...m, from: w }));
    w.on('error', (e) => {
      throw e;
    });
  }
  broadcast();

  const inputSize = net.inputSize;
  while (hands < opts.hands) {
    // Only take new data once the learner has used what it has (backpressure).
    while (inbox.length && !learner.hasBacklog()) {
      const m = inbox.shift()!;
      m.from.postMessage({ type: 'credit' });
      const xs: Float32Array[] = [];
      for (let i = 0; i < m.ys.length; i++) xs.push(m.xs.subarray(i * inputSize, (i + 1) * inputSize));
      learner.add(xs, Array.from(m.ys));
      hands += m.hands;
      handsSinceEval += m.hands;
    }
    learner.step(5);
    if (learner.updates - lastSync >= syncEvery) {
      lastSync = learner.updates;
      broadcast();
    }
    if (hands >= nextEval || hands >= opts.hands) {
      nextEval += opts.evalEvery;
      const handsPerSec = handsSinceEval / ((performance.now() - t0) / 1000);
      const ev = evaluate(net, config, opts.evalPlayers, opts.evalGames, 12345);
      onEval({ hands, ...ev, loss: learner.takeLoss(), handsPerSec });
      handsSinceEval = 0;
      t0 = performance.now();
    }
    await new Promise((r) => setImmediate(r));
  }
  for (const w of workers) w.postMessage({ type: 'stop' });
  await Promise.all(workers.map((w) => w.terminate()));
}
