import { describe, expect, it } from 'vitest';
import { heuristicAgent } from '../src/ai';
import { mulberry32 } from '../src/engine';
import { Lobby, type Client } from '../src/game/lobby';
import type { GameRecord, ServerMessage } from '../src/game/protocol';
import { AccountService, validEmail } from '../src/server/accounts';
import { LogMailer } from '../src/server/mailer';
import { LoginThrottle, hashPassword, verifyPassword } from '../src/server/password';
import { MemoryRepo, MySqlRepo, displayRating, places, rateGame, type Repo } from '../src/server/store';
import { FakeClock } from './fake-clock';

const TA = 'tokenAAAAAAAAAAAAAAAA';
const TB = 'tokenBBBBBBBBBBBBBBBB';
const TC = 'tokenCCCCCCCCCCCCCCCC';
const TD = 'tokenDDDDDDDDDDDDDDDD';

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

/** The code from the last emailed link of a kind. */
function linkCode(mail: LogMailer, kind: 'verify' | 'reset', to?: string): string {
  const m = [...mail.sent].reverse().find((e) => (!to || e.to === to) && e.text.includes(`?${kind}=`));
  if (!m) throw new Error(`no ${kind} email`);
  return /\?(?:verify|reset)=([A-Za-z0-9_-]+)/.exec(m.text)![1];
}

describe('passwords', () => {
  it('hash and verify with scrypt; wrong passwords fail', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$/);
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
  });

  it('validates email addresses', () => {
    for (const ok of ['a@b.co', 'first.last+tag@example.com']) expect(validEmail(ok)).toBe(true);
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@b.c', '<x>@y.com']) expect(validEmail(bad)).toBe(false);
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
    expect(displayRating(25, 25 / 3)).toBe(1000);
  });
});

