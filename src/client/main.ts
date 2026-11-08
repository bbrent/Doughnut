/** Web client: home, quick-match queue, lobby and game table. */
import { MODES, RANKS, SUIT_SYMBOLS, rankOf, suitOf, type Card, type Move } from '../engine';
import type { AccountView, BotLevel, ClientMessage, ServerMessage, TableSettings, TableView, WireObservation } from '../game/protocol';
import { localConn, onlineConn, type Conn, type Status } from './conn';
import { chooseLayout, tableSvg } from './table-svg';

// ---- persistent per-browser settings ---------------------------------------

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

function randomToken(): string {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
}

const token = store('doughnut-token') ?? store('doughnut-token', randomToken())!;

// ---- app state --------------------------------------------------------------

type Screen = 'home' | 'queue' | 'table';
const st = {
  screen: 'home' as Screen,
  name: store('doughnut-name') ?? '',
  conn: null as Conn | null,
  practice: false,
  status: 'offline' as Status,
  table: null as TableView | null,
  queuePos: 0,
  joinCode: new URLSearchParams(location.search).get('t')?.toUpperCase() ?? '',
  /** Signed-in account; null = guest (nothing saved). */
  account: null as AccountView | null,
  /** Which account form is open on the home screen. */
  authForm: null as 'register' | 'login' | null,
  /** The nickname the server last accepted, to know when to re-introduce ourselves. */
  helloName: null as string | null,
  /** The account action in flight, for the confirmation message. */
  pendingAuth: null as 'register' | 'login' | null,
  ratingChange: null as number | null,
  leaders: null as { name: string; rating: number; games: number; wins: number }[] | null,
};

function loadLeaders() {
  fetch('api/leaderboard?limit=10')
    .then((r) => (r.ok ? r.json() : null))
    .then((rows) => {
      st.leaders = rows;
      if (st.screen === 'home') render();
    })
    .catch(() => {});
}

const app = document.getElementById('app')!;
const toastEl = document.getElementById('toast')!;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function onMessage(m: ServerMessage) {
  switch (m.t) {
    case 'welcome':
      if (st.practice) break;
      st.account = m.account;
      st.helloName = m.name;
      if (m.account) setName(m.account.nickname);
      break;
    case 'account': {
      const action = st.pendingAuth;
      st.pendingAuth = null;
      st.account = m.account;
      st.helloName = m.name;
      st.authForm = null;
      setName(m.name);
      toast(!m.account ? 'Logged out' : action === 'register' ? `Saved. Games as ${m.account.nickname} now count.` : `Logged in as ${m.account.nickname}`);
      loadLeaders();
      break;
    }
    case 'profile':
      if (st.account) st.account.profile = m.profile;
      st.ratingChange = m.ratingChange;
      if (m.ratingChange !== null && m.profile.rating !== null) {
        toast(`Rating ${m.profile.rating - m.ratingChange} → ${m.profile.rating} (${m.ratingChange >= 0 ? '+' : ''}${m.ratingChange})`);
      }
      loadLeaders();
      break;
    case 'table':
      st.table = m.table;
      st.screen = 'table';
      // Practice tables start straight away.
      if (st.practice && m.table.status === 'lobby') st.conn?.send({ t: 'start' });
      break;
    case 'queued':
      st.screen = 'queue';
      st.queuePos = m.position;
      break;
    case 'left':
      backHome();
      break;
    case 'error':
      st.pendingAuth = null;
      // Until the server accepts our nickname, later messages only add "Say hello first".
      if (st.helloName === null && m.message === 'Say hello first') break;
      toast(m.message);
      break;
  }
  render();
}

function backHome() {
  st.table = null;
  st.ratingChange = null;
  loadLeaders();
  st.screen = 'home';
  if (st.practice) {
    st.conn?.close();
    st.conn = null;
    st.practice = false;
  }
  history.replaceState(null, '', location.pathname);
}

function online(): Conn {
  if (st.practice) {
    st.conn?.close();
    st.conn = null;
    st.practice = false;
  }
  st.conn ??= onlineConn(
    () => ({ t: 'hello', token, name: st.name }),
    onMessage,
    (s) => {
      st.status = s;
      render();
    },
  );
  return st.conn;
}

