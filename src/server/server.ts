/**
 * HTTP + WebSocket server. Serves the built web client and runs the lobby.
 * One process, no database, no native modules: suitable for basic Node hosting.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { botFactory } from '../game/bots';
import { Lobby, type LobbyOptions } from '../game/lobby';
import type { ClientMessage } from '../game/protocol';
import type { TableDeps } from '../game/table';
import { loadModel } from '../ml/dmc';
import type { Mlp } from '../ml/mlp';
import { MemoryStore, type Store } from './store';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface ServerOptions {
  port: number;
  /** Directory with index.html, app.js, styles. */
  publicDir: string;
  /** Path to the trained model (optional; bots fall back to the heuristic). */
  modelPath?: string;
  lobby?: Partial<LobbyOptions>;
  table?: Omit<TableDeps, 'onChange' | 'onGameOver' | 'makeBot'>;
  /** Players, games and ratings. Must already be initialised. Defaults to in-memory. */
  store?: Store;
}

export function loadNet(path?: string): Mlp | null {
  if (!path || !existsSync(path)) return null;
  try {
    return loadModel(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    console.warn(`Could not load model ${path}: ${(e as Error).message}; bots will use the heuristic`);
    return null;
  }
}

export function startServer(opts: ServerOptions): { server: Server; lobby: Lobby; close: () => Promise<void> } {
  const net = loadNet(opts.modelPath);
  const store = opts.store ?? new MemoryStore();
  const lobby = new Lobby({ ...opts.table, makeBot: botFactory(net) }, opts.lobby, store);
  const root = resolve(opts.publicDir);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tables: lobby.tableCount, model: net !== null, store: store.constructor.name }));
      return;
    }
    if (url.pathname === '/api/leaderboard') {
      store
        .leaderboard(Number(url.searchParams.get('limit') ?? 20))
        .then((rows) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
          res.end(JSON.stringify(rows));
        })
        .catch((e) => {
          console.error('leaderboard failed:', e);
          res.writeHead(500).end('[]');
        });
      return;
    }
    // Static files; unknown paths fall back to index.html (invite links like /?t=CODE).
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404).end('Client not built. Run npm run build.');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', (ws: WebSocket) => {
    let token: string | null = null;
    let alive = true;
    // Messages from one connection are handled strictly in order.
    let chain: Promise<unknown> = Promise.resolve();
    const client = {
      send: (msg: unknown) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 20_000);
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return client.send({ t: 'error', message: 'Bad message' });
      }
      chain = chain.then(async () => {
        token = await lobby.handle(client, token, msg);
      });
    });
    ws.on('close', () => {
      clearInterval(ping);
      chain = chain.then(() => lobby.disconnect(client, token));
    });
  });

  const tick = setInterval(() => lobby.tick(), 1000);
  server.listen(opts.port);
  return {
    server,
    lobby,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(tick);
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => done());
      }),
  };
}
