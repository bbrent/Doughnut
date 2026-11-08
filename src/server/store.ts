/**
 * Data access: accounts, browser sessions, one-time email links, finished
 * games and ratings. MySqlRepo for production; MemoryRepo when no database is
 * configured (and for tests). The sign-up / login / recovery rules live in
 * accounts.ts on top of this.
 */
import { createHash } from 'node:crypto';
import { ordinal, rate, rating } from 'openskill';
import { cleanNickname } from '../game/lobby';
import type { GameRecord, Profile } from '../game/protocol';

export interface LeaderRow {
  name: string;
  rating: number;
  games: number;
  wins: number;
}

export interface PlayerRow {
  id: number;
  email: string | null;
  nickname: string;
  password_hash: string;
  /** null until the email address is confirmed. */
  verified_at: Date | null;
  created_at: Date;
  mu: number;
  sigma: number;
  games: number;
  wins: number;
  rated_games: number;
}

export type LinkPurpose = 'verify' | 'reset';

export interface NewAccount {
  email: string;
  nickname: string;
  passwordHash: string;
}

export interface Repo {
  init(): Promise<void>;
  close(): Promise<void>;
  byId(id: number): Promise<PlayerRow | null>;
  byEmail(email: string): Promise<PlayerRow | null>;
  byNickname(nickname: string): Promise<PlayerRow | null>;
  /** Returns the new id, or which unique field clashed. */
  createAccount(a: NewAccount): Promise<number | 'email' | 'nickname'>;
  deleteAccount(id: number): Promise<void>;
  /** Remove accounts never verified within `maxAgeMs`, freeing their email and nickname. */
  purgeUnverified(maxAgeMs: number): Promise<void>;
  markVerified(id: number): Promise<void>;
  setPassword(id: number, hash: string): Promise<void>;
  sessionPlayer(tokenHash: string): Promise<PlayerRow | null>;
  linkSession(tokenHash: string, playerId: number): Promise<void>;
  unlinkSession(tokenHash: string): Promise<void>;
  unlinkAllSessions(playerId: number): Promise<void>;
  addLink(codeHash: string, playerId: number, purpose: LinkPurpose, expiresAt: Date): Promise<void>;
  /** Use a link once: returns its player if valid, unused and unexpired. */
  consumeLink(codeHash: string, purpose: LinkPurpose): Promise<number | null>;
  /** Invalidate a player's unused links of one kind (e.g. after a reset). */
  dropLinks(playerId: number, purpose: LinkPurpose): Promise<void>;
  recordGame(rec: GameRecord): Promise<Map<string, { profile: Profile; ratingChange: number | null }>>;
  leaderboard(limit: number): Promise<LeaderRow[]>;
  /** Accepted friends, requests to this player, and requests from them. */
  friendLists(playerId: number): Promise<FriendLists>;
  /** Ask `to` to be friends; accepts at once if `to` had already asked `from`. */
  requestFriend(from: number, to: number): Promise<'requested' | 'accepted' | 'already'>;
  /** Accept a pending request from `requester`. Returns false if there was none. */
  acceptFriend(requester: number, me: number): Promise<boolean>;
  /** Remove a friendship or a request, in either direction. */
  removeFriendship(a: number, b: number): Promise<void>;
}

export interface FriendRef {
  id: number;
  nickname: string;
}
export interface FriendLists {
  friends: FriendRef[];
  incoming: FriendRef[];
  outgoing: FriendRef[];
}

const DEFAULT = rating();
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const nicknameKey = (n: string) => cleanNickname(n).toLowerCase();
export const emailKey = (e: string) => e.trim().toLowerCase();

/** Display rating: conservative estimate (mu - 3 sigma), 1000 for a new player. */
export const displayRating = (mu: number, sigma: number) => Math.round(1000 + 40 * ordinal({ mu, sigma }));

export function profileOf(p: PlayerRow): Profile {
  return { name: p.nickname, rating: displayRating(p.mu, p.sigma), games: p.games, wins: p.wins };
}

/**
 * Places for a finished game: lower score is better, equal scores share a
 * place, and humans who left early come last.
 */
export function places(rec: GameRecord): number[] {
  const key = (i: number) => (rec.seats[i].leftEarly ? 1e9 : rec.seats[i].finalScore);
  return rec.seats.map((_, i) => 1 + rec.seats.filter((_, j) => key(j) < key(i)).length);
}

