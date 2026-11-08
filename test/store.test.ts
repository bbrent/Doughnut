import { describe, expect, it } from 'vitest';
import { heuristicAgent } from '../src/ai';
import { mulberry32 } from '../src/engine';
import { Lobby, type Client } from '../src/game/lobby';
import type { GameRecord, ServerMessage } from '../src/game/protocol';
import { LoginThrottle, hashPassword, verifyPassword } from '../src/server/password';
import { MemoryStore, MySqlStore, displayRating, places, rateGame, type Store } from '../src/server/store';
import { FakeClock } from './fake-clock';

const TA = 'tokenAAAAAAAAAAAAAAAA';
const TB = 'tokenBBBBBBBBBBBBBBBB';
const TC = 'tokenCCCCCCCCCCCCCCCC';

/** seats: account id, 'guest', or null (bot). */
const rec = (scores: number[], who: (string | null)[], left: boolean[] = []): GameRecord => ({
  code: 'ABCDE',
  mode: 'doughnut',
  startedAt: 0,
  endedAt: 1000,
  hands: 10,
  winners: scores.flatMap((x, i) => (x === Math.min(...scores) ? [i] : [])),
  seats: scores.map((finalScore, i) => ({
    userId: who[i] ? `u${i}` : null,
    accountId: who[i] && who[i] !== 'guest' ? who[i] : null,
    name: who[i] ? `P${i}` : `Bot ${i}`,
    botLevel: who[i] ? null : 'hard',
    finalScore,
    leftEarly: !!left[i],
  })),
});

describe('passwords', () => {
  it('hash and verify with scrypt; wrong passwords fail', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toContain('correct');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong horse', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('throttles repeated failures', () => {
    let t = 0;
    const th = new LoginThrottle(() => t);
    for (let i = 0; i < 4; i++) th.fail('k');
    expect(th.check('k')).toBe(0);
    th.fail('k');
    expect(th.check('k')).toBe(30);
    t += 31_000;
    expect(th.check('k')).toBe(0);
    th.success('k');
  });
});

describe('places and ratings', () => {
  it('lower score places higher; ties share; leavers come last', () => {
    expect(places(rec([0, 7, 7, 12], ['1', '2', '3', '4']))).toEqual([1, 2, 2, 4]);
    expect(places(rec([0, 7, 3], ['1', '2', '3'], [true, false, false]))).toEqual([3, 2, 1]);
  });

  it('only games with two or more accounts are rated; guests are not', () => {
    expect(rateGame(rec([0, 5, 9], ['1', null, 'guest']), new Map())).toBeNull();
    const r = rateGame(rec([0, 5, 9], ['1', 'guest', '3']), new Map())!;
    expect([...r.keys()]).toEqual([0, 2]);
    expect(r.get(0)!.mu).toBeGreaterThan(25);
    expect(r.get(2)!.mu).toBeLessThan(25);
    expect(displayRating(25, 25 / 3)).toBe(1000);
  });
});

async function exerciseStore(store: Store) {
  expect(await store.sessionAccount(TA)).toBeNull();
  await expect(store.register(TA, 'Al', '123')).rejects.toThrow(/6 characters/);
  await expect(store.register(TA, 'Guest', 'secret1')).rejects.toThrow(/can't be registered/);
  const a = await store.register(TA, 'Alice', 'secret1');
  expect(a.profile).toMatchObject({ name: 'Alice', rating: 1000, games: 0 });
  await expect(store.register(TB, 'ALICE', 'other12')).rejects.toThrow(/already registered/);
  expect(await store.isRegistered('alice')).toBe(true);
  expect(await store.isRegistered('Bob')).toBe(false);
  expect((await store.sessionAccount(TA))!.id).toBe(a.id);

  await expect(store.login(TC, 'alice', 'nope')).rejects.toThrow(/Wrong nickname or password/);
  const again = await store.login(TC, 'alice', 'secret1'); // second device
  expect(again.id).toBe(a.id);
  await store.logout(TC);
  expect(await store.sessionAccount(TC)).toBeNull();
  expect(await store.sessionAccount(TA)).not.toBeNull();

  const b = await store.register(TB, 'Bob', 'hunter22');
  const out = await store.recordGame(rec([0, 8, 12, 4], [a.id, null, b.id, 'guest']));
  expect(out.get(a.id)!.profile).toMatchObject({ games: 1, wins: 1 });
  expect(out.get(a.id)!.ratingChange!).toBeGreaterThan(0);
  expect(out.get(b.id)!.ratingChange!).toBeLessThan(0);
  expect(out.size).toBe(2); // guests get nothing back

  const solo = await store.recordGame(rec([3, 0, 1], [b.id, null, 'guest']));
  expect(solo.get(b.id)).toMatchObject({ ratingChange: null, profile: { games: 2, wins: 0 } });

  const board = await store.leaderboard(10);
  expect(board.map((r) => r.name)).toEqual(['Alice', 'Bob']);
}

describe('MemoryStore', () => {
  it('accounts, sessions and records', async () => {
    await exerciseStore(new MemoryStore());
  });
});

const MYSQL = process.env.TEST_MYSQL_URL;
describe.skipIf(!MYSQL)('MySqlStore (TEST_MYSQL_URL)', () => {
  it('creates the schema, migrates v1 tables aside, and stores accounts and games', async () => {
    const db = await (await import('mysql2/promise')).createConnection(MYSQL!);
    await db.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['game_players', 'games', 'sessions', 'players', 'game_players_v1', 'games_v1', 'players_v1']) await db.query(`DROP TABLE IF EXISTS ${t}`);
    await db.query('SET FOREIGN_KEY_CHECKS = 1');
    // A first-version database.
    await db.query('CREATE TABLE players (id INT UNSIGNED PRIMARY KEY, token_hash CHAR(64)) ENGINE=InnoDB');
    await db.query('CREATE TABLE games (id INT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
    await db.query(`CREATE TABLE game_players (game_id INT UNSIGNED, player_id INT UNSIGNED,
      CONSTRAINT fk_gp_game FOREIGN KEY (game_id) REFERENCES games (id),
      CONSTRAINT fk_gp_player FOREIGN KEY (player_id) REFERENCES players (id)) ENGINE=InnoDB`);
    await db.query("INSERT INTO players VALUES (1, 'x')");

    const store = new MySqlStore(MYSQL!);
    await store.init();
    await store.init(); // idempotent
    const [v1] = await db.query('SELECT COUNT(*) AS n FROM players_v1');
    expect((v1 as { n: number }[])[0].n).toBe(1);

    await exerciseStore(store);
    const [gp] = await db.query('SELECT kind, name, player_id FROM game_players ORDER BY game_id, seat');
    expect((gp as { kind: string; name: string }[]).map((r) => r.kind)).toEqual(['account', 'bot', 'account', 'guest', 'account', 'bot', 'guest']);
    for (const r of gp as { kind: string; name: string }[]) if (r.kind === 'guest') expect(r.name).toBe('Guest');
    const [sess] = await db.query('SELECT token_hash FROM sessions');
    for (const r of sess as { token_hash: string }[]) expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/); // never the raw token
    const [pw] = await db.query('SELECT password_hash FROM players');
    for (const r of pw as { password_hash: string }[]) expect(r.password_hash).toMatch(/^scrypt\$/);
    await db.end();
    await store.close();
  });
});

