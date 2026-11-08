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
import type { AccountView, ClientMessage, FriendView, FriendsView, GameRecord, Profile, ServerMessage, TableSettings } from './protocol';
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
  /**
   * Start a sign-up and email a confirmation link. Returns the pending account
   * id, or null if the email already had an account (its owner is emailed).
   */
  signup(token: string, email: string, nickname: string, password: string): Promise<string | null>;
  resendVerification(email: string): Promise<void>;
  /** Confirm an email from its link; logs this token in. */
  verifyEmail(token: string, code: string): Promise<AccountInfo>;
  /** Log in with email or nickname. */
  login(token: string, login: string, password: string): Promise<AccountInfo>;
  logout(token: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  /** Set a new password from a reset link; logs out other browsers, logs this one in. */
  resetPassword(token: string, code: string, password: string): Promise<AccountInfo>;
  friendLists(accountId: string): Promise<{ friends: FriendRef[]; incoming: FriendRef[]; outgoing: FriendRef[] }>;
  addFriend(accountId: string, nickname: string): Promise<{ other: { id: string; nickname: string }; state: 'requested' | 'accepted' | 'already' }>;
  respondFriend(accountId: string, nickname: string, accept: boolean): Promise<{ id: string; nickname: string }>;
  removeFriend(accountId: string, nickname: string): Promise<{ id: string; nickname: string }>;
  /** Record a finished game; returns updated profiles by account id. */
  recordGame(record: GameRecord): Promise<Map<string, { profile: Profile; ratingChange: number | null }>>;
}

interface FriendRef {
  id: number | string;
  nickname: string;
}

/** A live account's friends: account id -> nickname. */
interface FriendCache {
  friends: Map<string, string>;
  incoming: Map<string, string>;
  outgoing: Map<string, string>;
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
  /** Sessions waiting for their sign-up to be confirmed, by pending account id. */
  private pendingSignup = new Map<string, Session>();
  /** Friends of accounts that have been online, and each account's last broadcast status. */
  private friendCache = new Map<string, FriendCache>();
  private lastPresence = new Map<string, string>();
  private tableKeys = new WeakMap<Table, string>();
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
        case 'signup':
          await this.signup(s, token, msg.email, msg.nickname, msg.password);
          break;
        case 'resend':
          await this.requireAccounts().resendVerification(msg.email);
          client.send({ t: 'notice', kind: 'signup', message: 'If that email is waiting to be confirmed, we sent the link again.' });
          break;
        case 'verify':
          await this.attach(s, token, await this.requireAccounts().verifyEmail(token, msg.code), 'verified');
          break;
        case 'login':
          if (s.user.accountId) throw new AccountError('Log out first');
          if (this.inGame(s)) throw new AccountError('Finish or leave your game before logging in');
          await this.attach(s, token, await this.requireAccounts().login(token, msg.login, msg.password), 'login');
          break;
        case 'forgot':
          await this.requireAccounts().requestPasswordReset(msg.email);
          client.send({ t: 'notice', kind: 'reset', message: "If that email has an account, we've sent a link to choose a new password. It works for 1 hour." });
          break;
        case 'reset': {
          const acct = await this.requireAccounts().resetPassword(token, msg.code, msg.password);
          this.dropOtherDevices(acct.id, token);
          await this.attach(this.sessions.get(token)!, token, acct, 'reset');
          break;
        }
        case 'logout':
          await this.logout(s, token);
          break;
        case 'friendAdd': {
          const me = this.requireAccount(s);
          const r = await this.requireAccounts().addFriend(me, msg.nickname);
          await this.reloadFriends(me, r.other.id);
          const nick = r.other.nickname;
          client.send({
            t: 'toast',
            message: { requested: `Friend request sent to ${nick}`, accepted: `You and ${nick} are now friends`, already: `${nick} is already your friend` }[r.state],
          });
          if (r.state === 'requested') this.sendTo(r.other.id, { t: 'toast', message: `${s.user.name} wants to be friends` });
          if (r.state === 'accepted') this.sendTo(r.other.id, { t: 'toast', message: `You and ${s.user.name} are now friends` });
          break;
        }
        case 'friendRespond': {
          const me = this.requireAccount(s);
          const other = await this.requireAccounts().respondFriend(me, msg.nickname, msg.accept);
          await this.reloadFriends(me, other.id);
          if (msg.accept) {
            client.send({ t: 'toast', message: `You and ${other.nickname} are now friends` });
            this.sendTo(other.id, { t: 'toast', message: `You and ${s.user.name} are now friends` });
          }
          break;
        }
        case 'friendRemove': {
          const me = this.requireAccount(s);
          const other = await this.requireAccounts().removeFriend(me, msg.nickname);
          await this.reloadFriends(me, other.id);
          break;
        }
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
    this.presenceChanged(s.user.accountId);
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
    if (s.user.accountId) await this.friendsOnline(s.user.accountId);
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
  /** Start a sign-up; this browser becomes the account once the email is confirmed. */
  private async signup(s: Session, token: string, email: string, nickname: string, password: string): Promise<void> {
    if (s.user.accountId) throw new AccountError("You're already signed up");
    const pending = await this.requireAccounts().signup(token, email, nickname, password);
    if (pending) this.pendingSignup.set(pending, s);
    this.send(s, {
      t: 'notice',
      kind: 'signup',
      message: `Check your email (${email.trim()}) for a link to confirm your account. Until then you're playing as a guest.`,
    });
  }

