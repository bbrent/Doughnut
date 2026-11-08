/** Wire protocol between client and server (JSON over WebSocket). */
import type { HandResult, Move, Observation } from '../engine';

export type BotLevel = 'easy' | 'medium' | 'hard';

export interface TableSettings {
  mode: string;
  /** Total seats, 2-6. Empty seats are filled with bots when the game starts. */
  seats: number;
  botLevel: BotLevel;
}

/** An Observation without the config object (the client looks it up by mode id). */
export type WireObservation = Omit<Observation, 'config'>;

export interface SeatView {
  name: string;
  kind: 'human' | 'bot' | 'open';
  connected: boolean;
  /** True when a bot is currently covering for a disconnected human. */
  covered: boolean;
}

export interface TableView {
  code: string;
  settings: TableSettings;
  status: 'lobby' | 'playing' | 'over';
  hostSeat: number;
  you: number;
  seats: SeatView[];
  obs: WireObservation | null;
  /** Epoch ms when the current player's turn times out (null if no timer). */
  deadline: number | null;
  lastHand: HandResult | null;
  winners: number[];
}

export type ClientMessage =
  | { t: 'hello'; token: string; name: string }
  | { t: 'create'; settings: TableSettings }
  | { t: 'join'; code: string }
  | { t: 'quick'; mode: string }
  | { t: 'start' }
  | { t: 'move'; move: Move }
  | { t: 'leave' };

export type ServerMessage =
  | { t: 'welcome'; name: string }
  | { t: 'table'; table: TableView }
  | { t: 'left' }
  | { t: 'queued'; position: number }
  | { t: 'error'; message: string };

export function toWire(o: Observation): WireObservation {
  const { config: _config, ...rest } = o;
  return rest;
}