class Rec implements Client {
  msgs: ServerMessage[] = [];
  send(m: ServerMessage) {
    this.msgs.push(m);
  }
  last<T extends ServerMessage['t']>(t: T) {
    return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
}

describe('lobby accounts', () => {
  function setup() {
    const clock = new FakeClock();
    const store = new MemoryStore();
    const lobby = new Lobby({ makeBot: () => heuristicAgent(), clock, rng: mulberry32(2) }, {}, store);
    return { clock, store, lobby };
  }

  it('guests are not recorded; registering mid-game records that game', async () => {
    const { clock, store, lobby } = setup();
    const a = new Rec();
    const b = new Rec();
    await lobby.handle(a, null, { t: 'hello', token: TA, name: 'Alice' });
    await lobby.handle(b, null, { t: 'hello', token: TB, name: 'Bob' });
    expect(a.last('welcome')!.account).toBeNull();
    await lobby.handle(a, TA, { t: 'create', settings: { mode: 'doughnut-20', seats: 3, botLevel: 'easy' } });
    await lobby.handle(b, TB, { t: 'join', code: a.last('table')!.table.code });
    await lobby.handle(a, TA, { t: 'start' });
    clock.runAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.games).toHaveLength(0); // two guests: nothing saved

    await lobby.handle(a, TA, { t: 'start' }); // rematch
    await lobby.handle(a, TA, { t: 'register', password: 'secret1' });
    expect(a.last('account')!.account!.nickname).toBe('Alice');
    clock.runAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.games).toHaveLength(1);
    expect(store.games[0].seats.map((s) => s.accountId)).toEqual(['1', null, null]);
    expect(a.last('profile')!.profile.games).toBe(1);
    expect(b.last('profile')).toBeUndefined();
  });

  it('registered nicknames are reserved; logging in elsewhere joins the same session', async () => {
    const { lobby } = setup();
    const a = new Rec();
    await lobby.handle(a, null, { t: 'hello', token: TA, name: 'Alice' });
    await lobby.handle(a, TA, { t: 'register', password: 'secret1' });

    const imposter = new Rec();
    await lobby.handle(imposter, null, { t: 'hello', token: TB, name: 'alice' });
    expect(imposter.last('error')!.message).toMatch(/registered nickname/);
    expect(imposter.last('welcome')).toBeUndefined();

    // New device: unnamed guest, then log in.
    const phone = new Rec();
    const tok = await lobby.handle(phone, null, { t: 'hello', token: TC, name: '' });
    await lobby.handle(phone, tok, { t: 'create', settings: { mode: 'doughnut', seats: 2, botLevel: 'easy' } });
    expect(phone.last('error')!.message).toMatch(/nickname first/);
    await lobby.handle(phone, tok, { t: 'login', nickname: 'ALICE', password: 'wrong' });
    expect(phone.last('error')!.message).toMatch(/Wrong/);
    await lobby.handle(phone, tok, { t: 'login', nickname: 'ALICE', password: 'secret1' });
    expect(phone.last('account')!.account!.nickname).toBe('Alice');

    // Both devices now see the same table.
    await lobby.handle(a, TA, { t: 'create', settings: { mode: 'doughnut', seats: 2, botLevel: 'easy' } });
    expect(phone.last('table')!.table.code).toBe(a.last('table')!.table.code);

    // Logging out on the phone leaves the laptop logged in.
    await lobby.handle(phone, tok, { t: 'logout' });
    expect(phone.last('account')!.account).toBeNull();
    await lobby.handle(a, TA, { t: 'start' });
    expect(a.last('table')!.table.status).toBe('playing');
    await lobby.handle(a, TA, { t: 'logout' });
    expect(a.last('error')!.message).toMatch(/Finish or leave/);
  });

  it('without a store, saving is unavailable but play works', async () => {
    const lobby = new Lobby({ makeBot: () => heuristicAgent(), clock: new FakeClock() });
    const a = new Rec();
    await lobby.handle(a, null, { t: 'hello', token: TA, name: 'Alice' });
    await lobby.handle(a, TA, { t: 'register', password: 'secret1' });
    expect(a.last('error')!.message).toMatch(/isn't available/);
  });
});
