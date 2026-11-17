/**
 * Where the game server (the Node app) is. Set in index.html:
 *   <meta name="doughnut-server" content="https://example.com/doughnut-server">
 * Empty means "the server that sent this page", relative to the page's folder
 * (its <base href>).
 */
function base(): URL {
  const meta = document.querySelector('meta[name="doughnut-server"]')?.getAttribute('content')?.trim();
  // document.baseURI honours the <base href> the server adds for path prefixes.
  const u = new URL(meta || '.', document.baseURI);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

/** An HTTP address on the game server, e.g. api('api/leaderboard'). */
export const serverHttp = (path: string) => new URL(path, base()).href;

/** The game server's WebSocket address. */
export function serverWs(): string {
  const u = new URL('ws', base());
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}