async function practice(settings: TableSettings) {
  st.conn?.close();
  st.practice = true;
  st.conn = await localConn(onMessage);
  st.conn.send({ t: 'hello', token, name: st.name || 'You' });
  st.conn.send({ t: 'create', settings });
}

function send(msg: ClientMessage) {
  st.conn?.send(msg);
}

// ---- rendering helpers -------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const red = (c: Card) => suitOf(c) === 1 || suitOf(c) === 2;

function cardHtml(c: Card, opts: { action?: string; legal?: boolean; small?: boolean; extra?: string } = {}): string {
  const cls = ['card', red(c) ? 'red' : '', opts.small ? 'small' : '', opts.extra ?? ''];
  const inner = `${RANKS[rankOf(c)]}<span>${SUIT_SYMBOLS[suitOf(c)]}</span>`;
  if (!opts.action) return `<div class="${cls.join(' ')}" aria-label="${RANKS[rankOf(c)]} ${SUIT_SYMBOLS[suitOf(c)]}">${inner}</div>`;
  cls.push(opts.legal ? 'legal' : 'dim');
  return `<button class="${cls.join(' ')}" data-action="${opts.action}" data-card="${c}" ${opts.legal ? '' : 'disabled'}>${inner}</button>`;
}

/** Trump first, then other suits; high to low. */
function sortHand(cards: Card[], trump: number | null): Card[] {
  return cards.slice().sort((a, b) => {
    const sa = suitOf(a) === trump ? -1 : suitOf(a);
    const sb = suitOf(b) === trump ? -1 : suitOf(b);
    return sa - sb || rankOf(b) - rankOf(a);
  });
}

