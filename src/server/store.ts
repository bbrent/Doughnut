/**
 * Persistence: accounts (nickname + password), browser sessions, finished
 * games and OpenSkill ratings. Guests are never stored. MySqlStore for
 * production; MemoryStore when no database is configured (and for tests).
 */
import { createHash } from 'node:crypto';
import { ordinal, rate, rating } from 'openskill';
import { AccountError, cleanNickname, type AccountInfo, type Accounts } from '../game/lobby';
import type { GameRecord, Profile } from '../game/protocol';
import { LoginThrottle, checkNewPassword, hashPassword, verifyPassword } from './password';

export interface LeaderRow {
  name: string;
  rating: number;
  games: number;
  wins: number;
}

export interface Store extends Accounts {
  init(): Promise<void>;
  leaderboard(limit: number): Promise<LeaderRow[]>;
  close(): Promise<void>;
}

interface PlayerRow {
  id: number;
  nickname: string;
  password_hash: string;
  mu: number;
  sigma: number;
  games: number;
  wins: number;
  rated_games: number;
}

const DEFAULT = rating();
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const nicknameKey = (n: string) => cleanNickname(n).toLowerCase();

/** Display rating: conservative estimate (mu - 3 sigma), 1000 for a new player. */
export const displayRating = (mu: number, sigma: number) => Math.round(1000 + 40 * ordinal({ mu, sigma }));

function profileOf(p: PlayerRow): Profile {
  return { name: p.nickname, rating: displayRating(p.mu, p.sigma), games: p.games, wins: p.wins };
}
const info = (p: PlayerRow): AccountInfo => ({ id: String(p.id), nickname: p.nickname, profile: profileOf(p) });

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

/** Apply a finished game to account rows (mutates them). Shared by both stores. */
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

function validateRegistration(nickname: string, password: string) {
  const n = cleanNickname(nickname);
  if (n.length < 2) throw new AccountError('Pick a nickname of at least 2 characters');
  if (/^(guest|bot)\b/i.test(n)) throw new AccountError(`"${n}" can't be registered. Pick another nickname.`);
  const bad = checkNewPassword(password);
  if (bad) throw new AccountError(bad);
}

const WRONG = 'Wrong nickname or password';

// ---- in memory -------------------------------------------------------------

export class MemoryStore implements Store {
  private byKey = new Map<string, PlayerRow>();
  private byId = new Map<number, PlayerRow>();
  private sessions = new Map<string, number>(); // token hash -> player id
  private throttle = new LoginThrottle();
  games: GameRecord[] = [];

  async init() {}
  async close() {}

  async sessionAccount(token: string) {
    const id = this.sessions.get(hashToken(token));
    const p = id === undefined ? undefined : this.byId.get(id);
    return p ? info(p) : null;
  }

  async isRegistered(nickname: string) {
    return this.byKey.has(nicknameKey(nickname));
  }

  async register(token: string, nickname: string, password: string) {
    validateRegistration(nickname, password);
    const key = nicknameKey(nickname);
    if (this.byKey.has(key)) throw new AccountError('That nickname is already registered');
    const p: PlayerRow = {
      id: this.byId.size + 1,
      nickname: cleanNickname(nickname),
      password_hash: await hashPassword(password),
      mu: DEFAULT.mu,
      sigma: DEFAULT.sigma,
      games: 0,
      wins: 0,
      rated_games: 0,
    };
    if (this.byKey.has(key)) throw new AccountError('That nickname is already registered');
    this.byKey.set(key, p);
    this.byId.set(p.id, p);
    this.sessions.set(hashToken(token), p.id);
    return info(p);
  }

  async login(token: string, nickname: string, password: string) {
    const key = nicknameKey(nickname);
    const wait = this.throttle.check(key);
    if (wait) throw new AccountError(`Too many attempts. Try again in ${wait} s.`);
    const p = this.byKey.get(key);
    if (!p || !(await verifyPassword(password, p.password_hash))) {
      this.throttle.fail(key);
      throw new AccountError(WRONG);
    }
    this.throttle.success(key);
    this.sessions.set(hashToken(token), p.id);
    return info(p);
  }

  async logout(token: string) {
    this.sessions.delete(hashToken(token));
  }

  async recordGame(rec: GameRecord) {
    this.games.push(rec);
    const rows = new Map<number, PlayerRow>();
    for (const i of accountSeats(rec)) {
      const p = this.byId.get(Number(rec.seats[i].accountId));
      if (p) rows.set(i, p);
    }
    return applyGame(rec, rows).updates;
  }