/** Seats played by registered accounts. Ratings are only updated with two or more. */
const accountSeats = (rec: GameRecord) => rec.seats.flatMap((s, i) => (s.accountId ? [i] : []));

/** New (mu, sigma) for each account seat, or null when the game isn't rated. */
export function rateGame(rec: GameRecord, current: Map<number, { mu: number; sigma: number }>) {
  const seats = accountSeats(rec);
  if (seats.length < 2) return null;
  const pl = places(rec);
  const teams = seats.map((i) => [rating(current.get(i) ?? DEFAULT)]);
  const out = rate(teams, { rank: seats.map((i) => pl[i]) });
  return new Map(seats.map((i, k) => [i, out[k][0]]));
}

/** Apply a finished game to account rows (mutates them). Shared by both repos. */
function applyGame(rec: GameRecord, rows: Map<number, PlayerRow>) {
  const rated = rateGame(rec, new Map([...rows].map(([i, p]) => [i, { mu: p.mu, sigma: p.sigma }])));
  const pl = places(rec);
  const seats = rec.seats.map((seat, i) => {
    const p = rows.get(i);
    const won = rec.winners.includes(i) && !seat.leftEarly;
    const before = p ? displayRating(p.mu, p.sigma) : null;
    const r = rated?.get(i);
    if (p) {
      p.games++;
      if (won) p.wins++;
      if (r) {
        p.mu = r.mu;
        p.sigma = r.sigma;
        p.rated_games++;
      }
    }
    const after = p ? displayRating(p.mu, p.sigma) : null;
    return { i, p, won, place: pl[i], before, after, rated: !!r };
  });
  const updates = new Map<string, { profile: Profile; ratingChange: number | null }>();
  for (const x of seats) {
    if (x.p) updates.set(String(x.p.id), { profile: profileOf(x.p), ratingChange: x.rated ? x.after! - x.before! : null });
  }
  return { rated: !!rated, seats, updates };
}

/** Only verified accounts' games are recorded. */
const verifiedRows = async (rec: GameRecord, load: (id: number) => Promise<PlayerRow | null>) => {
  const rows = new Map<number, PlayerRow>();
  for (const i of accountSeats(rec)) {
    const p = await load(Number(rec.seats[i].accountId));
    if (p?.verified_at) rows.set(i, p);
  }
  return rows;
};

// ---- in memory -------------------------------------------------------------

