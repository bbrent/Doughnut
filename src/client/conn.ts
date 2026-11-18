/** Connections: online (WebSocket to the server) or local (practice, in-browser lobby). */
import { botFactory } from '../game/bots';
import { Lobby, type Client } from '../game/lobby';
import type { ClientMessage, ServerMessage } from '../game/protocol';
import { loadModel } from '../ml/dmc';
import type { Mlp } from '../ml/mlp';
import { serverWs } from './server-url';

export interface Conn {
  send(msg: ClientMessage): void;
  close(): void;
}

export type Status = 'connecting' | 'online' | 'offline' | 'unreachable';

/** WebSocket connection that reconnects and re-introduces itself automatically. */
/**
 * WebSocket connection that reconnects and re-introduces itself automatically.
 *
 * Phones freeze background tabs and can drop the connection without the page
 * noticing, so: while visible it pings every 15 s and reconnects if nothing
 * comes back within 8 s; and when the tab becomes visible again (or the
 * device comes back online) it checks at once instead of waiting.
 */
export function onlineConn(
  hello: () => ClientMessage,
  onMessage: (m: ServerMessage) => void,
  onStatus: (s: Status) => void,
): Conn {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHeard = Date.now();
  let pingSentAt = 0;
  const pending: ClientMessage[] = [];
  const url = serverWs();

  const open = () => {
    clearTimeout(retryTimer);
    if (closed) return;
    onStatus('connecting');
    const sock = new WebSocket(url);
    ws = sock;
    const openedAt = Date.now();
    // A connection stuck "connecting" (e.g. after the tab was frozen) is replaced.
    const stuck = setTimeout(() => {
      if (ws === sock && sock.readyState === WebSocket.CONNECTING && Date.now() - openedAt >= 8000) sock.close();
    }, 8000);
    sock.onopen = () => {
      clearTimeout(stuck);
      retry = 500;
      failures = 0;
      lastHeard = Date.now();
      pingSentAt = 0;
      onStatus('online');
      sock.send(JSON.stringify(hello()));
      while (pending.length) sock.send(JSON.stringify(pending.shift()));
    };
    sock.onmessage = (e) => {
      lastHeard = Date.now();
      pingSentAt = 0;
      const m = JSON.parse(e.data) as ServerMessage;
      if (m.t !== 'pong') onMessage(m);
    };
    sock.onclose = () => {
      clearTimeout(stuck);
      if (ws !== sock) return; // an old socket we already replaced
      ws = null;
      if (closed) return;
      // Repeated failures without ever connecting usually mean a setup problem, not a blip.
      if (++failures === 4) onStatus('unreachable');
      else onStatus(failures > 4 ? 'unreachable' : 'offline');
      retryTimer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };

  /**
   * Make sure the connection is alive: reconnect if it isn't, or ping it.
   * `now`: the tab just came back, so skip the usual pause between retries.
   */
  const check = (now = false) => {
    if (closed) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (!now) return; // the retry timer is already on its way
      retry = 500;
      return open();
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (pingSentAt && Date.now() - pingSentAt > 8000) {
      // No answer to the last ping: the connection is dead even if it looks open.
      const dead = ws;
      ws = null;
      dead.onclose = null;
      try {
        dead.close();
      } catch {}
      retry = 500;
      return open();
    }
    if (!pingSentAt && Date.now() - lastHeard > 10_000) {
      pingSentAt = Date.now();
      ws.send(JSON.stringify({ t: 'ping' }));
    }
  };
  const heartbeat = setInterval(() => {
    if (document.visibilityState === 'visible') check();
  }, 5000);
  const wake = () => {
    if (document.visibilityState !== 'visible') return;
    lastHeard = 0; // ping straight away
    check(true);
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  open();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else {
        pending.push(msg);
        check();
      }
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      ws?.close();
    },
  };
}

let netPromise: Promise<Mlp | null> | null = null;
function loadNet(): Promise<Mlp | null> {
  netPromise ??= fetch('models/doughnut.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j ? loadModel(j) : null))
    .catch(() => null);
  return netPromise;
}

/** Practice: the same lobby and table code, running entirely in the browser. */
export async function localConn(onMessage: (m: ServerMessage) => void): Promise<Conn> {
  // No turn timer in practice: nobody is waiting on you.
  const lobby = new Lobby({ makeBot: botFactory(await loadNet()), timing: { turnMs: 24 * 3600_000 } });
  const client: Client = { send: (m) => onMessage(m) };
  let token: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (msg: ClientMessage) => (chain = chain.then(async () => (token = await lobby.handle(client, token, msg))));
  return {
    send: enqueue,
    close() {
      if (token) enqueue({ t: 'leave' });
    },
  };
}
