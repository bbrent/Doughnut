import { describe, expect, it } from 'vitest';
import { heuristicAgent } from '../src/ai';
import { mulberry32 } from '../src/engine';
import { Lobby, type Client } from '../src/game/lobby';
import type { ServerMessage, TableView } from '../src/game/protocol';
import { Table, TableError } from '../src/game/table';
import { FakeClock } from './fake-clock';

const makeBot = () => heuristicAgent();
const alice = { id: 'a', name: 'Alice' };
const bob = { id: 'b', name: 'Bob' };

function table(clock: FakeClock, seats = 3) {
  return new Table('ABCDE', alice, { mode: 'doughnut', seats, botLevel: 'easy' }, { makeBot, clock, rng: mulberry32(1) });
}

describe('table', () => {
  it('fills open seats with bots and plays a full game when humans time out', () => {
    const clock = new FakeClock();
    const t = table(clock);
    t.join(bob);
    t.start('a');
    expect(t.view('a').seats.map((s) => s.kind)).toEqual(['human', 'human', 'bot']);
    clock.runAll();
    expect(t.status).toBe('over');
    expect(t.state!.winners.length).toBeGreaterThan(0);
  });

  it('only the player to act may move, and only legal moves', () => {
    const clock = new FakeClock();
    const t = table(clock, 2);
    t.join(bob);
    t.start('a');
    const s = t.state!;
    const toAct = s.toAct === 0 ? 'a' : 'b';
    const other = toAct === 'a' ? 'b' : 'a';
    const legal = t.view(toAct).obs!.legalMoves;
    expect(t.view(other).obs!.legalMoves).toEqual([]);
    expect(() => t.move(other, legal[0])).toThrow(TableError);
    expect(() => t.move(toAct, { kind: 'card', card: 51 })).toThrow();
    t.move(toAct, legal[0]);
    expect(t.state).not.toBe(s);
  });

  it('views never contain other players cards', () => {
    const clock = new FakeClock();
    const t = table(clock, 4);
    t.join(bob);
    t.start('a');
    const v = t.view('a');
    const json = JSON.stringify(v);
    expect(json).not.toContain('"hands"');
    expect(v.obs!.hand).toEqual(t.state!.hands[0]);
    for (const c of t.state!.hands[1]) expect(v.obs!.hand).not.toContain(c);
  });

  it('a bot covers a disconnected player quickly, and the seat is returned on reconnect', () => {
    const clock = new FakeClock();
    const t = new Table('X', alice, { mode: 'doughnut', seats: 2, botLevel: 'easy' }, {
      makeBot,
      clock,
      rng: mulberry32(3),
      timing: { turnMs: 30_000, disconnectedMs: 1_000, botDelayMs: 500, trickPauseMs: 0, betweenHandsMs: 100 },
    });
    t.join(bob);
    t.start('a');
    // Make it Bob's turn by letting Alice's turns time out if needed.
    while (t.state!.toAct !== 1) clock.advance(30_000);
    t.setConnected('b', false);
    expect(t.view('a').seats[1].covered).toBe(true);
    const before = t.state;
    clock.advance(1_000);
    expect(t.state).not.toBe(before); // covered within the disconnect grace, not the 30 s turn timer
    t.join(bob); // reconnect
    expect(t.seatOf('b')).toBe(1);
    expect(t.view('b').seats[1].covered).toBe(false);
  });

  it('turn deadline is shown only to the player to act', () => {
    const clock = new FakeClock();
    const t = table(clock, 2);
    t.join(bob);
    t.start('a');
    const toAct = t.state!.toAct === 0 ? 'a' : 'b';
    const other = toAct === 'a' ? 'b' : 'a';
    expect(t.view(toAct).deadline).toBe(30_000);
    expect(t.view(other).deadline).toBeNull();
  });

  it('host can start a rematch after the game ends; leaving mid-game hands the seat to a bot', () => {
    const clock = new FakeClock();
    const t = table(clock, 3);
    t.join(bob);
    t.start('a');
    t.leave('b');
    expect(t.view('a').seats[1].kind).toBe('bot');
    clock.runAll();
    expect(t.status).toBe('over');
    t.start('a');
    expect(t.status).toBe('playing');
    expect(() => t.start('b')).toThrow();
  });

  it('rejects joining a started game or a full table', () => {
    const clock = new FakeClock();
    const t = table(clock, 2);
    t.join(bob);
    expect(() => t.join({ id: 'c', name: 'C' })).toThrow('full');
    t.start('a');
    expect(() => t.join({ id: 'd', name: 'D' })).toThrow('started');
  });
});

