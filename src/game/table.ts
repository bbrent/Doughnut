/**
 * One game table: seats, lobby, game flow, turn timers and bot cover.
 * Pure logic with an injected clock, so it runs on the server, in the
 * browser (offline practice) and in tests.
 */
import type { Agent } from '../ai/agent';
import {
  MODES,
  applyMove,
  mulberry32,
  newGame,
  observe,
  randInt,
  startNextHand,
  type GameState,
  type Move,
  type Rng,
} from '../engine';
import { BOT_NAMES, pickBotNames } from './bot-names';
import { toWire, type BotLevel, type GameRecord, type SeatView, type TableSettings, type TableView } from './protocol';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Timing {
  /** Time a connected human has for each decision before a bot plays for them. */
  turnMs: number;
  /** Pause before a bot moves, so play is followable. */
  botDelayMs: number;
  /** Pause after a completed trick, so players can see it. */
  trickPauseMs: number;
  /** Pause between hands to show the result. */
  betweenHandsMs: number;
  /** How long to wait for a disconnected human before a bot plays for them. */
  disconnectedMs: number;
}

export const DEFAULT_TIMING: Timing = {
  turnMs: 30_000,
  botDelayMs: 700,
  trickPauseMs: 1_200,
  betweenHandsMs: 4_000,
  disconnectedMs: 1_500,
};

export interface User {
  id: string;
  name: string;
  /** Saved account id; null for guests. May be set mid-game when a guest registers. */
  accountId: string | null;
}

type Seat =
  | { kind: 'human'; user: User; connected: boolean }
  | { kind: 'bot'; name: string }
  | { kind: 'open' };

export interface TableDeps {
  makeBot: (level: BotLevel) => Agent;
  clock?: Clock;
  timing?: Partial<Timing>;
  rng?: Rng;
  onChange?: (t: Table) => void;
  /** Called once when a game finishes. */
  onGameOver?: (t: Table, record: GameRecord) => void;
}

export class TableError extends Error {}

export class Table {
  readonly settings: TableSettings;
  status: TableView['status'] = 'lobby';
  state: GameState | null = null;
  private seats: Seat[];
  private hostSeat = 0;
  private deadline: number | null = null;
  private timer: unknown = null;
  private bots: Agent[] = [];
  private readonly clock: Clock;
  private readonly timing: Timing;
  private readonly rng: Rng;
  private lastActivity: number;
  private startedAt = 0;
  /** Who started in each seat (null = bot), for the game record. */
  private originalUsers: (User | null)[] = [];

  constructor(
    readonly code: string,
    host: User,
    settings: TableSettings,
    private readonly deps: TableDeps,
  ) {
    const config = MODES[settings.mode];
    if (!config) throw new TableError(`Unknown mode ${settings.mode}`);
    const seats = Math.round(settings.seats);
    if (!(seats >= config.players.min && seats <= config.players.max)) {
      throw new TableError(`${config.name} needs ${config.players.min}-${config.players.max} seats`);
    }
    this.settings = { ...settings, seats };
    this.clock = deps.clock ?? realClock;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.rng = deps.rng ?? mulberry32((Math.random() * 2 ** 32) >>> 0);
    this.seats = Array.from({ length: seats }, () => ({ kind: 'open' }) as Seat);
    this.seats[0] = { kind: 'human', user: host, connected: true };
    this.lastActivity = this.clock.now();
  }

  // ---- seats -------------------------------------------------------------

  seatOf(userId: string): number {
    return this.seats.findIndex((s) => s.kind === 'human' && s.user.id === userId);
  }

  humans(): User[] {
    return this.seats.flatMap((s) => (s.kind === 'human' ? [s.user] : []));
  }

  hasConnectedHumans(): boolean {
    return this.seats.some((s) => s.kind === 'human' && s.connected);
  }

  idleMs(): number {
    return this.clock.now() - this.lastActivity;
  }

