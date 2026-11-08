import type { Agent } from '../ai/agent';
import { heuristicAgent } from '../ai/heuristic';
import { dmcAgent } from '../ml/dmc';
import type { Mlp } from '../ml/mlp';
import type { BotLevel } from './protocol';

/**
 * Difficulty levels. All use the trained model: weaker levels pick moves with
 * probability softmax(Q / temperature), so they make believable mistakes
 * (a near-best card, a borderline fold) rather than random ones.
 * Measured with `npx tsx scripts/levels.ts`: see the README for results.
 */
export const BOT_LEVELS: Record<BotLevel, { label: string; temperature: number; blurb: string }> = {
  beginner: { label: 'Beginner', temperature: 0.3, blurb: 'Learning the game: makes plenty of mistakes' },
  easy: { label: 'Easy', temperature: 0.15, blurb: 'Plays sensibly, slips up often' },
  medium: { label: 'Medium', temperature: 0.06, blurb: 'Solid, with the odd mistake' },
  hard: { label: 'Hard', temperature: 0, blurb: 'Our strongest bot' },
};
export const BOT_LEVEL_IDS = Object.keys(BOT_LEVELS) as BotLevel[];
export const isBotLevel = (x: unknown): x is BotLevel => typeof x === 'string' && x in BOT_LEVELS;

/** Without a model, every level falls back to the rule-based bot. */
export function botFactory(net: Mlp | null): (level: BotLevel) => Agent {
  return (level) => {
    if (!net) return heuristicAgent();
    return dmcAgent(net, { temperature: BOT_LEVELS[level].temperature, name: level });
  };
}
