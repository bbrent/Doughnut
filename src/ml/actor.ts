/**
 * Self-play actor running in a worker thread. Plays hands with the latest
 * weights it was sent and streams samples back to the learner.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { heuristicAgent } from '../ai/heuristic';
import { MODES, mulberry32 } from '../engine';
import { Mlp, type MlpJSON } from './mlp';
import { epsilonAt, playTrainingHand, type TrainOptions } from './train';

type FromLearner = { type: 'weights'; model: MlpJSON; progress: number } | { type: 'credit' } | { type: 'stop' };

const { opts: rawOpts, seed, chunk } = workerData as { opts: Omit<TrainOptions, 'config'> & { mode: string }; seed: number; chunk: number };
const opts: TrainOptions = { ...rawOpts, config: MODES[rawOpts.mode] };
const rng = mulberry32(seed);
const heur = heuristicAgent();
let net: Mlp | null = null;
let progress = 0;
let running = true;
/** Chunks we may send before the learner acknowledges (backpressure). */
let credits = 2;

parentPort!.on('message', (m: FromLearner) => {
  if (m.type === 'stop') running = false;
  else if (m.type === 'credit') credits++;
  else {
    if (!net) net = Mlp.fromJSON(m.model);
    else net.copyWeightsFrom(Mlp.fromJSON(m.model));
    progress = m.progress;
  }
});

async function loop() {
  while (running) {
    if (!net || credits <= 0) {
      await new Promise((r) => setTimeout(r, 2));
      continue;
    }
    const flat: number[] = [];
    const ys: number[] = [];
    for (let h = 0; h < chunk; h++) {
      const s = playTrainingHand(net, opts, epsilonAt(opts, progress), rng, heur);
      for (const x of s.xs) for (let i = 0; i < x.length; i++) flat.push(x[i]);
      ys.push(...s.ys);
    }
    const xs = new Float32Array(flat);
    credits--;
    parentPort!.postMessage({ type: 'samples', xs, ys: new Float32Array(ys), hands: chunk }, [xs.buffer]);
    await new Promise((r) => setImmediate(r)); // let weight updates arrive
  }
  process.exit(0);
}
loop();
