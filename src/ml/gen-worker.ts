/** Worker thread: generates ISMCTS-searched hands and posts encoded chunks. */
import { parentPort, workerData } from 'node:worker_threads';
import { heuristicAgent } from '../ai/heuristic';
import { MODES, mulberry32 } from '../engine';
import { encodeDecisions } from './dataset';
import { generateHand, type GenerateOptions } from './distill';
import type { TrainOptions } from './train';

const { opts: raw, gen, seed, chunk } = workerData as {
  opts: Omit<TrainOptions, 'config'> & { mode: string };
  gen: GenerateOptions;
  seed: number;
  chunk: number;
};
const opts: TrainOptions = { ...raw, config: MODES[raw.mode] };
const rng = mulberry32(seed);
const heur = heuristicAgent();

for (;;) {
  const ds = [];
  for (let h = 0; h < chunk; h++) ds.push(...generateHand(opts, gen, rng, heur));
  const bytes = encodeDecisions(ds);
  parentPort!.postMessage({ bytes, hands: chunk, decisions: ds.length }, [bytes.buffer as ArrayBuffer]);
}