export class MemoryRepo implements Repo {
  private players = new Map<number, PlayerRow>();
  private sessions = new Map<string, number>();
  private links = new Map<string, { playerId: number; purpose: LinkPurpose; expiresAt: Date; used: boolean }>();
  private nextId = 1;
  /** "from>to" -> status. Accepted friendships are stored in both directions. */
  private friendships = new Map<string, 'pending' | 'accepted'>();
  games: GameRecord[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  async init() {}
  async close() {}

  async byId(id: number) {
    return this.players.get(id) ?? null;
  }
  async byEmail(email: string) {
    const k = emailKey(email);
    return [...this.players.values()].find((p) => p.email !== null && emailKey(p.email) === k) ?? null;
  }
  async byNickname(nickname: string) {
    const k = nicknameKey(nickname);
    return [...this.players.values()].find((p) => nicknameKey(p.nickname) === k) ?? null;
  }
  async createAccount(a: NewAccount) {
    if (await this.byEmail(a.email)) return 'email' as const;
    if (await this.byNickname(a.nickname)) return 'nickname' as const;
    const id = this.nextId++;
    this.players.set(id, {
      id,
      email: a.email.trim(),
      nickname: cleanNickname(a.nickname),
      password_hash: a.passwordHash,
      verified_at: null,
      created_at: new Date(this.now()),
      mu: DEFAULT.mu,
      sigma: DEFAULT.sigma,
      games: 0,
      wins: 0,
      rated_games: 0,
    });
    return id;
  }
  async deleteAccount(id: number) {
    this.players.delete(id);
    for (const [k, v] of this.sessions) if (v === id) this.sessions.delete(k);
    for (const k of [...this.friendships.keys()]) if (k.split('>').map(Number).includes(id)) this.friendships.delete(k);
  }
  async purgeUnverified(maxAgeMs: number) {
    for (const p of [...this.players.values()]) {
      if (!p.verified_at && this.now() - p.created_at.getTime() > maxAgeMs) await this.deleteAccount(p.id);
    }
  }
  async markVerified(id: number) {
    const p = this.players.get(id);
    if (p && !p.verified_at) p.verified_at = new Date(this.now());
  }
  async setPassword(id: number, hash: string) {
    const p = this.players.get(id);
    if (p) p.password_hash = hash;
  }
  async sessionPlayer(tokenHash: string) {
    const id = this.sessions.get(tokenHash);
    return id === undefined ? null : (this.players.get(id) ?? null);
  }
  async linkSession(tokenHash: string, playerId: number) {
    this.sessions.set(tokenHash, playerId);
  }
  async unlinkSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
  async unlinkAllSessions(playerId: number) {
    for (const [k, v] of this.sessions) if (v === playerId) this.sessions.delete(k);
  }
  async addLink(codeHash: string, playerId: number, purpose: LinkPurpose, expiresAt: Date) {
    this.links.set(codeHash, { playerId, purpose, expiresAt, used: false });
  }
  async consumeLink(codeHash: string, purpose: LinkPurpose) {
    const l = this.links.get(codeHash);
    if (!l || l.used || l.purpose !== purpose || l.expiresAt.getTime() < this.now() || !this.players.has(l.playerId)) return null;
    l.used = true;
    return l.playerId;
  }
  async dropLinks(playerId: number, purpose: LinkPurpose) {
    for (const l of this.links.values()) if (l.playerId === playerId && l.purpose === purpose) l.used = true;
  }
  async recordGame(rec: GameRecord) {
    const rows = await verifiedRows(rec, (id) => this.byId(id));
    if (!rows.size) return new Map();
    this.games.push(rec);
    return applyGame(rec, rows).updates;
  }
  async friendLists(playerId: number) {
    const ref = (id: number): FriendRef => ({ id, nickname: this.players.get(id)!.nickname });
    const out: FriendLists = { friends: [], incoming: [], outgoing: [] };
    for (const [k, status] of this.friendships) {
      const [a, b] = k.split('>').map(Number);
      if (!this.players.has(a) || !this.players.has(b)) continue;
      if (a === playerId) (status === 'accepted' ? out.friends : out.outgoing).push(ref(b));
      else if (b === playerId && status === 'pending') out.incoming.push(ref(a));
    }
    return out;
  }
  async requestFriend(from: number, to: number) {
    const mine = this.friendships.get(`${from}>${to}`);
    if (mine === 'accepted') return 'already' as const;
    if (this.friendships.get(`${to}>${from}`) === 'pending') {
      await this.acceptFriend(to, from);
      return 'accepted' as const;
    }
    this.friendships.set(`${from}>${to}`, 'pending');
    return 'requested' as const;
  }
  async acceptFriend(requester: number, me: number) {
    if (this.friendships.get(`${requester}>${me}`) !== 'pending') return false;
    this.friendships.set(`${requester}>${me}`, 'accepted');
    this.friendships.set(`${me}>${requester}`, 'accepted');
    return true;
  }
  async removeFriendship(a: number, b: number) {
    this.friendships.delete(`${a}>${b}`);
    this.friendships.delete(`${b}>${a}`);
  }
  async leaderboard(limit: number) {
    return [...this.players.values()]
      .filter((p) => p.rated_games > 0)
      .map((p) => ({ name: p.nickname, rating: displayRating(p.mu, p.sigma), games: p.games, wins: p.wins }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }
}

// ---- MySQL -------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(254) NULL,
    email_key VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    nickname VARCHAR(20) NOT NULL,
    nickname_key VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    verified_at DATETIME NULL,
    mu DOUBLE NOT NULL,
    sigma DOUBLE NOT NULL,
    games INT UNSIGNED NOT NULL DEFAULT 0,
    wins INT UNSIGNED NOT NULL DEFAULT 0,
    rated_games INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL,
    UNIQUE KEY uq_nickname (nickname_key),
    UNIQUE KEY uq_email (email_key),
    KEY ix_rating (rated_games, mu)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_player (player_id),
    CONSTRAINT fk_session_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS email_links (
    code_hash CHAR(64) NOT NULL PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    purpose ENUM('verify', 'reset') NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_player (player_id),
    CONSTRAINT fk_link_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS friendships (
    player_id INT UNSIGNED NOT NULL,
    friend_id INT UNSIGNED NOT NULL,
    status ENUM('pending', 'accepted') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (player_id, friend_id),
    KEY ix_friend (friend_id),
    CONSTRAINT fk_fr_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
    CONSTRAINT fk_fr_friend FOREIGN KEY (friend_id) REFERENCES players (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS games (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    table_code CHAR(5) NOT NULL,
    mode VARCHAR(32) NOT NULL,
    seats TINYINT UNSIGNED NOT NULL,
    humans TINYINT UNSIGNED NOT NULL,
    hands SMALLINT UNSIGNED NOT NULL,
    rated BOOLEAN NOT NULL,
    started_at DATETIME NOT NULL,
    ended_at DATETIME NOT NULL,
    KEY ix_ended (ended_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS game_players (
    game_id INT UNSIGNED NOT NULL,
    seat TINYINT UNSIGNED NOT NULL,
    player_id INT UNSIGNED NULL,
    kind ENUM('account', 'guest', 'bot') NOT NULL,
    bot_level VARCHAR(10) NULL,
    name VARCHAR(40) NOT NULL,
    final_score SMALLINT NOT NULL,
    place TINYINT UNSIGNED NOT NULL,
    won BOOLEAN NOT NULL,
    left_early BOOLEAN NOT NULL,
    rating_before SMALLINT NULL,
    rating_after SMALLINT NULL,
    PRIMARY KEY (game_id, seat),
    KEY ix_player (player_id),
    CONSTRAINT fk_gp_game FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE,
    CONSTRAINT fk_gp_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

type Pool = import('mysql2/promise').Pool;
type Queryable = Pick<Pool, 'query' | 'execute'>;

async function columnExists(db: Queryable, table: string, column: string) {
  const [r] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return (r as { n: number }[])[0].n > 0;
}

export class MySqlRepo implements Repo {
  private pool: Pool | null = null;

  constructor(private readonly config: string | import('mysql2/promise').PoolOptions) {}

  private async db(): Promise<Pool> {
    if (!this.pool) {
      const mysql = await import('mysql2/promise');
      const base = { connectionLimit: 5, charset: 'utf8mb4', timezone: 'Z' as const };
      this.pool = typeof this.config === 'string' ? mysql.createPool({ uri: this.config, ...base }) : mysql.createPool({ ...base, ...this.config });
      // Work in UTC whatever the server's time zone, so expiry checks line up.
      this.pool.on('connection', (c) => void c.query("SET time_zone = '+00:00'"));
    }
    return this.pool;
  }

  async init() {
    const db = await this.db();
    // v1 stored a player per browser (players.token_hash) with no password: keep it aside.
    if (await columnExists(db, 'players', 'token_hash')) {
      await db.query('RENAME TABLE game_players TO game_players_v1, games TO games_v1, players TO players_v1');
      console.log('Moved first-version tables to *_v1 (guest players without passwords)');
    }
    // Foreign key names are unique per database: free the old ones for the new tables.
    const [fks] = await db.query(
      `SELECT constraint_name AS name FROM information_schema.table_constraints
       WHERE table_schema = DATABASE() AND table_name = 'game_players_v1' AND constraint_type = 'FOREIGN KEY'`,
    );
    for (const { name } of fks as { name: string }[]) await db.query(`ALTER TABLE game_players_v1 DROP FOREIGN KEY \`${name}\``);
    // v2 accounts had a nickname and password but no email: add the columns and treat them as verified.
    if ((await columnExists(db, 'players', 'nickname')) && !(await columnExists(db, 'players', 'email'))) {
      await db.query(`ALTER TABLE players
        ADD COLUMN email VARCHAR(254) NULL AFTER id,
        ADD COLUMN email_key VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER email,
        ADD COLUMN verified_at DATETIME NULL AFTER password_hash,
        ADD UNIQUE KEY uq_email (email_key)`);
      await db.query('UPDATE players SET verified_at = created_at WHERE verified_at IS NULL');
      console.log('Added email columns to players (existing accounts log in by nickname)');
    }
    for (const sql of SCHEMA) await db.query(sql);
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }

  private async one(sql: string, args: (string | number)[]): Promise<PlayerRow | null> {
    const [rows] = await (await this.db()).execute(sql, args);
    return (rows as PlayerRow[])[0] ?? null;
  }

  byId(id: number) {
    return this.one('SELECT * FROM players WHERE id = ?', [id]);
  }
  byEmail(email: string) {
    return this.one('SELECT * FROM players WHERE email_key = ?', [emailKey(email)]);
  }
  byNickname(nickname: string) {
    return this.one('SELECT * FROM players WHERE nickname_key = ?', [nicknameKey(nickname)]);
  }

  async createAccount(a: NewAccount) {
    try {
      const [res] = await (await this.db()).execute(
        `INSERT INTO players (email, email_key, nickname, nickname_key, password_hash, mu, sigma) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [a.email.trim(), emailKey(a.email), cleanNickname(a.nickname), nicknameKey(a.nickname), a.passwordHash, DEFAULT.mu, DEFAULT.sigma],
      );
      return (res as { insertId: number }).insertId;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'ER_DUP_ENTRY') return err.message?.includes('uq_email') ? ('email' as const) : ('nickname' as const);
      throw e;
    }
  }
  async deleteAccount(id: number) {
    await (await this.db()).execute('DELETE FROM players WHERE id = ?', [id]);
  }
  async purgeUnverified(maxAgeMs: number) {
    await (await this.db()).execute('DELETE FROM players WHERE verified_at IS NULL AND created_at < ?', [new Date(Date.now() - maxAgeMs)]);
  }
  async markVerified(id: number) {
    await (await this.db()).execute('UPDATE players SET verified_at = COALESCE(verified_at, UTC_TIMESTAMP()) WHERE id = ?', [id]);
  }
  async setPassword(id: number, hash: string) {
    await (await this.db()).execute('UPDATE players SET password_hash = ? WHERE id = ?', [hash, id]);
  }
  async sessionPlayer(tokenHash: string) {
    const p = await this.one('SELECT p.* FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?', [tokenHash]);
    if (p) await (await this.db()).execute('UPDATE sessions SET last_seen = CURRENT_TIMESTAMP WHERE token_hash = ?', [tokenHash]);
    return p;
  }
  async linkSession(tokenHash: string, playerId: number) {
    const db = await this.db();
    await db.execute(
      'INSERT INTO sessions (token_hash, player_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE player_id = VALUES(player_id), last_seen = CURRENT_TIMESTAMP',
      [tokenHash, playerId],
    );
    await db.execute('UPDATE players SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [playerId]);
  }
  async unlinkSession(tokenHash: string) {
    await (await this.db()).execute('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }
  async unlinkAllSessions(playerId: number) {
    await (await this.db()).execute('DELETE FROM sessions WHERE player_id = ?', [playerId]);
  }
  async addLink(codeHash: string, playerId: number, purpose: LinkPurpose, expiresAt: Date) {
    await (await this.db()).execute('INSERT INTO email_links (code_hash, player_id, purpose, expires_at) VALUES (?, ?, ?, ?)', [
      codeHash,
      playerId,
      purpose,
      expiresAt,
    ]);
  }
  async consumeLink(codeHash: string, purpose: LinkPurpose) {
    const db = await this.db();
    // Single statement so a link can't be used twice even with concurrent requests.
    const [res] = await db.execute(
      'UPDATE email_links SET used_at = UTC_TIMESTAMP() WHERE code_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()',
      [codeHash, purpose],
    );
    if ((res as { affectedRows: number }).affectedRows !== 1) return null;
    const [rows] = await db.execute('SELECT player_id FROM email_links WHERE code_hash = ?', [codeHash]);
    return (rows as { player_id: number }[])[0]?.player_id ?? null;
  }
  async dropLinks(playerId: number, purpose: LinkPurpose) {
    await (await this.db()).execute('UPDATE email_links SET used_at = UTC_TIMESTAMP() WHERE player_id = ? AND purpose = ? AND used_at IS NULL', [
      playerId,
      purpose,
    ]);
  }

  async recordGame(rec: GameRecord) {
    const db = await this.db();
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const rows = await verifiedRows(rec, async (id) => {
        const [r] = await conn.execute('SELECT * FROM players WHERE id = ? FOR UPDATE', [id]);
        return (r as PlayerRow[])[0] ?? null;
      });
      if (!rows.size) {
        await conn.rollback();
        return new Map();
      }
      const { rated, seats, updates } = applyGame(rec, rows);
      const humans = rec.seats.filter((s) => s.userId).length;
      const [res] = await conn.execute(
        `INSERT INTO games (table_code, mode, seats, humans, hands, rated, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [rec.code, rec.mode, rec.seats.length, humans, rec.hands, rated ? 1 : 0, new Date(rec.startedAt), new Date(rec.endedAt)],
      );
      const gameId = (res as { insertId: number }).insertId;
      for (const x of seats) {
        const seat = rec.seats[x.i];
        const kind = x.p ? 'account' : seat.userId ? 'guest' : 'bot';
        await conn.execute(
          `INSERT INTO game_players (game_id, seat, player_id, kind, bot_level, name, final_score, place, won, left_early, rating_before, rating_after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          // Guests are recorded only as "Guest": nothing that identifies them is kept.
          [gameId, x.i, x.p?.id ?? null, kind, seat.botLevel, kind === 'guest' ? 'Guest' : seat.name.slice(0, 40), seat.finalScore, x.place, x.won ? 1 : 0, seat.leftEarly ? 1 : 0, x.before, x.after],
        );
        if (x.p) {
          await conn.execute('UPDATE players SET mu = ?, sigma = ?, games = ?, wins = ?, rated_games = ? WHERE id = ?', [
            x.p.mu,
            x.p.sigma,
            x.p.games,
            x.p.wins,
            x.p.rated_games,
            x.p.id,
          ]);
        }
      }
      await conn.commit();
      return updates;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async friendLists(playerId: number) {
    const db = await this.db();
    const [mine] = await db.execute(
      `SELECT f.status, p.id, p.nickname FROM friendships f JOIN players p ON p.id = f.friend_id WHERE f.player_id = ? ORDER BY p.nickname`,
      [playerId],
    );
    const [theirs] = await db.execute(
      `SELECT p.id, p.nickname FROM friendships f JOIN players p ON p.id = f.player_id
       WHERE f.friend_id = ? AND f.status = 'pending' ORDER BY p.nickname`,
      [playerId],
    );
    const rows = mine as (FriendRef & { status: string })[];
    const ref = (r: FriendRef) => ({ id: r.id, nickname: r.nickname });
    return {
      friends: rows.filter((r) => r.status === 'accepted').map(ref),
      outgoing: rows.filter((r) => r.status === 'pending').map(ref),
      incoming: (theirs as FriendRef[]).map(ref),
    };
  }
  async requestFriend(from: number, to: number) {
    const db = await this.db();
    const [r] = await db.execute('SELECT status FROM friendships WHERE player_id = ? AND friend_id = ?', [from, to]);
    if ((r as { status: string }[])[0]?.status === 'accepted') return 'already' as const;
    if (await this.acceptFriend(to, from)) return 'accepted' as const;
    await db.execute("INSERT IGNORE INTO friendships (player_id, friend_id, status) VALUES (?, ?, 'pending')", [from, to]);
    return 'requested' as const;
  }
  async acceptFriend(requester: number, me: number) {
    const db = await this.db();
    const [res] = await db.execute(
      "UPDATE friendships SET status = 'accepted' WHERE player_id = ? AND friend_id = ? AND status = 'pending'",
      [requester, me],
    );
    if ((res as { affectedRows: number }).affectedRows !== 1) return false;
    await db.execute(
      "INSERT INTO friendships (player_id, friend_id, status) VALUES (?, ?, 'accepted') ON DUPLICATE KEY UPDATE status = 'accepted'",
      [me, requester],
    );
    return true;
  }
  async removeFriendship(a: number, b: number) {
    await (await this.db()).execute('DELETE FROM friendships WHERE (player_id = ? AND friend_id = ?) OR (player_id = ? AND friend_id = ?)', [a, b, b, a]);
  }

  async leaderboard(limit: number) {
    const [rows] = await (await this.db()).query(
      `SELECT nickname, mu, sigma, games, wins FROM players WHERE rated_games > 0 AND verified_at IS NOT NULL
       ORDER BY (mu - 3 * sigma) DESC LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`,
    );
    return (rows as PlayerRow[]).map((p) => ({ name: p.nickname, rating: displayRating(p.mu, p.sigma), games: p.games, wins: p.wins }));
  }
}
