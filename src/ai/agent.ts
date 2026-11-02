import type { Move, Observation, Rng } from '../engine';

/** A player. Agents only see their own Observation — never the full state. */
export interface Agent {
  name: string;
  chooseMove(obs: Observation, rng: Rng): Move;
}