  async leaderboard(limit: number) {
    return [...this.byId.values()]
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
    nickname VARCHAR(20) NOT NULL,
    nickname_key VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    mu DOUBLE NOT NULL,
    sigma DOUBLE NOT NULL,
    games INT UNSIGNED NOT NULL DEFAULT 0,
    wins INT UNSIGNED NOT NULL DEFAULT 0,
    rated_games INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL,
    UNIQUE KEY uq_nickname (nickname_key),
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

export class MySqlStore implements Store {
  private pool: Pool | null = null;
  private throttle = new LoginThrottle();

  constructor(private readonly config: string | import('mysql2/promise').PoolOptions) {}

  private async db(): Promise<Pool> {
    if (!this.pool) {
      const mysql = await import('mysql2/promise');
      this.pool =
        typeof this.config === 'string'
          ? mysql.createPool({ uri: this.config, connectionLimit: 5, charset: 'utf8mb4' })
          : mysql.createPool({ connectionLimit: 5, charset: 'utf8mb4', ...this.config });
    }
    return this.pool;
  }

  async init() {
    const db = await this.db();
    // The first version stored a player per browser (players.token_hash). Keep
    // that data but move it aside: those players never had passwords.
    const [old] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'players' AND column_name = 'token_hash'`,
    );
    if ((old as { n: number }[])[0].n > 0) {
      await db.query('RENAME TABLE game_players TO game_players_v1, games TO games_v1, players TO players_v1');
      console.log('Moved first-version tables to *_v1 (guest players without passwords)');
    }
    // Foreign key names are unique per database: free the old ones for the new
    // tables (also repairs a migration that stopped part-way).
    const [fks] = await db.query(
      `SELECT constraint_name AS name FROM information_schema.table_constraints
       WHERE table_schema = DATABASE() AND table_name = 'game_players_v1' AND constraint_type = 'FOREIGN KEY'`,
    );
    for (const { name } of fks as { name: string }[]) await db.query(`ALTER TABLE game_players_v1 DROP FOREIGN KEY \`${name}\``);
    for (const sql of SCHEMA) await db.query(sql);
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }

  private async player(where: string, arg: string | number): Promise<PlayerRow | null> {
    const db = await this.db();
    const [rows] = await db.execute(`SELECT * FROM players WHERE ${where}`, [arg]);
    return (rows as PlayerRow[])[0] ?? null;
  }

  async sessionAccount(token: string) {
    const db = await this.db();
    const [rows] = await db.execute(
      'SELECT p.* FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?',
      [hashToken(token)],
    );
    const p = (rows as PlayerRow[])[0];
    if (!p) return null;
    await db.execute('UPDATE sessions SET last_seen = CURRENT_TIMESTAMP WHERE token_hash = ?', [hashToken(token)]);
    return info(p);
  }

  async isRegistered(nickname: string) {
    return (await this.player('nickname_key = ?', nicknameKey(nickname))) !== null;
  }

  private async linkSession(token: string, playerId: number) {
    const db = await this.db();
    await db.execute(
      'INSERT INTO sessions (token_hash, player_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE player_id = VALUES(player_id), last_seen = CURRENT_TIMESTAMP',
      [hashToken(token), playerId],
    );
    await db.execute('UPDATE players SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [playerId]);
  }

  async register(token: string, nickname: string, password: string) {
    validateRegistration(nickname, password);
    const db = await this.db();
    const hash = await hashPassword(password);
    try {
      await db.execute('INSERT INTO players (nickname, nickname_key, password_hash, mu, sigma) VALUES (?, ?, ?, ?, ?)', [
        cleanNickname(nickname),
        nicknameKey(nickname),
        hash,
        DEFAULT.mu,
        DEFAULT.sigma,
      ]);
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw new AccountError('That nickname is already registered');
      throw e;
    }
    const p = (await this.player('nickname_key = ?', nicknameKey(nickname)))!;
    await this.linkSession(token, p.id);
    return info(p);
  }

  async login(token: string, nickname: string, password: string) {
    const key = nicknameKey(nickname);
    const wait = this.throttle.check(key);
    if (wait) throw new AccountError(`Too many attempts. Try again in ${wait} s.`);
    const p = await this.player('nickname_key = ?', key);
    if (!p || !(await verifyPassword(password, p.password_hash))) {
      this.throttle.fail(key);
      throw new AccountError(WRONG);
    }
    this.throttle.success(key);
    await this.linkSession(token, p.id);
    return info(p);
  }

  async logout(token: string) {
    const db = await this.db();
    await db.execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  }

  async recordGame(rec: GameRecord) {
    const db = await this.db();
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const rows = new Map<number, PlayerRow>();
      for (const i of accountSeats(rec)) {
        const [r] = await conn.execute('SELECT * FROM players WHERE id = ? FOR UPDATE', [Number(rec.seats[i].accountId)]);
        const p = (r as PlayerRow[])[0];
        if (p) rows.set(i, p);
      }
      const { rated, seats, updates } = applyGame(rec, rows);
      const humans = rec.seats.filter((s) => s.userId).length;
      const [res] = await conn.execute(
        `INSERT INTO games (table_code, mode, seats, humans, hands, rated, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

  async leaderboard(limit: number) {
    const db = await this.db();
    const [rows] = await db.query(
      `SELECT nickname, mu, sigma, games, wins FROM players WHERE rated_games > 0
       ORDER BY (mu - 3 * sigma) DESC LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`,
    );
    return (rows as PlayerRow[]).map((p) => ({ name: p.nickname, rating: displayRating(p.mu, p.sigma), games: p.games, wins: p.wins }));
  }
}

/** Pick a store from the environment: DATABASE_URL or MYSQL_* variables, else memory. */
export function storeFromEnv(env: NodeJS.ProcessEnv): Store {
  if (env.DATABASE_URL) return new MySqlStore(env.DATABASE_URL);
  if (env.MYSQL_HOST || env.MYSQL_DATABASE) {
    return new MySqlStore({
      host: env.MYSQL_HOST ?? 'localhost',
      port: Number(env.MYSQL_PORT ?? 3306),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
    });
  }
  return new MemoryStore();
}
