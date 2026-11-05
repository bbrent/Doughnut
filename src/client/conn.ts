/** Connections: online (WebSocket to the server) or local (practice, in-browser lobby). */
import { botFactory } from '../game/bots';
import { Lobby, type Client } from '../game/lobby';
import type { ClientMessage, ServerMessage } from '../game/protocol';
import { loadModel } from '../ml/dmc';
import type { Mlp } from '../ml/mlp';

export interface Conn {
  send(msg: ClientMessage): void;
  close(): void;
}

export type Status = 'connecting' | 'online' | 'offline';

/** WebSocket connection that reconnects and re-introduces itself automatically. */
export function onlineConn(
  hello: () => ClientMessage,
  onMessage: (m: ServerMessage) => void,
  onStatus: (s: Status) => void,
): Conn {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  const pending: ClientMessage[] = [];
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const open = () => {
    onStatus('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 500;
      onStatus('online');
      ws!.send(JSON.stringify(hello()));
      while (pending.length) ws!.send(JSON.stringify(pending.shift()));
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      onStatus('offline');
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  open();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else pending.push(msg);
    },
    close() {
      closed = true;
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
  return {
    send(msg) {
      queueMicrotask(() => (token = lobby.handle(client, token, msg)));
    },
    close() {
      if (token) lobby.handle(client, token, { t: 'leave' });
    },
  };
}
