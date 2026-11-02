/**
 * Train the DMC model by self-play.
 *
 *   npm run train -- --hands 200000 --out models/doughnut.json
 *   npm run train -- --resume models/doughnut.json --hands 100000
 *   npm run train -- --workers 1      # single-threaded
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MODES, mulberry32 } from '../engine';
import { DEFAULT_TRAIN, FEATURE_VERSION, createModel, loadModel, train, trainParallel, type EvalResult, type MlpJSON } from '../ml';
import { parseArgs } from './bots';

const args = parseArgs(process.argv.slice(2));
const config = MODES[args.mode ?? 'doughnut'];
const out = args.out ?? `models/${config.id}.json`;
const opts = {
  ...DEFAULT_TRAIN,
  config,
  hands: Number(args.hands ?? DEFAULT_TRAIN.hands),
  evalEvery: Number(args['eval-every'] ?? DEFAULT_TRAIN.evalEvery),
  evalGames: Number(args['eval-games'] ?? DEFAULT_TRAIN.evalGames),
  lr: Number(args.lr ?? DEFAULT_TRAIN.lr),
  seed: Number(args.seed ?? DEFAULT_TRAIN.seed),
  replayRatio: Number(args['replay-ratio'] ?? DEFAULT_TRAIN.replayRatio),
};
const workers = args.workers ? Number(args.workers) : undefined;

const net = args.resume
  ? loadModel(JSON.parse(readFileSync(args.resume, 'utf8')) as MlpJSON)
  : createModel(mulberry32(opts.seed));
let trainedHands = 0;
if (args.resume) trainedHands = Number((JSON.parse(readFileSync(args.resume, 'utf8')) as MlpJSON).meta?.hands ?? 0);

console.log(`Training ${config.name}: ${opts.hands} hands, net ${net.sizes.join('-')}, eval vs ${opts.evalPlayers - 1} heuristic bots`);
let best = -1;
const onEval = (r: EvalResult) => {
  const total = trainedHands + r.hands;
  console.log(
    `hands ${total.toString().padStart(8)} | loss ${r.loss.toFixed(4)} | win ${(100 * r.winRate).toFixed(1)}% ` +
      `(fair ${(100 * r.fairShare).toFixed(0)}%) | avg score ${r.avgScore.toFixed(2)} | ${r.handsPerSec.toFixed(0)} hands/s`,
  );
  mkdirSync(dirname(out), { recursive: true });
  const meta = { featureVersion: FEATURE_VERSION, mode: config.id, hands: total, winRate: r.winRate };
  writeFileSync(out.replace(/\.json$/, '.latest.json'), JSON.stringify(net.toJSON(meta)));
  if (r.winRate >= best) {
    best = r.winRate;
    writeFileSync(out, JSON.stringify(net.toJSON(meta)));
  }
};
if (workers === 1) train(net, opts, onEval);
else await trainParallel(net, opts, onEval, { workers });
console.log(`Best eval win rate ${(100 * best).toFixed(1)}% saved to ${out}`);
