import { readFileSync } from 'node:fs';
import { heuristicAgent, ismctsAgent, randomAgent, type Agent } from '../ai';
import { dmcAgent, loadModel } from '../ml';

/** Parse a bot spec: random | heuristic | ismcts[:iterations] | dmc[:model.json] */
export function makeBot(spec: string): Agent {
  const [kind, ...rest] = spec.split(':');
  const arg = rest.join(':') || undefined;
  switch (kind) {
    case 'random':
      return randomAgent();
    case 'heuristic':
      return heuristicAgent();
    case 'ismcts':
      return ismctsAgent(arg ? { iterations: Number(arg) } : {});
    case 'dmc':
      return dmcAgent(loadModel(JSON.parse(readFileSync(arg ?? 'models/doughnut.json', 'utf8'))), { name: spec });
    default:
      throw new Error(`Unknown bot "${spec}" (random | heuristic | ismcts[:iterations] | dmc[:model.json])`);
  }
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    }
  }
  return out;
}
