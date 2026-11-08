/** Wire protocol between client and server (JSON over WebSocket). */
import type { HandResult, Move, Observation } from '../engine';

export type BotLevel = 'beginner' | 'easy' | 'medium' | 'hard';

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

/** What a friend is doing right now. */
export interface FriendView {
  nickname: string;
  status: 'offline' | 'online' | 'queue' | 'lobby' | 'playing' | 'over';
  /** The table they're at, if any. */
  table: { code: string; mode: string; seats: number; humans: number; joinable: boolean } | null;
}

export interface FriendsView {
  friends: FriendView[];
  /** Nicknames asking to be your friend. */
  incoming: string[];
  /** Nicknames you've asked. */
  outgoing: string[];
}

export interface Invite {
  /** The inviting friend's nickname. */
  from: string;
  code: string;
  mode: string;
  status: 'lobby' | 'playing' | 'over';
  humans: number;
  seats: number;
}

/** The signed-in account, or null for a guest. */
export interface AccountView {
  nickname: string;
  profile: Profile;
}

export type ClientMessage =
  | { t: 'hello'; token: string; name: string }
  /** Sign up: a confirmation link is emailed; until then you stay a guest. */
  | { t: 'signup'; email: string; nickname: string; password: string }
  | { t: 'resend'; email: string }
  /** The code from a confirmation link. */
  | { t: 'verify'; code: string }
  /** `login` is an email address or a nickname. */
  | { t: 'login'; login: string; password: string }
  | { t: 'logout' }
  | { t: 'forgot'; email: string }
  /** The code from a reset link, with the new password. */
  | { t: 'reset'; code: string; password: string }
  | { t: 'friendAdd'; nickname: string }
  | { t: 'friendRespond'; nickname: string; accept: boolean }
  /** Remove a friend, or cancel a request you sent. */
  | { t: 'friendRemove'; nickname: string }
  /** Invite a friend to the table you're at. */
  | { t: 'invite'; nickname: string }
  /** Turn down an invite (the inviter is told you can't join right now). */
  | { t: 'inviteDecline'; from: string }
  | { t: 'create'; settings: TableSettings }
  | { t: 'join'; code: string }
  /** Quick match; `botLevel` is used for any seats bots have to fill. */
  | { t: 'quick'; mode: string; botLevel?: BotLevel }
  /** Host only, before the game starts or before a rematch. */
  | { t: 'settings'; botLevel: BotLevel }
  | { t: 'start' }
  | { t: 'move'; move: Move }
  | { t: 'leave' };

export type ServerMessage =
  | { t: 'welcome'; name: string; account: AccountView | null }
  /** Sent after login / email confirmed / password reset / logout. */
  | { t: 'account'; name: string; account: AccountView | null; why: 'login' | 'verified' | 'reset' | 'logout' }
  /** Information for the account forms ("check your email"). */
  | { t: 'notice'; kind: 'signup' | 'reset'; message: string }
  /** Your friends and their status; sent when you log in and whenever it changes. */
  | { t: 'friends'; friends: FriendsView }
  /** A friend invites you to their table. */
  | { t: 'invite'; invite: Invite }
  /** A short message to show (e.g. "Friend request sent"). */
  | { t: 'toast'; message: string }
  | { t: 'profile'; profile: Profile; ratingChange: number | null }
  | { t: 'table'; table: TableView }
  | { t: 'left' }
  | { t: 'queued'; position: number }
  | { t: 'error'; message: string };

export function toWire(o: Observation): WireObservation {
  const { config: _config, ...rest } = o;
  return rest;
}