  /** Join (or rejoin) the table. Returns the seat index. */
  join(user: User): number {
    const existing = this.seatOf(user.id);
    if (existing >= 0) {
      this.setConnected(user.id, true);
      return existing;
    }
    if (this.status === 'lobby') {
      const open = this.seats.findIndex((s) => s.kind === 'open');
      if (open < 0) throw new TableError('Table is full');
      this.seats[open] = { kind: 'human', user, connected: true };
      this.changed();
      return open;
    }
    // A game in progress (or just finished): take over a bot's seat, score and all.
    const bot = this.seats.findIndex((s) => s.kind === 'bot');
    if (bot < 0) throw new TableError('That game is full');
    this.seats[bot] = { kind: 'human', user, connected: true };
    if (this.status === 'playing' && this.state?.toAct === bot) this.schedule(); // their turn now, with a turn timer
    this.changed();
    return bot;
  }

  /** Whether someone else could join now: an open seat, or a bot seat to take over. */
  joinable(): boolean {
    return this.seats.some((s) => s.kind === (this.status === 'lobby' ? 'open' : 'bot'));
  }

  /** Humans currently seated. */
  humanCount(): number {
    return this.seats.filter((s) => s.kind === 'human').length;
  }

  /** Leave for good. In a game, a bot takes the seat over. */
  leave(userId: string): void {
    const i = this.seatOf(userId);
    if (i < 0) return;
    if (this.status === 'lobby') {
      this.seats[i] = { kind: 'open' };
      if (i === this.hostSeat) {
        const next = this.seats.findIndex((s) => s.kind === 'human');
        if (next >= 0) this.hostSeat = next;
      }
    } else {
      // A bot plays on under the leaver's name; the robot icon shows it's a bot now.
      this.seats[i] = { kind: 'bot', name: (this.seats[i] as { user: User }).user.name };
      this.bots[i] = this.deps.makeBot(this.settings.botLevel);
      if (i === this.hostSeat) {
        const next = this.seats.findIndex((s) => s.kind === 'human');
        if (next >= 0) this.hostSeat = next;
      }
      this.schedule();
    }
    this.changed();
  }

  setConnected(userId: string, connected: boolean): void {
    const i = this.seatOf(userId);
    if (i < 0) return;
    const s = this.seats[i] as Extract<Seat, { kind: 'human' }>;
    if (s.connected === connected) return;
    s.connected = connected;
    // Re-arm the timer: a disconnected player's turn is covered quickly.
    if (this.status === 'playing' && this.state?.toAct === i) this.schedule();
    this.changed();
  }

  // ---- game flow ---------------------------------------------------------

  start(userId: string): void {
    if (this.seatOf(userId) !== this.hostSeat) throw new TableError('Only the host can start');
    if (this.status === 'playing') throw new TableError('Already playing');
    const config = MODES[this.settings.mode];
    // Bots keep their names for a rematch; open seats, and bots that took over
    // for someone who left, get a fresh bot name.
    const keeps = (s: Seat) => s.kind === 'bot' && BOT_NAMES.includes(s.name);
    const taken = this.seats.flatMap((s) => (s.kind === 'human' ? [s.user.name] : keeps(s) ? [(s as { name: string }).name] : []));
    const names = pickBotNames(this.seats.filter((s) => s.kind !== 'human' && !keeps(s)).length, taken, this.rng);
    this.bots = this.seats.map((s, i) => {
      if (s.kind !== 'human' && !keeps(s)) this.seats[i] = { kind: 'bot', name: names.shift()! };
      return this.deps.makeBot(this.settings.botLevel);
    });
    const n = this.seats.length;
    this.originalUsers = this.seats.map((s) => (s.kind === 'human' ? s.user : null));
    this.startedAt = this.clock.now();
    this.state = newGame(config, n, Math.floor(this.rng() * 2 ** 32), randInt(this.rng, n));
    this.status = 'playing';
    this.schedule();
    this.changed();
  }