function selectOptions(values: (string | number)[], selected: string | number, label = (v: string | number) => String(v)) {
  return values.map((v) => `<option value="${v}" ${v == selected ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
}

const modeOptions = (sel: string) => selectOptions(Object.keys(MODES), sel, (id) => MODES[id as string].name);
const seatOptions = (sel: number) => selectOptions([2, 3, 4, 5, 6], sel, (n) => `${n} players`);
const levelOptions = (sel: string) =>
  selectOptions(['easy', 'medium', 'hard'], sel, (l) => ({ easy: 'Easy bots', medium: 'Medium bots', hard: 'Hard bots' })[l as BotLevel]);

// ---- screens -----------------------------------------------------------------

const insecure = location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname);

function identityHtml(): string {
  const invite = st.joinCode ? `<h2>You're invited to table <span class="code">${esc(st.joinCode)}</span></h2>` : '';
  const joinBtn = st.joinCode ? '<button class="primary" data-action="join" style="flex:0 0 auto">Join table</button>' : '';
  if (st.account) {
    const p = st.account.profile;
    return `<div class="panel stack" style="margin-bottom:16px">${invite}
      <div class="row" style="align-items:center">
        <div><strong>${esc(st.account.nickname)}</strong>
          <span class="pill">Rating ${p.rating} · ${p.games} game${p.games === 1 ? '' : 's'} · ${p.wins} win${p.wins === 1 ? '' : 's'}</span></div>
        ${joinBtn}<button data-action="logout" style="flex:0 0 auto">Log out</button>
      </div>
    </div>`;
  }
  const warn = insecure ? '<div class="small bad">This page isn\'t using HTTPS, so a password could be seen on the network.</div>' : '';
  let form = '';
  if (st.authForm === 'register') {
    form = `<div class="stack auth">
      <div class="small">Choose a password for <strong>${esc(st.name.trim() || 'your nickname')}</strong>. From then on your games and rating are saved, and nobody else can use this nickname.</div>
      <div class="row">
        <input id="pw1" type="password" autocomplete="new-password" placeholder="Password (6+ characters)" />
        <input id="pw2" type="password" autocomplete="new-password" placeholder="Repeat password" />
      </div>
      ${warn}
      <div class="row"><button class="primary" data-action="do-register">Save my nickname</button><button data-action="auth-cancel">Cancel</button></div>
    </div>`;
  } else if (st.authForm === 'login') {
    form = `<div class="stack auth">
      <div class="row">
        <input id="login-nick" autocomplete="username" maxlength="20" placeholder="Nickname" value="${esc(st.name)}" />
        <input id="login-pw" type="password" autocomplete="current-password" placeholder="Password" />
      </div>
      ${warn}
      <div class="row"><button class="primary" data-action="do-login">Log in</button><button data-action="auth-cancel">Cancel</button></div>
    </div>`;
  }
  return `<div class="panel stack" style="margin-bottom:16px">${invite}
    <label for="name">Nickname</label>
    <div class="row">
      <input id="name" maxlength="20" autocomplete="nickname" placeholder="Name shown at the table" value="${esc(st.name)}" />
      ${joinBtn}
    </div>
    ${
      form ||
      `<div class="small muted">Playing as a guest: your games aren't saved.
        <a href="#" data-action="auth-register">Save my progress</a> (set a password) ·
        <a href="#" data-action="auth-login">Log in</a></div>`
    }
  </div>`;
}

function homeHtml(): string {
  return `
  <h1><span class="ring"></span>Doughnut</h1>
  <p class="sub">A trick-taking race to zero. Take tricks, dodge doughnuts.</p>
  ${identityHtml()}
  <div class="grid">
    <div class="panel stack">
      <h2>Play online</h2>
      <button class="primary" data-action="quick">Quick match</button>
      <div class="small muted">Plays with whoever is waiting; bots fill empty seats after 10 seconds.</div>
      <hr style="border:none;border-top:1px solid var(--line)">
      <label>Join a table</label>
      <div class="row">
        <input id="code" placeholder="Code" maxlength="5" value="${esc(st.joinCode)}" style="text-transform:uppercase" />
        <button data-action="join">Join</button>
      </div>
    </div>
    <div class="panel stack">
      <h2>Private table</h2>
      <div class="row">
        <div><label for="o-mode">Mode</label><select id="o-mode">${modeOptions('doughnut')}</select></div>
        <div><label for="o-seats">Seats</label><select id="o-seats">${seatOptions(4)}</select></div>
      </div>
      <label for="o-level">Empty seats</label><select id="o-level">${levelOptions('hard')}</select>
      <button class="primary" data-action="create">Create table</button>
      <div class="small muted">You get a code and link to share. Empty seats become bots when you start.</div>
    </div>
    <div class="panel stack">
      <h2>Practice</h2>
      <div class="row">
        <div><label for="p-seats">Seats</label><select id="p-seats">${seatOptions(4)}</select></div>
        <div><label for="p-level">Bots</label><select id="p-level">${levelOptions('medium')}</select></div>
      </div>
      <label for="p-mode">Mode</label><select id="p-mode">${modeOptions('doughnut')}</select>
      <button data-action="practice">Play against bots</button>
      <div class="small muted">Runs entirely in your browser.</div>
    </div>
  </div>
  ${leadersHtml()}
  <details class="panel" style="margin-top:16px">
    <summary><strong>How to play</strong></summary>
    <ul>
      <li>Everyone starts at 20. Each trick you take is −1. Playing a hand and taking no tricks is a <em>doughnut</em>: +5.</li>
      <li>5 cards each; the next card is turned up and its suit is trump.</li>
      <li>If the turn-up is a 10 or Ace, everyone must play, and the dealer may swap a card for it.</li>
      <li>Otherwise each player chooses to play or fold. The dealer decides last: pick up the turn-up and play, or fold.</li>
      <li>Folding is free, unless your score is 5 or less: then it costs 1.</li>
      <li>Follow suit if you can. If you can't, play anything, including trump. Highest trump wins, else highest of the suit led.</li>
      <li>First to 0 wins.</li>
    </ul>
  </details>`;
}

function leadersHtml(): string {
  if (!st.leaders) return '';
  const rows = st.leaders.length
    ? `<table class="results"><tr><th>#</th><th>Player</th><th>Rating</th><th>Games</th><th>Wins</th></tr>${st.leaders
        .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.rating}</td><td>${r.games}</td><td>${r.wins}</td></tr>`)
        .join('')}</table>`
    : '<div class="muted small">No rated games yet. Games with two or more registered players are rated.</div>';
  return `<div class="panel" style="margin-top:16px"><h2>Leaderboard</h2>${rows}</div>`;
}

function queueHtml(): string {
  return `
  <div class="panel stack" style="max-width:420px;margin:40px auto;text-align:center">
    <h2>Finding players…</h2>
    <div class="muted">You're number ${st.queuePos} in the queue. Bots join if nobody shows up within 10 seconds.</div>
    <button data-action="leave">Cancel</button>
  </div>`;
}

function promptAndHand(t: TableView, o: WireObservation): string {
  const yourTurn = o.toAct === t.you && o.legalMoves.length > 0;
  const kinds = new Set(o.legalMoves.map((m) => m.kind));
  const trumpSym = o.trump === null ? '' : SUIT_SYMBOLS[o.trump];
  const name = esc(t.seats[o.toAct]?.name ?? '');
  const clock = t.deadline ? ` <span class="countdown muted" data-deadline="${t.deadline}"></span>` : '';
  const hand = sortHand(o.hand, o.trump);
  let prompt = '';
  let cards = hand.map((c) => cardHtml(c)).join('');

  if (!yourTurn) {
    if (o.phase === 'handOver' || o.phase === 'gameOver') prompt = '';
    else if (o.toAct >= 0) prompt = `<span class="muted">Waiting for ${name}…</span>`;
  } else if (kinds.has('pickup')) {
    const pickups = new Set(o.legalMoves.flatMap((m) => (m.kind === 'pickup' ? [m.discard] : [])));
    const fp = MODES[t.settings.mode].scoring.foldPenalty;
    const costs = fp && o.startScores[t.you] <= fp.atOrBelow;
    prompt = `<strong>You're the dealer.</strong> Pick up the ${trumpSym} turn-up by choosing a card to discard, or fold.${clock}
      <div class="actions"><button data-action="fold">Fold${costs ? ' (costs 1)' : ''}</button></div>`;
    cards = [...hand, o.turnUp].map((c) => cardHtml(c, { action: 'pickup', legal: pickups.has(c), extra: c === o.turnUp ? 'new' : '' })).join('');
  } else if (kinds.has('declare')) {
    const fp = MODES[t.settings.mode].scoring.foldPenalty;
    const costs = fp && o.startScores[t.you] <= fp.atOrBelow;
    prompt = `<strong>Play this hand or fold?</strong> Trump is ${trumpSym}.${costs ? ' Folding costs you 1 point.' : ''}${clock}
      <div class="actions"><button class="primary" data-action="play">Play</button><button data-action="fold">Fold</button></div>`;
  } else if (kinds.has('exchange')) {
    prompt = `<strong>${RANKS[rankOf(o.turnUp)]} turned up: everyone plays.</strong> Click a card to swap it for the turn-up, or keep your hand.${clock}
      <div class="actions"><button data-action="keep">Keep my hand</button></div>`;
    cards = hand.map((c) => cardHtml(c, { action: 'exchange', legal: true })).join('');
  } else if (kinds.has('card')) {
    const legal = new Set(o.legalMoves.flatMap((m) => (m.kind === 'card' ? [m.card] : [])));
    prompt = `<strong>Your turn.</strong>${legal.size < hand.length ? ' You must follow suit.' : ''}${clock}`;
    cards = hand.map((c) => cardHtml(c, { action: 'card', legal: legal.has(c) })).join('');
  }
  return `<div class="prompt">${prompt}</div><div class="hand">${cards}</div>`;
}

function resultsHtml(t: TableView, o: WireObservation): string {
  const h = t.lastHand;
  if (!h) return '';
  const rows = t.seats
    .map((s, i) => {
      const d = h.deltas[i];
      const what = !h.played[i] ? 'folded' : h.tricks[i] === 0 ? 'doughnut!' : `${h.tricks[i]} trick${h.tricks[i] === 1 ? '' : 's'}`;
      return `<tr><td>${esc(s.name)}${i === t.you ? ' (you)' : ''}</td><td>${what}</td><td class="${d < 0 ? 'good' : d > 0 ? 'bad' : ''}">${d > 0 ? '+' : ''}${d}</td><td>${o.scores[i]}</td></tr>`;
    })
    .join('');
  return `<table class="results"><tr><th>Player</th><th>Hand</th><th>Change</th><th>Score</th></tr>${rows}</table>`;
}

function tableHtml(t: TableView): string {
  const o = t.obs;
  const mode = MODES[t.settings.mode];
  const conn = st.practice ? 'practice' : st.status;
  const header = `<div class="bar">
      <div><strong>${esc(mode.name)}</strong> <span class="muted small">${st.practice ? 'practice' : `table ${t.code}`}${o ? ` · hand ${o.handsPlayed + (o.phase === 'handOver' || o.phase === 'gameOver' ? 0 : 1)}` : ''}</span></div>
      <div><span class="conn ${conn === 'offline' ? 'offline' : ''}">${conn === 'offline' ? 'reconnecting…' : conn}</span> <button data-action="leave">Leave</button></div>
    </div>`;
  const svg = tableSvg(t, chooseLayout(window.innerWidth));

  if (t.status === 'lobby') {
    const link = `${location.origin}${location.pathname}?t=${t.code}`;
    const isHost = t.you === t.hostSeat;
    const overlay = `<div class="overlay"><div class="overlay-card stack">
        <h2>Waiting for players</h2>
        <div>Share code <span class="code">${t.code}</span> or this link:</div>
        <div class="row"><input readonly value="${esc(link)}" id="invite" /><button data-action="copy">Copy</button></div>
        ${isHost ? `<div><button class="primary" data-action="start">Start game</button></div><div class="small muted">Open seats become ${t.settings.botLevel} bots.</div>` : '<div class="muted">The host will start the game.</div>'}
      </div></div>`;
    return `${header}<div class="table-wrap">${svg}${overlay}</div>`;
  }

  if (!o) return header;
  let overlay = '';
  let bottom = promptAndHand(t, o);
  if (t.status === 'over') {
    const winners = t.winners.map((w) => (w === t.you ? 'You' : esc(t.seats[w].name))).join(' & ');
    const rc = st.ratingChange;
    const ratingLine =
      rc !== null && st.account
        ? `<div class="small" style="margin-top:8px">Your rating: ${st.account.profile.rating} (${rc >= 0 ? '+' : ''}${rc})</div>`
        : !st.account && !st.practice
          ? '<div class="small muted" style="margin-top:8px">Playing as a guest, so this game wasn\'t saved. Set a password for your nickname on the home screen to keep your record.</div>'
          : '';
    overlay = `<div class="overlay"><div class="overlay-card"><h2>${winners} win${t.winners.length === 1 && t.winners[0] !== t.you ? 's' : ''}!</h2>${resultsHtml(t, o)}${ratingLine}</div></div>`;
    bottom = `<div class="prompt"><div class="actions">${t.you === t.hostSeat ? '<button class="primary" data-action="start">Play again</button>' : '<span class="muted">The host can start a rematch.</span>'}<button data-action="leave">Leave</button></div></div>`;
  } else if (o.phase === 'handOver') {
    overlay = `<div class="overlay"><div class="overlay-card"><h2>Hand over</h2>${resultsHtml(t, o)}<div class="small muted" style="margin-top:6px">Next hand starting…</div></div></div>`;
    bottom = '';
  }
  return `${header}<div class="table-wrap">${svg}${overlay}</div>${bottom ? `<div class="below">${bottom}</div>` : ''}`;
}

function render() {
  const focused = document.activeElement?.id;
  app.innerHTML = st.screen === 'home' ? homeHtml() : st.screen === 'queue' ? queueHtml() : st.table ? tableHtml(st.table) : homeHtml();
  if (focused) (document.getElementById(focused) as HTMLInputElement | null)?.focus();
  tickCountdown();
}

function tickCountdown() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-deadline]')) {
    const s = Math.max(0, Math.ceil((Number(el.dataset.deadline) - Date.now()) / 1000));
    el.textContent = s <= 15 ? `${s}s` : '';
  }
}
setInterval(tickCountdown, 250);

let lastPortrait = window.innerWidth < 640;
window.addEventListener('resize', () => {
  const portrait = window.innerWidth < 640;
  if (portrait !== lastPortrait && st.screen === 'table') render();
  lastPortrait = portrait;
});

// ---- actions -----------------------------------------------------------------

const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';

function setName(n: string) {
  st.name = n;
  store('doughnut-name', n);
}

/** Make sure we have a nickname, and that the server knows the current one. */
function needName(): boolean {
  if (!st.account) setName((val('name') || st.name).trim());
  if (st.name.length < 2) {
    toast('Pick a nickname first');
    document.getElementById('name')?.focus();
    return true;
  }
  if (st.conn && !st.practice && st.helloName !== st.name) {
    st.conn.send({ t: 'hello', token, name: st.name });
  }
  return false;
}

function move(m: Move) {
  send({ t: 'move', move: m });
}

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  if (el.tagName === 'A') e.preventDefault();
  const card = Number(el.dataset.card);
  switch (el.dataset.action) {
    case 'auth-register':
    case 'auth-login':
      st.name = val('name').trim() || st.name;
      st.authForm = el.dataset.action === 'auth-register' ? 'register' : 'login';
      render();
      document.getElementById(st.authForm === 'register' ? 'pw1' : 'login-pw')?.focus();
      return;
    case 'auth-cancel':
      st.authForm = null;
      render();
      return;
    case 'do-register': {
      if (needName()) return;
      const pw = val('pw1');
      if (pw.length < 6) return toast('Use a password of at least 6 characters');
      if (pw !== val('pw2')) return toast("The passwords don't match");
      st.pendingAuth = 'register';
      online().send({ t: 'register', password: pw });
      return;
    }
    case 'do-login': {
      const nickname = val('login-nick').trim();
      const password = val('login-pw');
      if (!nickname || !password) return toast('Enter your nickname and password');
      st.pendingAuth = 'login';
      online().send({ t: 'login', nickname, password });
      return;
    }
    case 'logout':
      send({ t: 'logout' });
      return;
    case 'quick':
      if (needName()) return;
      online().send({ t: 'quick', mode: 'doughnut' });
      break;
    case 'join': {
      if (needName()) return;
      const code = (val('code') || st.joinCode).trim().toUpperCase();
      if (!code) return toast('Enter a table code');
      online().send({ t: 'join', code });
      break;
    }
    case 'create':
      if (needName()) return;
      online().send({ t: 'create', settings: { mode: val('o-mode'), seats: Number(val('o-seats')), botLevel: val('o-level') as BotLevel } });
      break;
    case 'practice':
      st.name = val('name').trim() || st.name;
      if (st.name) store('doughnut-name', st.name);
      void practice({ mode: val('p-mode'), seats: Number(val('p-seats')), botLevel: val('p-level') as BotLevel });
      break;
    case 'start':
      st.ratingChange = null;
      send({ t: 'start' });
      break;
    case 'leave':
      if (st.practice) {
        backHome();
        render();
      } else send({ t: 'leave' });
      break;
    case 'copy': {
      const input = document.getElementById('invite') as HTMLInputElement;
      navigator.clipboard?.writeText(input.value).then(
        () => toast('Link copied'),
        () => input.select(),
      );
      break;
    }
    case 'play':
      move({ kind: 'declare', play: true });
      break;
    case 'fold':
      move({ kind: 'declare', play: false });
      break;
    case 'keep':
      move({ kind: 'exchange', discard: null });
      break;
    case 'pickup':
      move({ kind: 'pickup', discard: card });
      break;
    case 'exchange':
      move({ kind: 'exchange', discard: card });
      break;
    case 'card':
      move({ kind: 'card', card });
      break;
  }
});

app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'name') setName(t.value);
  if (t.id === 'code') st.joinCode = t.value.toUpperCase();
});

// Rejoin an in-progress online game after a reload, or open an invite link.
if (st.joinCode && st.name) online().send({ t: 'join', code: st.joinCode });
else if (store('doughnut-online') === '1' || st.name) online();
loadLeaders();
window.addEventListener('beforeunload', () => store('doughnut-online', st.table && !st.practice ? '1' : '0'));
render();
