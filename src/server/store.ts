/**
 * Persistence: players (by hashed browser token), finished games, and
 * OpenSkill ratings. MySqlStore for production; MemoryStore when no database
 * is configured (and for tests).
 */
import { createHash } from 'node:crypto';
import { ordinal, rate, rating } from 'openskill';
import type { Accounts } from '../game/lobby';
import type { GameRecord, Profile } from '../game/protocol';

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
  name: string;
  mu: number;
  sigma: number;
  games: number;
  wins: number;
  rated_games: number;
}

const DEFAULT = rating();
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Display rating: conservative estimate (mu - 3 sigma), 1000 for a new player. */
export const displayRating = (mu: number, sigma: number) => Math.round(1000 + 40 * ordinal({ mu, sigma }));

function profileOf(p: PlayerRow): Profile {
  return { name: p.name, rating: displayRating(p.mu, p.sigma), games: p.games, wins: p.wins };
}

/**
 * Places for a finished game: lower score is better, equal scores share a
 * place, and humans who left early come last.
 */
export function places(rec: GameRecord): number[] {
  const key = (i: number) => (rec.seats[i].leftEarly ? 1e9 : rec.seats[i].finalScore);
  return rec.seats.map((_, i) => 1 + rec.seats.filter((_, j) => key(j) < key(i)).length);
}

/** Humans who started the game. Ratings are only updated with two or more. */
const humanSeats = (rec: GameRecord) => rec.seats.flatMap((s, i) => (s.userId ? [i] : []));

/** New (mu, sigma) for each human seat, or null when the game isn't rated. */
export function rateGame(rec: GameRecord, current: Map<number, { mu: number; sigma: number }>) {
  const seats = humanSeats(rec);
  if (seats.length < 2) return null;
  const pl = places(rec);
  const teams = seats.map((i) => [rating(current.get(i) ?? DEFAULT)]);
  const out = rate(teams, { rank: seats.map((i) => pl[i]) });
  return new Map(seats.map((i, k) => [i, out[k][0]]));
}

// ---- in memory -------------------------------------------------------------

export class MemoryStore implements Store {
  private players = new Map<string, PlayerRow>(); // by token hash
  private byId = new Map<number, PlayerRow>();
  games: GameRecord[] = [];

  async init() {}
  async close() {}

  async identify(token: string, name: string) {
    const h = hashToken(token);
    let p = this.players.get(h);
    if (!p) {
      p = { id: this.players.size + 1, name, mu: DEFAULT.mu, sigma: DEFAULT.sigma, games: 0, wins: 0, rated_games: 0 };
      this.players.set(h, p);
      this.byId.set(p.id, p);
    }
    p.name = name;
    return { id: String(p.id), profile: profileOf(p) };
  }

  async recordGame(rec: GameRecord) {
    this.games.push(rec);
    const seats = humanSeats(rec);
    const rows = new Map(seats.map((i) => [i, this.byId.get(Number(rec.seats[i].userId))!]));
    const rated = rateGame(rec, new Map([...rows].map(([i, p]) => [i, { mu: p.mu, sigma: p.sigma }])));
    const out = new Map<string, { profile: Profile; ratingChange: number | null }>();
    for (const [i, p] of rows) {
      const before = displayRating(p.mu, p.sigma);
      p.games++;
      if (rec.winners.includes(i) && !rec.seats[i].leftEarly) p.wins++;
      const r = rated?.get(i);
      if (r) {
        p.mu = r.mu;
        p.sigma = r.sigma;
        p.rated_games++;
      }
      out.set(String(p.id), { profile: profileOf(p), ratingChange: r ? displayRating(p.mu, p.sigma) - before : null });
    }
    return out;
  }

