import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../src/game/protocol';
import { startServer } from '../src/server/server';

let srv: ReturnType<typeof startServer>;
let port = 0;

beforeAll(async () => {
  const pub = mkdtempSync(join(tmpdir(), 'doughnut-pub-'));
  writeFileSync(join(pub, 'index.html'), '<!doctype html><title>t</title>');
  srv = startServer({
    port: 0,
    publicDir: pub,
    modelPath: 'models/doughnut.json',
    table: { timing: { botDelayMs: 0, trickPauseMs: 0, betweenHandsMs: 0, turnMs: 50, disconnectedMs: 0 } },
  });
  await new Promise<void>((r) => srv.server.once('listening', () => r()));
  port = (srv.server.address() as { port: number }).port;
});
afterAll(() => srv.close());

function connect() {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const msgs: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ServerMessage;
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  return {
    ws,
    msgs,
    open: () => new Promise<void>((r) => ws.once('open', () => r())),
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    waitFor: (pred: (m: ServerMessage) => boolean) =>
      new Promise<ServerMessage>((resolve) => {
        const hit = msgs.find(pred);
        if (hit) resolve(hit);
        else waiters.push({ pred, resolve });
      }),
  };
}

describe('server', () => {
  it('serves health and static files, refusing path traversal', async () => {
    const h = await fetch(`http://localhost:${port}/health`).then((r) => r.json());
    expect(h).toMatchObject({ ok: true, model: true });
    expect((await fetch(`http://localhost:${port}/anything`)).status).toBe(200);
    const res = await new Promise<number>((resolve) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: 'localhost', port, path: '/../../package.json' }, (r) => resolve(r.statusCode!));
        req.end();
      });
    });
    expect([200, 403]).toContain(res);
    const body = await new Promise<string>((resolve) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: 'localhost', port, path: '/../../package.json' }, (r) => {
          let s = '';
          r.on('data', (d) => (s += d));
          r.on('end', () => resolve(s));
        });
        req.end();
      });
    });
    expect(body).not.toContain('"devDependencies"');
  });

  it('two players over WebSockets play a full game with a bot', async () => {
    const a = connect();
    const b = connect();
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'hello', token: 'wsAliceAAAAAAAAAAAAA', name: 'Alice' });
    b.send({ t: 'hello', token: 'wsBobBBBBBBBBBBBBBBB', name: 'Bob' });
    a.send({ t: 'create', settings: { mode: 'doughnut-20', seats: 3, botLevel: 'hard' } });
    const created = (await a.waitFor((m) => m.t === 'table')) as Extract<ServerMessage, { t: 'table' }>;
    b.send({ t: 'join', code: created.table.code });
    await a.waitFor((m) => m.t === 'table' && m.table.seats[1].kind === 'human');
    a.send({ t: 'start' });
    // Humans never move; 50 ms turn timers let the bot play for them until the 20 hands are done.
    const over = (await b.waitFor((m) => m.t === 'table' && m.table.status === 'over')) as Extract<ServerMessage, { t: 'table' }>;
    expect(over.table.winners.length).toBeGreaterThan(0);
    expect(over.table.obs!.handsPlayed).toBe(20);
    a.ws.close();
    b.ws.close();
  }, 30_000);
});
