/**
 * Train the network on ISMCTS data.
 *
 *   npm run distill -- --data data/a.bin,data/b.bin --init models/doughnut.json --out models/doughnut.json
 *   npm run distill -- --hidden 512,256          # fresh, larger network
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MODES, mulberry32 } from '../engine';
import {
  DEFAULT_DISTILL,
  FEATURE_VERSION,
  createModel,
  distill,
  evaluate,
  loadModel,
  type MlpJSON,
} from '../ml';
import { loadSearchData } from '../ml/load-data';
import { parseArgs } from './bots';

const args = parseArgs(process.argv.slice(2));
const config = MODES[args.mode ?? 'doughnut'];
const files = (args.data ?? `data/${config.id}-ismcts.bin`).split(',');
const out = args.out ?? `models/${config.id}-distilled.json`;
const o = {
  ...DEFAULT_DISTILL,
  epochs: Number(args.epochs ?? DEFAULT_DISTILL.epochs),
  lr: Number(args.lr ?? DEFAULT_DISTILL.lr),
  alpha: Number(args.alpha ?? DEFAULT_DISTILL.alpha),
  minVisits: Number(args['min-visits'] ?? DEFAULT_DISTILL.minVisits),
};
const evalGames = Number(args['eval-games'] ?? 200);

const decisions = loadSearchData(files);
const hidden = args.hidden ? args.hidden.split(',').map(Number) : undefined; // e.g. --hidden 512,256
const net = args.init ? loadModel(JSON.parse(readFileSync(args.init, 'utf8')) as MlpJSON) : createModel(mulberry32(o.seed), hidden);
console.log(`${decisions.length} decisions from ${files.length} file(s); net ${net.sizes.join('-')}${args.init ? ` from ${args.init}` : ''}`);

const t0 = performance.now();
let best = -1;
distill(net, decisions, o, (e, trainLoss, valLoss, agree) => {
  const ev = evaluate(net, config, 4, evalGames, 12345);
  console.log(
    `epoch ${e} | train ${trainLoss.toFixed(4)} | val ${valLoss.toFixed(4)} | agrees with search ${(100 * agree).toFixed(1)}% | win vs 3 heuristic ${(100 * ev.winRate).toFixed(1)}% | ${((performance.now() - t0) / 1000).toFixed(0)}s`,
  );
  const meta = { featureVersion: FEATURE_VERSION, mode: config.id, distilledFrom: files, epoch: e, winRate: ev.winRate };
  writeFileSync(out.replace(/\.json$/, '.latest.json'), JSON.stringify(net.toJSON(meta)));
  if (ev.winRate >= best) {
    best = ev.winRate;
    writeFileSync(out, JSON.stringify(net.toJSON(meta)));
  }
});
console.log(`Best ${(100 * best).toFixed(1)}% saved to ${out}`);