  async leaderboard(limit: number) {
    return [...this.byId.values()]
      .filter((p) => p.rated_games > 0)
      .map((p) => ({ name: p.name, rating: displayRating(p.mu, p.sigma), games: p.games, wins: p.wins }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }
}

// ---- MySQL -------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    name VARCHAR(40) NOT NULL,
    mu DOUBLE NOT NULL,
    sigma DOUBLE NOT NULL,
    games INT UNSIGNED NOT NULL DEFAULT 0,
    wins INT UNSIGNED NOT NULL DEFAULT 0,
    rated_games INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_token (token_hash),
    KEY ix_rating (rated_games, mu)
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
    for (const sql of SCHEMA) await db.query(sql);
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }

  async identify(token: string, name: string) {
    const db = await this.db();
    const h = hashToken(token);
    await db.execute(
      `INSERT INTO players (token_hash, name, mu, sigma) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), last_seen = CURRENT_TIMESTAMP`,
      [h, name, DEFAULT.mu, DEFAULT.sigma],
    );
    const [rows] = await db.execute('SELECT * FROM players WHERE token_hash = ?', [h]);
    const p = (rows as PlayerRow[])[0];
    return { id: String(p.id), profile: profileOf(p) };
  }

  async recordGame(rec: GameRecord) {
    const db = await this.db();
    const conn = await db.getConnection();
    const out = new Map<string, { profile: Profile; ratingChange: number | null }>();
    try {
      await conn.beginTransaction();
      const seats = humanSeats(rec);
      const rows = new Map<number, PlayerRow>();
      for (const i of seats) {
        const [r] = await conn.execute('SELECT * FROM players WHERE id = ? FOR UPDATE', [Number(rec.seats[i].userId)]);
        const p = (r as PlayerRow[])[0];
        if (p) rows.set(i, p);
      }
      const rated = rateGame(rec, new Map([...rows].map(([i, p]) => [i, { mu: p.mu, sigma: p.sigma }])));
      const pl = places(rec);
      const [res] = await conn.execute(
        `INSERT INTO games (table_code, mode, seats, humans, hands, rated, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [rec.code, rec.mode, rec.seats.length, seats.length, rec.hands, rated ? 1 : 0, new Date(rec.startedAt), new Date(rec.endedAt)],
      );
      const gameId = (res as { insertId: number }).insertId;
      for (let i = 0; i < rec.seats.length; i++) {
        const seat = rec.seats[i];
        const p = rows.get(i);
        const won = rec.winners.includes(i) && !seat.leftEarly;
        const before = p ? displayRating(p.mu, p.sigma) : null;
        const r = rated?.get(i);
        const after = r ? displayRating(r.mu, r.sigma) : before;
        await conn.execute(
          `INSERT INTO game_players (game_id, seat, player_id, bot_level, name, final_score, place, won, left_early, rating_before, rating_after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gameId, i, p?.id ?? null, seat.botLevel, seat.name.slice(0, 40), seat.finalScore, pl[i], won ? 1 : 0, seat.leftEarly ? 1 : 0, before, after],
        );
        if (p) {
          p.games++;
          if (won) p.wins++;
          if (r) {
            p.mu = r.mu;
            p.sigma = r.sigma;
            p.rated_games++;
          }
          await conn.execute('UPDATE players SET mu = ?, sigma = ?, games = ?, wins = ?, rated_games = ? WHERE id = ?', [
            p.mu,
            p.sigma,
            p.games,
            p.wins,
            p.rated_games,
            p.id,
          ]);
          out.set(String(p.id), { profile: profileOf(p), ratingChange: r && before !== null ? after! - before : null });
        }
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    return out;
  }

  async leaderboard(limit: number) {
    const db = await this.db();
    const [rows] = await db.query(
      `SELECT name, mu, sigma, games, wins FROM players WHERE rated_games > 0
       ORDER BY (mu - 3 * sigma) DESC LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`,
    );
    return (rows as PlayerRow[]).map((p) => ({ name: p.name, rating: displayRating(p.mu, p.sigma), games: p.games, wins: p.wins }));
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