  /**
   * Make this browser's session the given account. If the account is already
   * live in another session (another device), this browser joins it.
   */
  private async attach(s: Session, token: string, acct: AccountInfo, why: 'login' | 'verified' | 'reset'): Promise<void> {
    const view = { nickname: acct.nickname, profile: acct.profile };
    const existing = this.byAccount.get(acct.id);
    const mine = [...s.clients].filter(([, tok]) => tok === token).map(([c]) => c);
    if (existing && existing !== s) {
      if (this.inGame(s)) throw new AccountError('Finish or leave your game first');
      this.leave(s, true);
      for (const c of mine) {
        s.clients.delete(c);
        existing.clients.set(c, token);
      }
      this.sessions.set(token, existing);
      for (const c of mine) c.send({ t: 'account', name: existing.user.name, account: existing.account, why });
      if (existing.table) this.push(existing.table);
      else for (const c of mine) c.send({ t: 'left' });
      await this.friendsOnline(acct.id);
      return;
    }
    if (s.user.accountId && s.user.accountId !== acct.id) throw new AccountError('Log out first');
    // Same User object, so a game in progress is recorded for the account.
    s.user.accountId = acct.id;
    if (!this.inGame(s)) s.user.name = acct.nickname;
    s.account = view;
    this.byAccount.set(acct.id, s);
    this.send(s, { t: 'account', name: s.user.name, account: s.account, why });
    if (s.table) this.push(s.table);
    await this.friendsOnline(acct.id);
    // The browser that signed up is logged in too, if it's still here.
    const signedUpFrom = this.pendingSignup.get(acct.id);
    this.pendingSignup.delete(acct.id);
    if (signedUpFrom && signedUpFrom !== s && !signedUpFrom.user.accountId) {
      const tok = [...this.sessions].find(([, v]) => v === signedUpFrom)?.[0];
      if (tok) await this.attachPending(signedUpFrom, tok, s);
    }
  }

  /** Move the session that signed up onto the now-confirmed account's session. */
  private async attachPending(from: Session, token: string, to: Session): Promise<void> {
    if (this.inGame(from)) {
      // Mid-game: the account takes over this seat directly instead.
      from.user.accountId = to.user.accountId;
      from.account = to.account;
      this.send(from, { t: 'account', name: from.user.name, account: from.account, why: 'verified' });
      this.sendFriends(to.user.accountId!);
      return;
    }
    this.leave(from, true);
    for (const [c, tok] of from.clients) to.clients.set(c, tok);
    this.sessions.set(token, to);
    for (const c of from.clients.keys()) {
      c.send({ t: 'account', name: to.user.name, account: to.account, why: 'verified' });
      c.send({ t: 'left' });
    }
    from.clients.clear();
    this.sendFriends(to.user.accountId!);
  }

