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

export interface Profile {
  name: string;
  /** Display rating (1000 = new player), or null when ratings aren't kept. */
  rating: number | null;
  games: number;
  wins: number;
}

/** A finished game, as recorded. Seats in table order. */
export interface GameRecord {
  code: string;
  mode: string;
  startedAt: number;
  endedAt: number;
  hands: number;
  winners: number[];
  seats: {
    /** The human who started in this seat (null for bots). */
    userId: string | null;
    /** Their saved account, if they have one (guests: null). Only accounts are recorded and rated. */
    accountId: string | null;
    name: string;
    botLevel: BotLevel | null;
    finalScore: number;
    /** A human who left before the end (a bot finished for them). */
    leftEarly: boolean;
  }[];
}

/** The signed-in account, or null for a guest. */
export interface AccountView {
  nickname: string;
  profile: Profile;
}

export type ClientMessage =
  | { t: 'hello'; token: string; name: string }
  /** Save the current nickname with a password (guest -> account). */
  | { t: 'register'; password: string }
  | { t: 'login'; nickname: string; password: string }
  | { t: 'logout' }
  | { t: 'create'; settings: TableSettings }
  | { t: 'join'; code: string }
  | { t: 'quick'; mode: string }
  | { t: 'start' }
  | { t: 'move'; move: Move }
  | { t: 'leave' };

export type ServerMessage =
  | { t: 'welcome'; name: string; account: AccountView | null }
  /** Sent after register / login / logout. */
  | { t: 'account'; name: string; account: AccountView | null }
  | { t: 'profile'; profile: Profile; ratingChange: number | null }
  | { t: 'table'; table: TableView }
  | { t: 'left' }
  | { t: 'queued'; position: number }
  | { t: 'error'; message: string };

export function toWire(o: Observation): WireObservation {
  const { config: _config, ...rest } = o;
  return rest;
}
