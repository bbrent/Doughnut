/**
 * Generate ISMCTS training data in worker threads.
 *
 *   npm run gen-data -- --hands 20000 --iterations 1000 --out data/ismcts-1.bin
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DEFAULT_ISMCTS } from '../ai';
import { MODES } from '../engine';
import { DATA_FORMAT, DEFAULT_TRAIN, type GenerateOptions } from '../ml';
import { parseArgs } from './bots';

const args = parseArgs(process.argv.slice(2));
const config = MODES[args.mode ?? 'doughnut'];
const hands = Number(args.hands ?? 10_000);
const out = args.out ?? `data/${config.id}-ismcts.bin`;
const nWorkers = Number(args.workers ?? Math.max(1, cpus().length - 1));
const seed = Number(args.seed ?? Date.now() % 1e9);
const gen: GenerateOptions = {
  search: { ...DEFAULT_ISMCTS, iterations: Number(args.iterations ?? 1000) },
  exploreProb: Number(args.explore ?? 0.1),
};
const { hands: _h, ...trainRest } = DEFAULT_TRAIN;
const opts = { ...trainRest, hands, mode: config.id, heuristicSeatFrac: Number(args['heuristic-seats'] ?? 0.2) };

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Uint8Array());
console.log(`Generating ${hands} hands of ${config.name} with ISMCTS(${gen.search.iterations}) on ${nWorkers} workers -> ${out}`);

let done = 0;
let decisions = 0;
let bytes = 0;
const t0 = performance.now();
let lastLog = 0;
const writeMeta = () =>
  writeFileSync(
    out + '.meta.json',
    JSON.stringify({ format: DATA_FORMAT, mode: config.id, hands: done, decisions, iterations: gen.search.iterations, seed }, null, 2),
  );
const workers = Array.from(
  { length: nWorkers },
  (_, i) =>
    new Worker(new URL('../ml/gen-worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData: { opts, gen, seed: seed * 1000 + i, chunk: Number(args.chunk ?? 10) },
    }),
);

await new Promise<void>((resolve, reject) => {
  for (const w of workers) {
    w.on('error', reject);
    w.on('message', (m: { bytes: Uint8Array; hands: number; decisions: number }) => {
      if (done >= hands) return;
      appendFileSync(out, m.bytes);
      done += m.hands;
      decisions += m.decisions;
      bytes += m.bytes.byteLength;
      const secs = (performance.now() - t0) / 1000;
      if (secs - lastLog > 30 || done >= hands) {
        lastLog = secs;
        writeMeta();
        const rate = done / secs;
        console.log(
          `${done}/${hands} hands | ${decisions} decisions | ${(bytes / 1e6).toFixed(1)} MB | ${rate.toFixed(1)} hands/s | ETA ${((hands - done) / rate / 60).toFixed(1)} min`,
        );
      }
      if (done >= hands) resolve();
    });
  }
});
await Promise.all(workers.map((w) => w.terminate()));
writeMeta();
console.log('done');