  /** After a password reset: every other browser on this account becomes a guest. */
  private dropOtherDevices(accountId: string, keepToken: string): void {
    const s = this.byAccount.get(accountId);
    if (!s) return;
    for (const [tok, sess] of [...this.sessions]) {
      if (sess !== s || tok === keepToken) continue;
      const theirs = [...s.clients].filter(([, t]) => t === tok).map(([c]) => c);
      const guest = this.newSession(this.guestUser('Guest'), null);
      for (const c of theirs) {
        s.clients.delete(c);
        guest.clients.set(c, tok);
        c.send({ t: 'account', name: '', account: null, why: 'reset' });
      }
      this.sessions.set(tok, guest);
    }
    this.presenceChanged(accountId);
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
      c.send({ t: 'account', name: '', account: null, why: 'logout' });
      c.send({ t: 'left' });
    }
    this.presenceChanged(s.user.accountId);
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
    this.presenceChanged(s.user.accountId);
  }

  private removeTable(t: Table): void {
    t.close();
    const members = [...(this.members.get(t) ?? [])];
    for (const s of members) s.table = null;
    this.members.delete(t);
    this.tables.delete(t.code);
    for (const s of members) this.presenceChanged(s.user.accountId);
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
    this.presenceChanged(s.user.accountId);
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
        // Every live session on the account (e.g. a device that confirmed mid-game).
        for (const s of new Set(this.sessions.values())) {
          const u = s.user.accountId ? updates.get(s.user.accountId) : undefined;
          if (!u) continue;
          s.account = { nickname: s.account?.nickname ?? s.user.name, profile: u.profile };
          this.send(s, { t: 'profile', profile: u.profile, ratingChange: u.ratingChange });
        }
      })
      .catch((e) => console.error(`Could not record game ${t.code}:`, e));
  }

  /** Send each seated human their own view of the table. */
  private push(t: Table): void {
    const members = this.members.get(t) ?? new Set<Session>();
    for (const s of members) this.send(s, { t: 'table', table: t.view(s.user.id) });
    // Friends only see status, players and free seats: skip the check on ordinary moves.
    const key = `${t.status}|${t.humanCount()}|${t.joinable()}|${members.size}`;
    if (this.tableKeys.get(t) !== key) {
      this.tableKeys.set(t, key);
      for (const s of members) this.presenceChanged(s.user.accountId);
    }
  }

  // ---- friends -------------------------------------------------------------

  private requireAccount(s: Session): string {
    if (!s.user.accountId) throw new AccountError('Sign up to add friends');
    return s.user.accountId;
  }

  /** All sessions on an account (several when it confirmed on another device mid-game). */
  private sessionsOf(accountId: string): Session[] {
    return [...new Set(this.sessions.values())].filter((s) => s.user.accountId === accountId);
  }

  private sendTo(accountId: string, msg: ServerMessage): void {
    for (const s of this.sessionsOf(accountId)) this.send(s, msg);
  }

  /** What an account is doing, as its friends see it. */
  private presenceOf(accountId: string): Omit<FriendView, 'nickname'> {
    const live = this.sessionsOf(accountId).filter((s) => s.clients.size > 0);
    if (!live.length) return { status: 'offline', table: null };
    const atTable = live.find((s) => s.table?.status === 'playing') ?? live.find((s) => s.table);
    if (atTable?.table) {
      const t = atTable.table;
      return {
        status: t.status,
        table: { code: t.code, mode: t.settings.mode, seats: t.settings.seats, humans: t.humanCount(), joinable: t.joinable() },
      };
    }
    if (live.some((s) => this.queue.some((q) => q.session === s))) return { status: 'queue', table: null };
    return { status: 'online', table: null };
  }

  private async loadFriends(accountId: string): Promise<void> {
    if (!this.accounts) return;
    const l = await this.accounts.friendLists(accountId);
    const toMap = (refs: FriendRef[]) => new Map(refs.map((r) => [String(r.id), r.nickname]));
    this.friendCache.set(accountId, { friends: toMap(l.friends), incoming: toMap(l.incoming), outgoing: toMap(l.outgoing) });
  }

  private sendFriends(accountId: string): void {
    const c = this.friendCache.get(accountId);
    if (!c) return;
    const order = { playing: 0, lobby: 0, over: 1, queue: 2, online: 3, offline: 4 };
    const friends = [...c.friends].map(([id, nickname]) => ({ nickname, ...this.presenceOf(id) }));
    friends.sort((a, b) => order[a.status] - order[b.status] || a.nickname.localeCompare(b.nickname));
    const view: FriendsView = { friends, incoming: [...c.incoming.values()], outgoing: [...c.outgoing.values()] };
    this.sendTo(accountId, { t: 'friends', friends: view });
  }

  /** An account came online: load its friends, send them, and tell its friends. */
  private async friendsOnline(accountId: string): Promise<void> {
    if (!this.friendCache.has(accountId)) await this.loadFriends(accountId);
    this.sendFriends(accountId);
    this.presenceChanged(accountId);
  }

  /** After a friend request etc.: refresh both sides' lists. */
  private async reloadFriends(...ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!this.sessionsOf(id).length && !this.friendCache.has(id)) continue;
      await this.loadFriends(id);
      this.sendFriends(id);
    }
  }

  /** If an account's status changed, update the lists of its friends who are online. */
  private presenceChanged(accountId: string | null): void {
    if (!accountId || !this.friendCache.has(accountId)) return;
    const key = JSON.stringify(this.presenceOf(accountId));
    if (this.lastPresence.get(accountId) === key) return;
    this.lastPresence.set(accountId, key);
    for (const friendId of this.friendCache.get(accountId)!.friends.keys()) {
      if (this.sessionsOf(friendId).some((s) => s.clients.size > 0)) this.sendFriends(friendId);
    }
  }
}
