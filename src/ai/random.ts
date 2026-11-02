import { pick } from '../engine';
import type { Agent } from './agent';

export const randomAgent = (): Agent => ({
  name: 'random',
  chooseMove: (obs, rng) => pick(obs.legalMoves, rng),
});
