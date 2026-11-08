import { describe, expect, it } from 'vitest';
import { heuristicAgent } from '../src/ai';
import { mulberry32 } from '../src/engine';
import { Lobby, type Client } from '../src/game/lobby';
import type { GameRecord, ServerMessage } from '../src/game/protocol';
import { MemoryStore, MySqlStore, displayRating, places, rateGame, type Store } from '../src/server/store';
import { FakeClock } from './fake-clock';

const rec = (scores: number[], humans: (string | null)[], left: boolean[] = []): GameRecord => ({
  code: 'ABCDE',
  mode: 'doughnut',
  startedAt: 0,
  endedAt: 1000,
  hands: 10,
  winners: scores.flatMap((x, i) => (x === Math.min(...scores) ? [i] : [])),
  seats: scores.map((finalScore, i) => ({
    userId: humans[i],
    name: humans[i] ?? `Bot ${i}`,
    botLevel: humans[i] ? null : 'hard',
    finalScore,
    leftEarly: !!left[i],
  })),
});

describe('places and ratings', () => {
  it('lower score places higher; ties share; leavers come last', () => {
    expect(places(rec([0, 7, 7, 12], ['1', '2', '3', '4']))).toEqual([1, 2, 2, 4]);
    expect(places(rec([0, 7, 3], ['1', '2', '3'], [true, false, false]))).toEqual([3, 2, 1]);
  });

  it('only games with two or more humans are rated; winner gains, loser drops', () => {
    expect(rateGame(rec([0, 5, 9], ['1', null, null]), new Map())).toBeNull();
    const r = rateGame(rec([0, 5, 9], ['1', null, '3']), new Map())!;
    expect(r.size).toBe(2);
    expect(r.get(0)!.mu).toBeGreaterThan(25);
    expect(r.get(2)!.mu).toBeLessThan(25);
    expect(displayRating(25, 25 / 3)).toBe(1000);
  });
});

async function exerciseStore(store: Store) {
  const a = await store.identify('tokenAAAAAAAAAAAAAAAA', 'Alice');
  const b = await store.identify('tokenBBBBBBBBBBBBBBBB', 'Bob');
  const again = await store.identify('tokenAAAAAAAAAAAAAAAA', 'Alicia');
  expect(again.id).toBe(a.id);
  expect(again.profile).toMatchObject({ name: 'Alicia', rating: 1000, games: 0, wins: 0 });

  const out = await store.recordGame(rec([0, 8, 12], [a.id, null, b.id]));
  expect(out.get(a.id)!.profile).toMatchObject({ games: 1, wins: 1 });
  expect(out.get(a.id)!.ratingChange!).toBeGreaterThan(0);
  expect(out.get(b.id)!.ratingChange!).toBeLessThan(0);

  // Unrated (one human): counts the game, no rating change.
  const solo = await store.recordGame(rec([3, 0], [b.id, null]));
  expect(solo.get(b.id)).toMatchObject({ ratingChange: null, profile: { games: 2, wins: 0 } });

  const board = await store.leaderboard(10);
  expect(board.map((r) => r.name)).toEqual(['Alicia', 'Bob']);
  expect(board[0].rating).toBeGreaterThan(board[1].rating);
}

describe('MemoryStore', () => {
  it('identifies players by token and records games and ratings', async () => {
    await exerciseStore(new MemoryStore());
  });
});

const MYSQL = process.env.TEST_MYSQL_URL;
describe.skipIf(!MYSQL)('MySqlStore (TEST_MYSQL_URL)', () => {
  it('creates the schema, identifies players, records games in a transaction', async () => {
    const store = new MySqlStore(MYSQL!);
    await store.init();
    const db = await (await import('mysql2/promise')).createConnection(MYSQL!);
    await db.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['game_players', 'games', 'players']) await db.query(`TRUNCATE ${t}`);
    await db.query('SET FOREIGN_KEY_CHECKS = 1');
    await store.init(); // idempotent
    await exerciseStore(store);
    const [gp] = await db.query('SELECT seat, player_id, place, won, rating_before, rating_after FROM game_players ORDER BY game_id, seat');
    expect((gp as unknown[]).length).toBe(5);
    const [players] = await db.query('SELECT token_hash FROM players');
    for (const p of players as { token_hash: string }[]) expect(p.token_hash).toMatch(/^[0-9a-f]{64}$/); // never the raw token
    await db.end();
    await store.close();
  });
});

describe('lobby with a store', () => {
  it('sends profiles on hello and rating updates when a rated game ends', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    const lobby = new Lobby({ makeBot: () => heuristicAgent(), clock, rng: mulberry32(2) }, {}, store);
    const msgs: Record<string, ServerMessage[]> = { a: [], b: [] };
    const ca: Client = { send: (m) => msgs.a.push(m) };
    const cb: Client = { send: (m) => msgs.b.push(m) };
    const TA = 'tokenAAAAAAAAAAAAAAAA';
    const TB = 'tokenBBBBBBBBBBBBBBBB';
    await lobby.handle(ca, null, { t: 'hello', token: TA, name: 'Alice' });
    await lobby.handle(cb, null, { t: 'hello', token: TB, name: 'Bob' });
    expect(msgs.a[0]).toMatchObject({ t: 'welcome', profile: { rating: 1000 } });
    await lobby.handle(ca, TA, { t: 'create', settings: { mode: 'doughnut-20', seats: 3, botLevel: 'easy' } });
    const code = (msgs.a.find((m) => m.t === 'table') as Extract<ServerMessage, { t: 'table' }>).table.code;
    await lobby.handle(cb, TB, { t: 'join', code });
    await lobby.handle(ca, TA, { t: 'start' });
    clock.runAll();
    await new Promise((r) => setTimeout(r, 0)); // let recordGame resolve
    expect(store.games).toHaveLength(1);
    const prof = msgs.a.find((m) => m.t === 'profile') as Extract<ServerMessage, { t: 'profile' }>;
    expect(prof.profile.games).toBe(1);
    expect(prof.ratingChange).not.toBeNull();
  });
});