/** The whole account life cycle against a repo. */
async function exerciseAccounts(repo: Repo, clock: FakeClock) {
  const mail = new LogMailer(true);
  const svc = new AccountService(repo, mail, { publicUrl: 'https://doughnut.test/', now: clock.now });
  await svc.init();

  // Sign up: validation, then a confirmation email; not logged in until confirmed.
  await expect(svc.signup(TA, 'nope', 'Alice', 'secret1')).rejects.toThrow(/email address/);
  await expect(svc.signup(TA, 'alice@example.com', 'Alice', '123')).rejects.toThrow(/6 characters/);
  await expect(svc.signup(TA, 'alice@example.com', 'Guest', 'secret1')).rejects.toThrow(/can't be registered/);
  const pending = await svc.signup(TA, 'Alice@Example.com', 'Alice', 'secret1');
  expect(pending).not.toBeNull();
  expect(mail.sent).toHaveLength(1);
  expect(mail.sent[0]).toMatchObject({ to: 'Alice@Example.com', subject: 'Confirm your Doughnut account' });
  expect(mail.sent[0].text).toContain('https://doughnut.test/?verify=');
  expect(await svc.sessionAccount(TA)).toBeNull();
  expect(await svc.isRegistered('alice')).toBe(false); // not reserved for guests until confirmed
  await expect(svc.login(TB, 'alice@example.com', 'secret1')).rejects.toThrow(/confirm your email/);
  await expect(svc.signup(TB, 'other@example.com', 'ALICE', 'secret1')).rejects.toThrow(/nickname is taken/);

  // Confirm: logs in the browser that opened the link; the link works once.
  const code = linkCode(mail, 'verify');
  const acct = await svc.verifyEmail(TC, code);
  expect(acct).toMatchObject({ nickname: 'Alice', profile: { rating: 1000 } });
  expect((await svc.sessionAccount(TC))!.id).toBe(acct.id);
  expect((await svc.sessionAccount(TA))!.id).toBe(acct.id); // the sign-up browser too
  await expect(svc.verifyEmail(TD, code)).rejects.toThrow(/expired or was already used/);
  expect(await svc.isRegistered('ALICE')).toBe(true);

  // Signing up again with the same email reveals nothing; the owner is emailed
  // (at most one email per address per minute).
  clock.advance(61_000);
  const sentBefore = mail.sent.length;
  expect(await svc.signup(TD, 'alice@example.com', 'Alicia', 'secret2')).toBeNull();
  expect(mail.sent[sentBefore]).toMatchObject({ to: 'Alice@Example.com', subject: 'You already have a Doughnut account' });

  // Log in by email or nickname.
  await expect(svc.login(TD, 'alice@example.com', 'wrong')).rejects.toThrow(/Wrong email, nickname or password/);
  expect((await svc.login(TD, 'ALICE@example.com', 'secret1')).id).toBe(acct.id);
  expect((await svc.login(TD, 'alice', 'secret1')).id).toBe(acct.id);
  await svc.logout(TD);
  expect(await svc.sessionAccount(TD)).toBeNull();

  // Forgotten password: same answer for unknown emails; link resets and logs out everywhere else.
  const n = mail.sent.length;
  await svc.requestPasswordReset('nobody@example.com');
  expect(mail.sent).toHaveLength(n);
  clock.advance(61_000); // per-address email limit
  await svc.requestPasswordReset('alice@example.com');
  expect(mail.sent).toHaveLength(n + 1);
  const reset = linkCode(mail, 'reset');
  await expect(svc.resetPassword(TD, reset, '123')).rejects.toThrow(/6 characters/);
  await svc.resetPassword(TD, reset, 'newpass1');
  expect(await svc.sessionAccount(TA)).toBeNull(); // other browsers logged out
  expect(await svc.sessionAccount(TC)).toBeNull();
  expect((await svc.sessionAccount(TD))!.id).toBe(acct.id);
  await expect(svc.resetPassword(TA, reset, 'again123')).rejects.toThrow(/expired or was already used/);
  await expect(svc.login(TA, 'alice', 'secret1')).rejects.toThrow(/Wrong/);
  expect((await svc.login(TA, 'alice', 'newpass1')).id).toBe(acct.id);

  // Expired links don't work; unconfirmed sign-ups are purged after 48 h.
  await svc.signup(TB, 'bob@example.com', 'Bob', 'hunter22');
  const bobCode = linkCode(mail, 'verify', 'bob@example.com');
  clock.advance(49 * 3600_000);
  await expect(svc.verifyEmail(TB, bobCode)).rejects.toThrow(/expired/);
  await svc.signup(TB, 'carol@example.com', 'Carol', 'hunter22'); // triggers the purge
  expect(await repo.byEmail('bob@example.com')).toBeNull();
  const carol = await svc.verifyEmail(TB, linkCode(mail, 'verify', 'carol@example.com'));

  // Games: recorded and rated only for confirmed accounts.
  const out = await svc.recordGame(rec([0, 8, 12, 4], [acct.id, null, carol.id, 'guest']));
  expect(out.get(acct.id)!.profile).toMatchObject({ games: 1, wins: 1 });
  expect(out.get(carol.id)!.ratingChange!).toBeLessThan(0);
  expect(out.size).toBe(2);
  const board = await svc.leaderboard(10);
  expect(board.map((r) => r.name)).toEqual(['Alice', 'Carol']);

  // Friends: request, accept, remove; only confirmed accounts.
  await expect(svc.addFriend(acct.id, 'nobody')).rejects.toThrow(/No player called/);
  await expect(svc.addFriend(acct.id, 'alice')).rejects.toThrow(/That's you/);
  expect((await svc.addFriend(acct.id, 'CAROL')).state).toBe('requested');
  expect((await svc.addFriend(acct.id, 'Carol')).state).toBe('requested'); // asking twice is harmless
  expect(await svc.friendLists(acct.id)).toMatchObject({ friends: [], outgoing: [{ nickname: 'Carol' }], incoming: [] });
  expect(await svc.friendLists(carol.id)).toMatchObject({ friends: [], incoming: [{ nickname: 'Alice' }] });
  await expect(svc.respondFriend(acct.id, 'Carol', true)).rejects.toThrow(/hasn't asked/);
  await svc.respondFriend(carol.id, 'Alice', true);
  expect((await svc.friendLists(acct.id)).friends.map((f) => f.nickname)).toEqual(['Carol']);
  expect((await svc.friendLists(carol.id)).friends.map((f) => f.nickname)).toEqual(['Alice']);
  expect((await svc.addFriend(carol.id, 'Alice')).state).toBe('already');
  await svc.removeFriend(carol.id, 'alice');
  expect(await svc.friendLists(acct.id)).toMatchObject({ friends: [], incoming: [], outgoing: [] });
  // Asking someone who already asked you makes you friends at once.
  await svc.addFriend(acct.id, 'Carol');
  expect((await svc.addFriend(carol.id, 'Alice')).state).toBe('accepted');
  // Declining removes the request.
  await svc.removeFriend(acct.id, 'Carol');
  await svc.addFriend(carol.id, 'Alice');
  await svc.respondFriend(acct.id, 'Carol', false);
  expect(await svc.friendLists(carol.id)).toMatchObject({ friends: [], outgoing: [] });
  return { svc, mail };
}

describe('AccountService with MemoryRepo', () => {
  it('sign up, confirm, log in, reset, record', async () => {
    const clock = new FakeClock();
    clock.t = Date.UTC(2026, 10, 8);
    await exerciseAccounts(new MemoryRepo(clock.now), clock);
  });
});

const MYSQL = process.env.TEST_MYSQL_URL;
describe.skipIf(!MYSQL)('MySqlRepo (TEST_MYSQL_URL)', () => {
  it('migrates older schemas and runs the whole account life cycle', async () => {
    const db = await (await import('mysql2/promise')).createConnection(MYSQL!);
    await db.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['game_players', 'games', 'sessions', 'email_links', 'friendships', 'players', 'game_players_v1', 'games_v1', 'players_v1']) {
      await db.query(`DROP TABLE IF EXISTS ${t}`);
    }
    await db.query('SET FOREIGN_KEY_CHECKS = 1');
    // A v2 database: nickname + password accounts, no email.
    await db.query(`CREATE TABLE players (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, nickname VARCHAR(20) NOT NULL,
      nickname_key VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, password_hash VARCHAR(255) NOT NULL,
      mu DOUBLE NOT NULL, sigma DOUBLE NOT NULL, games INT UNSIGNED NOT NULL DEFAULT 0, wins INT UNSIGNED NOT NULL DEFAULT 0,
      rated_games INT UNSIGNED NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login TIMESTAMP NULL,
      UNIQUE KEY uq_nickname (nickname_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.query(`INSERT INTO players (nickname, nickname_key, password_hash, mu, sigma) VALUES ('Old', 'old', ?, 25, 8.33)`, [
      await hashPassword('oldpass1'),
    ]);

    // MySQL uses real time; the fake clock only drives the in-process limits.
    const clock = new FakeClock();
    clock.t = Date.now();
    const repo = new MySqlRepo(MYSQL!);
    await repo.init();
    await repo.init(); // idempotent
    const legacy = await repo.byNickname('old');
    expect(legacy!.verified_at).not.toBeNull(); // existing accounts stay usable
    expect(legacy!.email).toBeNull();

    // Expiry is checked by MySQL against real time, so skip the time-travel part here.
    const mail = new LogMailer(true);
    const svc = new AccountService(repo, mail, { publicUrl: 'https://doughnut.test', now: clock.now });
    expect((await svc.login(TA, 'Old', 'oldpass1')).nickname).toBe('Old');
    await svc.signup(TB, 'dee@example.com', 'Dee', 'secret1');
    const dee = await svc.verifyEmail(TB, linkCode(mail, 'verify'));
    await svc.recordGame(rec([0, 5], [dee.id, String(legacy!.id)]));
    await svc.addFriend(dee.id, 'Old');
    await svc.respondFriend(String(legacy!.id), 'Dee', true);
    expect((await svc.friendLists(dee.id)).friends.map((f) => f.nickname)).toEqual(['Old']);
    await svc.removeFriend(dee.id, 'Old');
    expect((await svc.friendLists(String(legacy!.id))).friends).toEqual([]);
    const [gp] = await db.query('SELECT kind FROM game_players');
    expect((gp as unknown[]).length).toBe(2);
    const [links] = await db.query('SELECT code_hash, used_at FROM email_links');
    for (const l of links as { code_hash: string; used_at: Date | null }[]) expect(l.code_hash).toMatch(/^[0-9a-f]{64}$/);
    await db.end();
    await repo.close();
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
    clock.t = Date.UTC(2026, 10, 8);
    const repo = new MemoryRepo(clock.now);
    const mail = new LogMailer(true);
    const svc = new AccountService(repo, mail, { publicUrl: 'https://doughnut.test', now: clock.now });
    const lobby = new Lobby({ makeBot: () => heuristicAgent(), clock, rng: mulberry32(2) }, {}, svc);
    return { clock, repo, mail, lobby };
  }

  it('sign up mid-game, confirm on another device: the game in progress is saved', async () => {
    const { clock, repo, mail, lobby } = setup();
    const laptop = new Rec();
    const bob = new Rec();
    await lobby.handle(laptop, null, { t: 'hello', token: TA, name: 'Alice' });
    await lobby.handle(bob, null, { t: 'hello', token: TB, name: 'Bob' });
    await lobby.handle(laptop, TA, { t: 'create', settings: { mode: 'doughnut-20', seats: 3, botLevel: 'easy' } });
    await lobby.handle(bob, TB, { t: 'join', code: laptop.last('table')!.table.code });
    await lobby.handle(laptop, TA, { t: 'start' });

    await lobby.handle(laptop, TA, { t: 'signup', email: 'alice@example.com', nickname: 'Alice', password: 'secret1' });
    expect(laptop.last('notice')!.message).toMatch(/Check your email/);
    expect(laptop.last('account')).toBeUndefined();

    const phone = new Rec();
    await lobby.handle(phone, null, { t: 'hello', token: TC, name: '' });
    await lobby.handle(phone, TC, { t: 'verify', code: linkCode(mail, 'verify') });
    expect(phone.last('account')).toMatchObject({ why: 'verified', account: { nickname: 'Alice' } });
    expect(laptop.last('account')).toMatchObject({ why: 'verified', account: { nickname: 'Alice' } });

    clock.runAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(repo.games).toHaveLength(1);
    expect(repo.games[0].seats[0].accountId).not.toBeNull();
    expect(laptop.last('profile')!.profile.games).toBe(1);
  });

  it('guests are never recorded; confirmed nicknames are reserved', async () => {
    const { clock, repo, mail, lobby } = setup();
    const a = new Rec();
    const b = new Rec();
    await lobby.handle(a, null, { t: 'hello', token: TA, name: 'Alice' });
    await lobby.handle(b, null, { t: 'hello', token: TB, name: 'Bob' });
    await lobby.handle(a, TA, { t: 'create', settings: { mode: 'doughnut-20', seats: 2, botLevel: 'easy' } });
    await lobby.handle(b, TB, { t: 'join', code: a.last('table')!.table.code });
    await lobby.handle(a, TA, { t: 'start' });
    clock.runAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(repo.games).toHaveLength(0);

    await lobby.handle(a, TA, { t: 'leave' });
    await lobby.handle(a, TA, { t: 'signup', email: 'alice@example.com', nickname: 'Alice', password: 'secret1' });
    await lobby.handle(a, TA, { t: 'verify', code: linkCode(mail, 'verify') });
    const imposter = new Rec();
    await lobby.handle(imposter, null, { t: 'hello', token: TC, name: 'ALICE' });
    expect(imposter.last('error')!.message).toMatch(/registered nickname/);
  });

  it('forgot password: reset link logs in here and logs out other live devices', async () => {
    const { clock, mail, lobby } = setup();
    const laptop = new Rec();
    await lobby.handle(laptop, null, { t: 'hello', token: TA, name: 'Alice' });
    await lobby.handle(laptop, TA, { t: 'signup', email: 'alice@example.com', nickname: 'Alice', password: 'secret1' });
    await lobby.handle(laptop, TA, { t: 'verify', code: linkCode(mail, 'verify') });

    const phone = new Rec();
    await lobby.handle(phone, null, { t: 'hello', token: TC, name: '' });
    await lobby.handle(phone, TC, { t: 'forgot', email: 'nobody@example.com' });
    expect(phone.last('notice')!.message).toMatch(/If that email has an account/);
    clock.advance(61_000);
    await lobby.handle(phone, TC, { t: 'forgot', email: 'alice@example.com' });
    await lobby.handle(phone, TC, { t: 'reset', code: linkCode(mail, 'reset'), password: 'newpass1' });
    expect(phone.last('account')).toMatchObject({ why: 'reset', account: { nickname: 'Alice' } });
    expect(laptop.last('account')).toMatchObject({ why: 'reset', account: null });

    // Reconnecting the laptop: still a guest.
    const laptop2 = new Rec();
    await lobby.handle(laptop2, null, { t: 'hello', token: TA, name: '' });
    expect(laptop2.last('welcome')!.account).toBeNull();
  });

  it('friends: request, accept, live status, and joining their game', async () => {
    const { clock, mail, lobby } = setup();
    const a = new Rec();
    const b = new Rec();
    async function account(r: Rec, token: string, name: string, email: string) {
      await lobby.handle(r, null, { t: 'hello', token, name });
      await lobby.handle(r, token, { t: 'signup', email, nickname: name, password: 'secret1' });
      await lobby.handle(r, token, { t: 'verify', code: linkCode(mail, 'verify', email) });
    }
    await account(a, TA, 'Alice', 'alice@example.com');
    await account(b, TB, 'Bob', 'bob@example.com');
    expect(a.last('friends')!.friends).toEqual({ friends: [], incoming: [], outgoing: [] });

    await lobby.handle(a, TA, { t: 'friendAdd', nickname: 'bob' });
    expect(a.last('toast')!.message).toBe('Friend request sent to Bob');
    expect(b.last('toast')!.message).toBe('Alice wants to be friends');
    expect(b.last('friends')!.friends.incoming).toEqual(['Alice']);
    await lobby.handle(b, TB, { t: 'friendRespond', nickname: 'Alice', accept: true });
    expect(a.last('friends')!.friends.friends).toEqual([{ nickname: 'Bob', status: 'online', table: null }]);

    // Bob starts a 3-seat game with a bot: Alice sees it and can join (taking the bot's seat).
    await lobby.handle(b, TB, { t: 'create', settings: { mode: 'doughnut', seats: 3, botLevel: 'easy' } });
    const code = b.last('table')!.table.code;
    expect(a.last('friends')!.friends.friends[0]).toMatchObject({ status: 'lobby', table: { code, humans: 1, joinable: true } });
    await lobby.handle(b, TB, { t: 'start' });
    expect(a.last('friends')!.friends.friends[0]).toMatchObject({ status: 'playing', table: { code, joinable: true } });
    await lobby.handle(a, TA, { t: 'join', code });
    expect(a.last('table')!.table).toMatchObject({ status: 'playing', you: 1 });
    expect(b.last('friends')!.friends.friends[0]).toMatchObject({ nickname: 'Alice', status: 'playing', table: { humans: 2 } });

    // Going offline shows as offline.
    lobby.disconnect(a, TA);
    expect(b.last('friends')!.friends.friends[0].status).toBe('offline');
    void clock;
  });

  it('guests are asked to sign up before adding friends', async () => {
    const { lobby } = setup();
    const g = new Rec();
    await lobby.handle(g, null, { t: 'hello', token: TA, name: 'Gus' });
    await lobby.handle(g, TA, { t: 'friendAdd', nickname: 'Alice' });
    expect(g.last('error')!.message).toMatch(/Sign up to add friends/);
  });

  it('without accounts, signing up is unavailable but play works', async () => {
    const lobby = new Lobby({ makeBot: () => heuristicAgent(), clock: new FakeClock() });
    const a = new Rec();
    await lobby.handle(a, null, { t: 'hello', token: TA, name: 'Alice' });
    await lobby.handle(a, TA, { t: 'signup', email: 'a@b.co', nickname: 'Alice', password: 'secret1' });
    expect(a.last('error')!.message).toMatch(/isn't available/);
  });
});
