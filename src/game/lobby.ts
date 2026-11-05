/**
 * Lobby: users, table codes, quick match, and routing of client messages.
 * Transport-agnostic: a "client" is anything with send(). The WebSocket
 * server (src/server) is a thin wrapper around this.
 */
import { MODES, mulberry32, randInt, type Rng } from '../engine';
import type { ClientMessage, ServerMessage, TableSettings } from './protocol';
import { Table, TableError, type TableDeps, type User } from './table';

export interface Client {
  send(msg: ServerMessage): void;
}

interface Session {
  token: string;
  user: User;
  clients: Set<Client>;
  table: Table | null;
}

export interface LobbyOptions {
  /** Quick match: table size, and how long to wait before filling with bots. */
  quickSeats: number;
  quickWaitMs: number;
  /** Tables with no connected humans are removed after this long. */
  idleTableMs: number;
}

export const DEFAULT_LOBBY: LobbyOptions = { quickSeats: 4, quickWaitMs: 10_000, idleTableMs: 10 * 60_000 };

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export class Lobby {
  private sessions = new Map<string, Session>(); // by token
  private tables = new Map<string, Table>();
  private members = new Map<Table, Set<Session>>();
  private queue: { token: string; mode: string; since: number }[] = [];
  private rng: Rng;
  readonly opts: LobbyOptions;

  constructor(
    private readonly tableDeps: Omit<TableDeps, 'onChange'>,
    opts: Partial<LobbyOptions> = {},
  ) {
    this.opts = { ...DEFAULT_LOBBY, ...opts };
    this.rng = tableDeps.rng ?? mulberry32((Math.random() * 2 ** 32) >>> 0);
  }

  private now() {
    return this.tableDeps.clock?.now() ?? Date.now();
  }

  get tableCount() {
    return this.tables.size;
  }

  /** Handle one message from a client. `token` is null until hello. */
  handle(client: Client, token: string | null, msg: ClientMessage): string | null {
    try {
      if (msg.t === 'hello') return this.hello(client, msg.token, msg.name);
      if (!token) throw new TableError('Say hello first');
      const s = this.sessions.get(token)!;
      switch (msg.t) {
        case 'create':
          this.create(s, msg.settings);
          break;
        case 'join':
          this.join(s, msg.code);
          break;
        case 'quick':
          this.enqueue(s, msg.mode);
          break;
        case 'start':
          this.requireTable(s).start(s.user.id);
          break;
        case 'move':
          this.requireTable(s).move(s.user.id, msg.move);
          break;
        case 'leave':
          this.leave(s);
          break;
      }
    } catch (e) {
      client.send({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    return token;
  }

  /** A client's connection closed. */
  disconnect(client: Client, token: string | null): void {
    if (!token) return;
    const s = this.sessions.get(token);
    if (!s) return;
    s.clients.delete(client);
    if (s.clients.size === 0) {
      s.table?.setConnected(s.user.id, false);
      this.queue = this.queue.filter((q) => q.token !== token);
    }
  }

  private hello(client: Client, token: string, name: string): string {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new TableError('Bad token');
    const clean = name.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 20) || 'Player';
    let s = this.sessions.get(token);
    if (!s) {
      s = { token, user: { id: `u${this.sessions.size + 1}`, name: clean }, clients: new Set(), table: null };
      this.sessions.set(token, s);
    } else if (!s.table || s.table.status === 'lobby') {
      s.user.name = clean; // can't rename mid-game
    }
    s.clients.add(client);
    client.send({ t: 'welcome', name: s.user.name });
    if (s.table) {
      s.table.join(s.user); // reconnect to the same seat
      this.push(s.table);
    }
    return token;
  }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_CHARS[randInt(this.rng, CODE_CHARS.length)];
      if (!this.tables.has(c)) return c;
    }
  }

  private makeTable(host: User, settings: TableSettings): Table {
    const t = new Table(this.newCode(), host, settings, { ...this.tableDeps, onChange: (tb) => this.push(tb) });
    this.tables.set(t.code, t);
    this.members.set(t, new Set());
    return t;
  }

  private seat(s: Session, t: Table): void {
    s.table = t;
    this.members.get(t)!.add(s);
  }

  private create(s: Session, settings: TableSettings): void {
    this.leave(s, true);
    const t = this.makeTable(s.user, settings);
    this.seat(s, t);
    this.push(t);
  }

  private join(s: Session, code: string): void {
    const t = this.tables.get(code.trim().toUpperCase());
    if (!t) throw new TableError('No table with that code');
    if (s.table && s.table !== t) this.leave(s, true);
    t.join(s.user);
    this.seat(s, t);
    this.push(t);
  }

  private leave(s: Session, quiet = false): void {
    this.queue = this.queue.filter((q) => q.token !== s.token);
    const t = s.table;
    if (!t) return;
    s.table = null;
    this.members.get(t)?.delete(s);
    t.leave(s.user.id);
    if (!quiet) for (const c of s.clients) c.send({ t: 'left' });
    if (t.humans().length === 0) this.removeTable(t);
  }

  private removeTable(t: Table): void {
    t.close();
    for (const s of this.members.get(t) ?? []) s.table = null;
    this.members.delete(t);
    this.tables.delete(t.code);
  }

  private requireTable(s: Session): Table {
    if (!s.table) throw new TableError('You are not at a table');
    return s.table;
  }

  // ---- quick match -------------------------------------------------------

  private enqueue(s: Session, mode: string): void {
    if (!MODES[mode]) throw new TableError(`Unknown mode ${mode}`);
    this.leave(s, true);
    if (!this.queue.some((q) => q.token === s.token)) this.queue.push({ token: s.token, mode, since: this.now() });
    this.tick();
    const pos = this.queue.findIndex((q) => q.token === s.token);
    if (pos >= 0) for (const c of s.clients) c.send({ t: 'queued', position: pos + 1 });
  }

  /**
   * Form quick-match tables: a full table as soon as enough people are
   * waiting, or whoever is waiting plus bots once the oldest has waited long enough.
   * Call periodically.
   */
  tick(): void {
    for (const mode of new Set(this.queue.map((q) => q.mode))) {
      for (;;) {
        const waiting = this.queue.filter((q) => q.mode === mode);
        if (!waiting.length) break;
        const full = waiting.length >= this.opts.quickSeats;
        const stale = this.now() - waiting[0].since >= this.opts.quickWaitMs;
        if (!full && !stale) break;
        const group = waiting.slice(0, this.opts.quickSeats);
        this.queue = this.queue.filter((q) => !group.includes(q));
        const sessions = group.map((q) => this.sessions.get(q.token)!);
        const t = this.makeTable(sessions[0].user, { mode, seats: this.opts.quickSeats, botLevel: 'hard' });
        for (const s of sessions) {
          if (s !== sessions[0]) t.join(s.user);
          this.seat(s, t);
        }
        t.start(sessions[0].user.id);
      }
    }
    // Clean up abandoned tables.
    for (const t of [...this.tables.values()]) {
      if (!t.hasConnectedHumans() && t.idleMs() > this.opts.idleTableMs) this.removeTable(t);
    }
  }

  /** Send each seated human their own view of the table. */
  private push(t: Table): void {
    for (const s of this.members.get(t) ?? []) {
      const msg: ServerMessage = { t: 'table', table: t.view(s.user.id) };
      for (const c of s.clients) c.send(msg);
    }
  }
}
