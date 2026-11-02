import { heuristicAgent, ismctsAgent, randomAgent, type Agent } from '../ai';

/** Parse a bot spec: random | heuristic | ismcts | ismcts:<iterations> */
export function makeBot(spec: string): Agent {
  const [kind, arg] = spec.split(':');
  switch (kind) {
    case 'random':
      return randomAgent();
    case 'heuristic':
      return heuristicAgent();
    case 'ismcts':
      return ismctsAgent(arg ? { iterations: Number(arg) } : {});
    default:
      throw new Error(`Unknown bot "${spec}" (random | heuristic | ismcts[:iterations])`);
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
