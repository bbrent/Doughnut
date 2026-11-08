/**
 * Lobby: players, accounts, table codes, quick match, and routing of client
 * messages. Transport-agnostic: a "client" is anything with send(). The
 * WebSocket server (src/server) is a thin wrapper around this.
 *
 * Players start as guests with a nickname; nothing about a guest is saved.
 * A guest can register (set a password for their nickname); from then on
 * their games and rating are saved. Several browser tokens can share one
 * session when the same account logs in on several devices.
 */
import { MODES, mulberry32, randInt, type Rng } from '../engine';
import type { AccountView, ClientMessage, GameRecord, Profile, ServerMessage, TableSettings } from './protocol';
import { Table, TableError, type TableDeps, type User } from './table';

export interface Client {
  send(msg: ServerMessage): void;
}

interface Session {
  user: User;
  account: AccountView | null;
  /** Connected clients and the browser token each one used. */
  clients: Map<Client, string>;
  table: Table | null;
}

export interface AccountInfo {
  id: string;
  nickname: string;
  profile: Profile;
}

/** A problem the player should see (wrong password, nickname taken, ...). */
export class AccountError extends Error {}

/**
 * Accounts and records (the server's MySQL store). Without it, everyone is a
 * guest and nothing is recorded.
 */
export interface Accounts {
  /** The account this browser token is logged in to, if any. */
  sessionAccount(token: string): Promise<AccountInfo | null>;
  isRegistered(nickname: string): Promise<boolean>;
  /** Save `nickname` with a password and log this token in to it. */
  register(token: string, nickname: string, password: string): Promise<AccountInfo>;
  login(token: string, nickname: string, password: string): Promise<AccountInfo>;
  logout(token: string): Promise<void>;
  /** Record a finished game; returns updated profiles by account id. */
  recordGame(record: GameRecord): Promise<Map<string, { profile: Profile; ratingChange: number | null }>>;
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

/** Nicknames: 2-20 letters, digits, spaces and _ . ' - */
export function cleanNickname(name: string): string {
  return name.replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

export class Lobby {
  private sessions = new Map<string, Session>(); // by token
  private byAccount = new Map<string, Session>();
  private tables = new Map<string, Table>();
  private members = new Map<Table, Set<Session>>();
  private queue: { session: Session; mode: string; since: number }[] = [];
  private rng: Rng;
  private guests = 0;
  readonly opts: LobbyOptions;

  constructor(
    private readonly tableDeps: Omit<TableDeps, 'onChange' | 'onGameOver'>,
    opts: Partial<LobbyOptions> = {},
    private readonly accounts: Accounts | null = null,
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

  /**
   * Handle one message from a client. `token` is null until hello. Callers
   * must await each message before passing the next one from the same client.
   */
  async handle(client: Client, token: string | null, msg: ClientMessage): Promise<string | null> {
    try {
      if (msg.t === 'hello') return await this.hello(client, msg.token, msg.name);
      if (!token) throw new TableError('Say hello first');
      const s = this.sessions.get(token)!;
      switch (msg.t) {
        case 'register':
          await this.register(s, token, msg.password);
          break;
        case 'login':
          await this.login(s, token, msg.nickname, msg.password);
          break;
        case 'logout':
          await this.logout(s, token);
          break;
        case 'create':
          this.requireName(s);
          this.create(s, msg.settings);
          break;
        case 'join':
          this.requireName(s);
          this.join(s, msg.code);
          break;
        case 'quick':
          this.requireName(s);
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
      const shown = e instanceof TableError || e instanceof AccountError;
      if (!shown) console.error('lobby error:', e);
      client.send({ t: 'error', message: shown ? (e as Error).message : 'Something went wrong. Please try again.' });
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
      this.queue = this.queue.filter((q) => q.session !== s);
    }
  }

  // ---- identity ----------------------------------------------------------

  private inGame(s: Session) {
    return !!s.table && s.table.status === 'playing';
  }

  private newSession(user: User, account: AccountView | null): Session {
    const s: Session = { user, account, clients: new Map(), table: null };
    if (user.accountId) this.byAccount.set(user.accountId, s);
    return s;
  }

  private guestUser(name: string): User {
    return { id: `g${++this.guests}`, name, accountId: null };
  }

  /** A guest may not use a nickname someone has registered. ('Guest' = not chosen yet.) */
  private async checkGuestName(name: string): Promise<void> {
    if (name === 'Guest') return;
    if (this.accounts && (await this.accounts.isRegistered(name))) {
      throw new AccountError(`"${name}" is a registered nickname. Log in, or pick another.`);
    }
  }

  private send(s: Session, msg: ServerMessage) {
    for (const c of s.clients.keys()) c.send(msg);
  }

  private async hello(client: Client, token: string, name: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new TableError('Bad token');
    const chosen = cleanNickname(name);
    const nick = chosen.length >= 2 ? chosen : 'Guest';
    let s = this.sessions.get(token);
    if (!s) {
      const acct = this.accounts ? await this.accounts.sessionAccount(token) : null;
      if (!acct) await this.checkGuestName(nick);
      s = this.sessions.get(token); // may have been created while we waited
      if (!s) {
        if (acct) {
          s =
            this.byAccount.get(acct.id) ??
            this.newSession({ id: `a${acct.id}`, name: acct.nickname, accountId: acct.id }, { nickname: acct.nickname, profile: acct.profile });
        } else {
          s = this.newSession(this.guestUser(nick), null);
        }
        this.sessions.set(token, s);
      }
    } else if (!s.user.accountId && !this.inGame(s) && nick !== s.user.name) {
      await this.checkGuestName(nick); // a guest changing nickname
      s.user.name = nick;
      if (s.table) this.push(s.table);
    }
    s.clients.set(client, token);
    client.send({ t: 'welcome', name: s.user.name, account: s.account });
    if (s.table) {
      s.table.join(s.user); // reconnect to the same seat
      this.push(s.table);
    }
    return token;
  }

  private requireName(s: Session) {
    if (!s.user.accountId && s.user.name === 'Guest') throw new AccountError('Pick a nickname first');
  }

  private requireAccounts(): Accounts {
    if (!this.accounts) throw new AccountError("Saving progress isn't available here");
    return this.accounts;
  }

  /** Guest -> account: save the current nickname with a password. */
  private async register(s: Session, token: string, password: string): Promise<void> {
    if (s.user.accountId) throw new AccountError("You're already registered");
    this.requireName(s);
    const acct = await this.requireAccounts().register(token, s.user.name, password);
    s.user.accountId = acct.id; // same User object, so a game in progress gets recorded for the account
    s.user.name = acct.nickname;
    s.account = { nickname: acct.nickname, profile: acct.profile };
    this.byAccount.set(acct.id, s);
    this.send(s, { t: 'account', name: s.user.name, account: s.account });
    if (s.table) this.push(s.table);
  }

  private async login(s: Session, token: string, nickname: string, password: string): Promise<void> {
    if (s.user.accountId) throw new AccountError('Log out first');
    if (this.inGame(s)) throw new AccountError('Finish or leave your game before logging in');
    const acct = await this.requireAccounts().login(token, cleanNickname(nickname), password);
    const view = { nickname: acct.nickname, profile: acct.profile };
    const existing = this.byAccount.get(acct.id);
    // This browser's clients (all tabs share the token) move to the account's session.
    const mine = [...s.clients].filter(([, tok]) => tok === token).map(([c]) => c);
    if (existing && existing !== s) {
      this.leave(s, true);
      for (const c of mine) {
        s.clients.delete(c);
        existing.clients.set(c, token);
      }
      this.sessions.set(token, existing);
      for (const c of mine) c.send({ t: 'account', name: existing.user.name, account: existing.account });
      if (existing.table) this.push(existing.table);
      else for (const c of mine) c.send({ t: 'left' });
    } else {
      s.user.accountId = acct.id;
      s.user.name = acct.nickname;
      s.account = view;
      this.byAccount.set(acct.id, s);
      this.send(s, { t: 'account', name: s.user.name, account: s.account });
      if (s.table) this.push(s.table);
    }
  }

  private async logout(s: Session, token: string): Promise<void> {
    if (!s.user.accountId) throw new AccountError("You're not logged in");
    if (this.inGame(s)) throw new AccountError('Finish or leave your game before logging out');
    await this.requireAccounts().logout(token);
    const mine = [...s.clients].filter(([, tok]) => tok === token).map(([c]) => c);
    for (const c of mine) s.clients.delete(c);
    const stillUsed = [...this.sessions.entries()].some(([tok, other]) => other === s && tok !== token);
    if (!stillUsed) {
      this.leave(s, true);
      this.byAccount.delete(s.user.accountId);
    }
    // This browser continues as a guest who still has to pick a nickname.
    const guest = this.newSession(this.guestUser('Guest'), null);
    for (const c of mine) guest.clients.set(c, token);
    this.sessions.set(token, guest);
    for (const c of mine) {
      c.send({ t: 'account', name: '', account: null });
      c.send({ t: 'left' });
    }
  }

  // ---- tables ------------------------------------------------------------

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_CHARS[randInt(this.rng, CODE_CHARS.length)];
      if (!this.tables.has(c)) return c;
    }
  }

  private makeTable(host: User, settings: TableSettings): Table {
    const t = new Table(this.newCode(), host, settings, {
      ...this.tableDeps,
      onChange: (tb) => this.push(tb),
      onGameOver: (tb, rec) => this.gameOver(tb, rec),
    });
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
    this.queue = this.queue.filter((q) => q.session !== s);
    const t = s.table;
    if (!t) return;
    s.table = null;
    this.members.get(t)?.delete(s);
    t.leave(s.user.id);
    if (!quiet) this.send(s, { t: 'left' });
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
    if (!this.queue.some((q) => q.session === s)) this.queue.push({ session: s, mode, since: this.now() });
    this.tick();
    const pos = this.queue.findIndex((q) => q.session === s);
    if (pos >= 0) this.send(s, { t: 'queued', position: pos + 1 });
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
        const sessions = group.map((q) => q.session);
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

  /** Record a finished game (accounts only) and tell its players their new ratings. */
  private gameOver(t: Table, rec: GameRecord): void {
    if (!this.accounts || !rec.seats.some((s) => s.accountId)) return;
    this.accounts
      .recordGame(rec)
      .then((updates) => {
        for (const [id, u] of updates) {
          const s = this.byAccount.get(id);
          if (!s) continue;
          s.account = { nickname: s.user.name, profile: u.profile };
          this.send(s, { t: 'profile', profile: u.profile, ratingChange: u.ratingChange });
        }
      })
      .catch((e) => console.error(`Could not record game ${t.code}:`, e));
  }

  /** Send each seated human their own view of the table. */
  private push(t: Table): void {
    for (const s of this.members.get(t) ?? []) {
      this.send(s, { t: 'table', table: t.view(s.user.id) });
    }
  }
}
