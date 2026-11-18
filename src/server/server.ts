/**
 * HTTP + WebSocket server. Serves the built web client and runs the lobby.
 * One process, no database, no native modules: suitable for basic Node hosting.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { botFactory } from '../game/bots';
import { Lobby, type LobbyOptions } from '../game/lobby';
import type { ClientMessage } from '../game/protocol';
import type { TableDeps } from '../game/table';
import { loadModel } from '../ml/dmc';
import type { Mlp } from '../ml/mlp';
import { AccountService } from './accounts';
import { LogMailer } from './mailer';
import { MemoryRepo } from './store';

/** Sent with every page and file. The client uses inline style attributes, hence 'unsafe-inline' for styles only. */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** Per-connection message limit: bursts of 40, then 10 per second. */
class MessageBucket {
  private tokens = 40;
  private last = Date.now();
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(40, this.tokens + ((now - this.last) / 1000) * 10);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

const STARTED_AT = new Date().toISOString();
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

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
  /** A port number, or a socket path (some hosts pass one in PORT). */
  port: number | string;
  /** Directory with index.html, doughnut-client.js, styles. */
  publicDir: string;
  /** Path to the trained model (optional; bots fall back to the heuristic). */
  modelPath?: string;
  lobby?: Partial<LobbyOptions>;
  table?: Omit<TableDeps, 'onChange' | 'onGameOver' | 'makeBot'>;
  /** Accounts, games and ratings. Must already be initialised. Defaults to in-memory, emails logged. */
  store?: AccountService;
  /**
   * Websites allowed to connect when the pages are served from somewhere else
   * (e.g. https://example.com when the Node app is on another subdomain or port).
   * Pages served by this server itself are always allowed.
   */
  allowedOrigins?: string[];
  /**
   * The path the app is published under, when the host removes it before
   * requests reach Node (e.g. "/doughnut"). Usually not needed.
   */
  basePath?: string;
}

/** Origin "https://example.com" from any URL, or null. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
  const store = opts.store ?? new AccountService(new MemoryRepo(), new LogMailer(), { publicUrl: `http://localhost:${opts.port}` });
  const lobby = new Lobby({ ...opts.table, makeBot: botFactory(net) }, opts.lobby, store);
  const root = resolve(opts.publicDir);
  const allowed = new Set((opts.allowedOrigins ?? []).map((o) => originOf(o)).filter((o): o is string => !!o));
  /**
   * Pages served by this server (same host as the request, or as forwarded by a
   * proxy in front of it), or an allowed website. Browsers can't set
   * X-Forwarded-Host themselves, so this can't be faked from a web page.
   */
  const originOk = (origin: string | undefined, req: IncomingMessage) => {
    if (!origin) return true; // not a browser page (curl, health checks)
    const o = originOf(origin);
    if (!o) return false;
    if (allowed.has(o)) return true;
    const host = new URL(o).host;
    const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',').map((h) => h.trim());
    return host === req.headers.host || forwarded.includes(host);
  };

  /**
   * The page. It links its files relatively, so it gets a <base href> for the
   * folder it's served from: the path the browser asked for, with the host's
   * prefix added back if the host removed it (BASE_PATH or PASSENGER_BASE_URI).
   */
  const indexFile = join(root, 'index.html');
  const sendIndex = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (!existsSync(indexFile)) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`The game's pages are missing: ${indexFile} not found.`);
      return;
    }
    const prefix = (opts.basePath ?? '').replace(/\/+$/, '');
    let dir = pathname.endsWith('/') ? pathname : `${pathname}/`;
    if (prefix && !dir.startsWith(`${prefix}/`)) dir = `${prefix}${dir}`;
    dir = dir.replace(/\/{2,}/g, '/');
    const html = readFileSync(indexFile, 'utf8').replace('<head>', `<head>\n  <base href="${dir.replace(/[&<>"']/g, '')}" />`);
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
    res.end(html);
  };

  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const origin = req.headers.origin;
    if (origin && originOk(origin, req)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, HEAD', 'access-control-max-age': '86400' }).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    // Match by ending, so it works whether or not the host passes a path prefix
    // (e.g. a cPanel app mounted at /doughnut-server).
    if (url.pathname.endsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          version: VERSION,
          node: process.version,
          pages: existsSync(indexFile),
          basePath: opts.basePath ?? '',
          tables: lobby.tableCount,
          model: net !== null,
          store: store.repo.constructor.name,
          email: store.mailStatus(),
          // To spot hosts that restart the app or run several copies of it.
          instance: { pid: process.pid, startedAt: STARTED_AT },
        }),
      );
      return;
    }
    if (url.pathname.endsWith('/api/stats')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(lobby.stats()));
      return;
    }
    if (url.pathname.endsWith('/api/leaderboard')) {
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
    // Static files. The app may live under a path prefix (e.g. a cPanel app at
    // yourdomain.com/doughnut) that the host may or may not pass on, so look the
    // file up with leading path segments dropped one at a time.
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const segments = pathname.split('/').filter(Boolean);
    let file: string | null = null;
    for (let k = 0; k < segments.length && !file; k++) {
      const candidate = normalize(join(root, ...segments.slice(k)));
      if (candidate !== root && !candidate.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      if (existsSync(candidate) && statSync(candidate).isFile()) file = candidate;
    }
    if (!file) {
      // A missing script, stylesheet or data file is a 404, never the page (which
      // would make the browser fail with a confusing "MIME type" error).
      if (extname(pathname)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`Not found: ${pathname}`);
        return;
      }
      sendIndex(req, res, pathname);
      return;
    }
    if (extname(file) === '.html') {
      sendIndex(req, res, pathname);
      return;
    }
    // doughnut-client.js and styles.css are linked with ?v=<build hash>, so they can be cached for good.
    const versioned = url.searchParams.has('v');
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (!path.endsWith('/ws')) return socket.destroy();
    // Only pages from this server or an allowed website may open a game connection.
    if (!originOk(req.headers.origin, req)) {
      console.warn(`Refused a game connection from ${req.headers.origin} (not this site, PUBLIC_URL or ALLOWED_ORIGINS)`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket) => {
    let token: string | null = null;
    let alive = true;
    const bucket = new MessageBucket();
    let dropped = 0;
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
      if (!bucket.take()) {
        if (++dropped > 200) ws.close(1008, 'Too many messages');
        else if (dropped === 1) client.send({ t: 'error', message: 'Slow down a little' });
        return;
      }
      dropped = 0;
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
