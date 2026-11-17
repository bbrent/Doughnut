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
    expect([200, 403, 404]).toContain(res);
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

describe('pages served elsewhere (static web server + Node game server)', () => {
  let srv2: ReturnType<typeof startServer>;
  let port2 = 0;
  beforeAll(async () => {
    srv2 = startServer({ port: 0, publicDir: mkdtempSync(join(tmpdir(), 'none-')), allowedOrigins: ['https://site.test/play/'] });
    await new Promise<void>((r) => srv2.server.once('listening', () => r()));
    port2 = (srv2.server.address() as { port: number }).port;
  });
  afterAll(() => srv2.close());

  const tryWs = (path: string, origin?: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port2}${path}`, origin ? { origin } : {});
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('error', () => resolve('refused'));
      ws.on('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`));
    });

  it('accepts game connections from the allowed site, under any path prefix, and refuses others', async () => {
    expect(await tryWs('/ws', 'https://site.test')).toBe('open');
    expect(await tryWs('/doughnut-server/ws', 'https://site.test')).toBe('open');
    expect(await tryWs('/ws')).toBe('open'); // no Origin: not a browser page
    expect(await tryWs('/ws', `http://localhost:${port2}`)).toBe('open'); // pages served by this server
    expect(await tryWs('/ws', 'https://evil.test')).toMatch(/refused/);
    expect(await tryWs('/nope', 'https://site.test')).toMatch(/refused/);
  });

  it('lets the allowed site read the leaderboard and health (CORS), not others', async () => {
    const get = (path: string, origin: string) => fetch(`http://localhost:${port2}${path}`, { headers: { origin } });
    const ok = await get('/doughnut-server/api/leaderboard', 'https://site.test');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://site.test');
    const bad = await get('/api/leaderboard', 'https://evil.test');
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    expect((await get('/doughnut-server/health', 'https://site.test')).headers.get('access-control-allow-origin')).toBe('https://site.test');
  });
});

describe('serving the pages under a path prefix', () => {
  let srv3: ReturnType<typeof startServer>;
  let srv4: ReturnType<typeof startServer>;
  let p3 = 0;
  let p4 = 0;
  beforeAll(async () => {
    const pub = mkdtempSync(join(tmpdir(), 'pub-'));
    writeFileSync(join(pub, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><script type="module" src="app.js?v=1"></script></body></html>');
    writeFileSync(join(pub, 'app.js'), 'console.log(1)');
    srv3 = startServer({ port: 0, publicDir: pub }); // host passes the prefix through
    srv4 = startServer({ port: 0, publicDir: pub, basePath: '/doughnut' }); // host strips it
    await Promise.all([srv3, srv4].map((s) => new Promise<void>((r) => s.server.once('listening', () => r()))));
    p3 = (srv3.server.address() as { port: number }).port;
    p4 = (srv4.server.address() as { port: number }).port;
  });
  afterAll(() => Promise.all([srv3.close(), srv4.close()]));

  it('finds files under any prefix and never answers a missing script with the page', async () => {
    const js = await fetch(`http://localhost:${p3}/doughnut/app.js?v=1`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    const missing = await fetch(`http://localhost:${p3}/doughnut/missing.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toMatch(/text\/plain/);
  });

  it('tells the page which folder it lives in (<base href>)', async () => {
    const base = async (port: number, path: string) =>
      /<base href="([^"]*)"/.exec(await (await fetch(`http://localhost:${port}${path}`)).text())?.[1];
    expect(await base(p3, '/')).toBe('/');
    expect(await base(p3, '/?t=ABCDE')).toBe('/');
    expect(await base(p3, '/doughnut')).toBe('/doughnut/');
    expect(await base(p3, '/doughnut/')).toBe('/doughnut/');
    expect(await base(p4, '/')).toBe('/doughnut/'); // prefix removed by the host, added back
    expect(await base(p4, '/doughnut/')).toBe('/doughnut/');
    const h = await (await fetch(`http://localhost:${p4}/health`)).json();
    expect(h).toMatchObject({ pages: true, basePath: '/doughnut', node: process.version });
  });
});
