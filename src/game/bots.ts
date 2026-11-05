import type { Agent } from '../ai/agent';
import { heuristicAgent } from '../ai/heuristic';
import { dmcAgent } from '../ml/dmc';
import type { Mlp } from '../ml/mlp';
import type { BotLevel } from './protocol';

/**
 * easy = rule-based heuristic; medium = trained model with 15% random moves;
 * hard = trained model. Without a model, every level falls back to the heuristic.
 */
export function botFactory(net: Mlp | null): (level: BotLevel) => Agent {
  return (level) => {
    if (!net || level === 'easy') return heuristicAgent();
    return dmcAgent(net, { epsilon: level === 'medium' ? 0.15 : 0, name: level });
  };
}