class Recorder implements Client {
  msgs: ServerMessage[] = [];
  send(m: ServerMessage) {
    this.msgs.push(m);
  }
  last<T extends ServerMessage['t']>(t: T) {
    return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
  get table(): TableView | undefined {
    return this.last('table')?.table;
  }
}

describe('lobby', () => {
  const T1 = 'tokenAAAAAAAAAAAAAAAA';
  const T2 = 'tokenBBBBBBBBBBBBBBBB';

  function setup() {
    const clock = new FakeClock();
    const lobby = new Lobby({ makeBot, clock, rng: mulberry32(9) }, { quickSeats: 3, quickWaitMs: 5_000 });
    return { clock, lobby };
  }

  it('create, share code, join, start, and both see the game', async () => {
    const { lobby } = setup();
    const a = new Recorder();
    const b = new Recorder();
    await lobby.handle(a, null, { t: 'hello', token: T1, name: 'Alice' });
    await lobby.handle(b, null, { t: 'hello', token: T2, name: '<b>Bob</b>' });
    await lobby.handle(a, T1, { t: 'create', settings: { mode: 'doughnut', seats: 4, botLevel: 'easy' } });
    const code = a.table!.code;
    expect(code).toMatch(/^[A-Z2-9]{5}$/);
    await lobby.handle(b, T2, { t: 'join', code: code.toLowerCase() });
    expect(a.table!.seats[1].name).toBe('bBobb'); // markup characters stripped
    await lobby.handle(b, T2, { t: 'start' });
    expect(b.last('error')!.message).toMatch(/host/);
    await lobby.handle(a, T1, { t: 'start' });
    expect(a.table!.status).toBe('playing');
    expect(b.table!.status).toBe('playing');
    expect(b.table!.you).toBe(1);
  });

  it('reconnecting with the same token returns to the same seat', async () => {
    const { lobby } = setup();
    const a = new Recorder();
    await lobby.handle(a, null, { t: 'hello', token: T1, name: 'Alice' });
    await lobby.handle(a, T1, { t: 'create', settings: { mode: 'doughnut', seats: 2, botLevel: 'easy' } });
    await lobby.handle(a, T1, { t: 'start' });
    lobby.disconnect(a, T1);
    const a2 = new Recorder();
    await lobby.handle(a2, null, { t: 'hello', token: T1, name: 'Alice' });
    expect(a2.table!.you).toBe(0);
    expect(a2.table!.status).toBe('playing');
  });

  it('quick match fills with bots after the wait, or starts at once when full', async () => {
    const { clock, lobby } = setup();
    const a = new Recorder();
    await lobby.handle(a, null, { t: 'hello', token: T1, name: 'Alice' });
    await lobby.handle(a, T1, { t: 'quick', mode: 'doughnut' });
    expect(a.last('queued')!.position).toBe(1);
    clock.advance(5_000);
    lobby.tick();
    expect(a.table!.status).toBe('playing');
    expect(a.table!.seats.filter((s) => s.kind === 'bot')).toHaveLength(2);

    const rs = [0, 1, 2].map(() => new Recorder());
    for (const [i, r] of rs.entries()) {
      const tok = `tokenQ${i}QQQQQQQQQQQQQQQ`;
      await lobby.handle(r, null, { t: 'hello', token: tok, name: `P${i}` });
      await lobby.handle(r, tok, { t: 'quick', mode: 'doughnut' });
    }
    for (const r of rs) expect(r.table!.seats.filter((s) => s.kind === 'human')).toHaveLength(3);
  });

  it('rejects bad input without crashing', async () => {
    const { lobby } = setup();
    const a = new Recorder();
    await lobby.handle(a, null, { t: 'start' });
    expect(a.last('error')).toBeTruthy();
    await lobby.handle(a, null, { t: 'hello', token: 'short', name: 'x' });
    expect(a.last('error')!.message).toMatch(/token/i);
    await lobby.handle(a, null, { t: 'hello', token: T1, name: 'Alice' });
    await lobby.handle(a, T1, { t: 'join', code: 'ZZZZZ' });
    expect(a.last('error')!.message).toMatch(/No table/);
    await lobby.handle(a, T1, { t: 'create', settings: { mode: 'doughnut', seats: 50, botLevel: 'easy' } });
    expect(a.last('error')!.message).toMatch(/seats/);
    await lobby.handle(a, T1, { t: 'move', move: { kind: 'card', card: 3 } });
    expect(a.last('error')!.message).toMatch(/not at a table/);
  });
});