  move(userId: string, move: Move): void {
    const s = this.state;
    if (this.status !== 'playing' || !s) throw new TableError('No game in progress');
    const seat = this.seatOf(userId);
    if (seat < 0 || s.toAct !== seat) throw new TableError("It isn't your turn");
    this.apply(move);
  }

  private apply(move: Move): void {
    const before = this.state!;
    this.state = applyMove(before, move); // throws on illegal moves
    this.lastActivity = this.clock.now();
    const trickDone = this.state.tricks.length > before.tricks.length && this.state.phase === 'play';
    this.schedule(trickDone ? this.timing.trickPauseMs : 0);
    this.changed();
  }

  /** Arm the timer for whatever should happen next. */
  private schedule(extraDelay = 0): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    const s = this.state;
    if (!s || this.status !== 'playing') return;

    if (s.phase === 'gameOver') {
      this.status = 'over';
      this.deps.onGameOver?.(this, this.record());
      return;
    }
    if (s.phase === 'handOver') {
      this.timer = this.clock.setTimeout(() => {
        this.state = startNextHand(this.state!);
        this.schedule();
        this.changed();
      }, this.timing.betweenHandsMs);
      return;
    }

    const p = s.toAct;
    const seat = this.seats[p];
    const autoMove = () => {
      this.timer = null;
      const st = this.state!;
      if (st.toAct !== p || this.status !== 'playing') return;
      this.apply(this.bots[p].chooseMove(observe(st, p), this.rng));
    };
    let wait: number;
    if (seat.kind === 'human' && seat.connected) {
      wait = this.timing.turnMs;
      this.deadline = this.clock.now() + extraDelay + wait;
    } else if (seat.kind === 'human') {
      wait = this.timing.disconnectedMs;
    } else {
      wait = this.timing.botDelayMs;
    }
    this.timer = this.clock.setTimeout(autoMove, extraDelay + wait);
  }

  /** Summary of the finished game. */
  record(): GameRecord {
    const s = this.state!;
    return {
      code: this.code,
      mode: this.settings.mode,
      startedAt: this.startedAt,
      endedAt: this.clock.now(),
      hands: s.handsPlayed,
      winners: s.winners.slice(),
      seats: this.seats.map((seat, i) => {
        const orig = this.originalUsers[i] ?? null;
        const stillHere = !!orig && seat.kind === 'human' && seat.user.id === orig.id;
        if (!orig && seat.kind === 'human') {
          // Took over a bot's seat part-way through: a person, but not credited for the game.
          return { userId: seat.user.id, accountId: null, name: seat.user.name, botLevel: null, finalScore: s.scores[i], leftEarly: false };
        }
        return {
          userId: orig?.id ?? null,
          accountId: orig?.accountId ?? null,
          name: orig?.name ?? (seat.kind === 'bot' ? seat.name : 'Open seat'),
          botLevel: orig ? null : this.settings.botLevel,
          finalScore: s.scores[i],
          leftEarly: !!orig && !stillHere,
        };
      }),
    };
  }

  /** Stop timers (table being discarded). */
  close(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private changed(): void {
    this.deps.onChange?.(this);
  }

  // ---- views -------------------------------------------------------------

  /** What one user is allowed to see. Other players' cards never leave here. */
  view(userId: string): TableView {
    const you = this.seatOf(userId);
    const s = this.state;
    const seats: SeatView[] = this.seats.map((seat) => ({
      name: seat.kind === 'human' ? seat.user.name : seat.kind === 'bot' ? seat.name : 'Open seat',
      kind: seat.kind,
      connected: seat.kind === 'human' ? seat.connected : seat.kind === 'bot',
      covered: seat.kind === 'human' && !seat.connected && this.status === 'playing',
    }));
    return {
      code: this.code,
      settings: this.settings,
      status: this.status,
      hostSeat: this.hostSeat,
      you,
      seats,
      obs: s && you >= 0 ? toWire(observe(s, you)) : null,
      deadline: s && s.toAct === you ? this.deadline : null,
      lastHand: s?.lastHand ?? null,
      winners: s?.winners ?? [],
    };
  }
}
