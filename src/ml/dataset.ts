/**
 * Search data on disk stores the raw Observation (what the deciding player
 * could see), not encoded features. Features are computed when training
 * loads the data, so the encoding can change without re-running the search.
 *
 * Record layout (little-endian; 255 = none for optional bytes):
 *   u8 n, u8 player, u8 dealer, u8 toAct, u8 phase, u16 handsPlayed, u8 flags(forced|dealerTookTurnUp<<1)
 *   u8 turnUp, u8 trump, u8 ownDiscard, u8 trickLeader
 *   per player: i16 score, i16 startScore, u8 handSize, u8 playing(0 no,1 yes,2 undecided), u8 tricksWon, u8 voidMask
 *   u8 nHand, cards
 *   u8 nCurrent, (player, card)...
 *   u8 nTricks, per trick: u8 leader, u8 winner, u8 nPlays, (player, card)...
 *   u8 nMoves, per move: u8 kind, u8 card, f32 value, u32 visits, u8 chosen
 *   f32 outcome
 */
import type { GameConfig, Move, Observation, Phase } from '../engine';
import { encodeAction, encodeState, makeContext } from './features';

export const DATA_FORMAT = 2;

export interface Sparse {
  idx: Uint16Array;
  val: Float32Array;
}

export interface MoveStats {
  /** Mean search reward for this move. */
  value: number;
  visits: number;
  chosen: boolean;
}

/** One searched decision, as stored. `moves[i]` corresponds to `obs.legalMoves[i]`. */
export interface SearchRecord {
  obs: Observation;
  moves: MoveStats[];
  /** Actual end-of-hand reward for the player who decided. */
  outcome: number;
}

/** A record with features computed (for training). */
export interface Decision {
  state: Sparse;
  actions: (MoveStats & { feat: Sparse })[];
  outcome: number;
}

export function toSparse(dense: Float32Array): Sparse {
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < dense.length; i++) {
    if (dense[i] !== 0) {
      idx.push(i);
      val.push(dense[i]);
    }
  }
  return { idx: Uint16Array.from(idx), val: Float32Array.from(val) };
}

/** Write a sparse vector into `out` starting at `offset` (out must be zeroed). */
export function scatter(s: Sparse, out: Float32Array, offset = 0): void {
  for (let i = 0; i < s.idx.length; i++) out[offset + s.idx[i]] = s.val[i];
}

/** Compute features with the current encoding. */
export function featurize(r: SearchRecord): Decision {
  const ctx = makeContext(r.obs);
  return {
    state: toSparse(encodeState(ctx)),
    actions: r.obs.legalMoves.map((m, i) => ({ ...r.moves[i], feat: toSparse(encodeAction(ctx, m)) })),
    outcome: r.outcome,
  };
}

const PHASES: Phase[] = ['exchange', 'declare', 'play', 'handOver', 'gameOver'];
const NONE = 255;

class ByteWriter {
  private buf = new ArrayBuffer(1 << 16);
  private view = new DataView(this.buf);
  private at = 0;
  private ensure(n: number) {
    if (this.at + n <= this.buf.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.at + n));
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.at));
    this.buf = next;
    this.view = new DataView(next);
  }
  u8(x: number) {
    this.ensure(1);
    this.view.setUint8(this.at++, x);
  }
  u16(x: number) {
    this.ensure(2);
    this.view.setUint16(this.at, x, true);
    this.at += 2;
  }
  i16(x: number) {
    this.ensure(2);
    this.view.setInt16(this.at, x, true);
    this.at += 2;
  }
  u32(x: number) {
    this.ensure(4);
    this.view.setUint32(this.at, x, true);
    this.at += 4;
  }
  f32(x: number) {
    this.ensure(4);
    this.view.setFloat32(this.at, x, true);
    this.at += 4;
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.buf.slice(0, this.at));
  }
}

const opt = (x: number | null) => (x === null ? NONE : x);
const unopt = (x: number) => (x === NONE ? null : x);

function encodeMove(m: Move): [number, number] {
  switch (m.kind) {
    case 'exchange':
      return [0, opt(m.discard)];
    case 'declare':
      return [m.play ? 1 : 2, NONE];
    case 'pickup':
      return [3, m.discard];
    case 'card':
      return [4, m.card];
  }
}

function decodeMove(kind: number, card: number): Move {
  switch (kind) {
    case 0:
      return { kind: 'exchange', discard: unopt(card) };
    case 1:
      return { kind: 'declare', play: true };
    case 2:
      return { kind: 'declare', play: false };
    case 3:
      return { kind: 'pickup', discard: card };
    case 4:
      return { kind: 'card', card };
    default:
      throw new RangeError(`bad move kind ${kind}`);
  }
}

export function encodeRecords(rs: SearchRecord[]): Uint8Array {
  const w = new ByteWriter();
  for (const { obs: o, moves, outcome } of rs) {
    const n = o.numPlayers;
    w.u8(n);
    w.u8(o.player);
    w.u8(o.dealer);
    w.u8(o.toAct);
    w.u8(PHASES.indexOf(o.phase));
    w.u16(o.handsPlayed);
    w.u8((o.forced ? 1 : 0) | (o.dealerTookTurnUp ? 2 : 0));
    w.u8(o.turnUp);
    w.u8(opt(o.trump));
    w.u8(opt(o.ownDiscard));
    w.u8(o.trickLeader < 0 ? NONE : o.trickLeader);
    for (let p = 0; p < n; p++) {
      w.i16(o.scores[p]);
      w.i16(o.startScores[p]);
      w.u8(o.handSizes[p]);
      w.u8(o.playing[p] === null ? 2 : o.playing[p] ? 1 : 0);
      w.u8(o.tricksWon[p]);
      w.u8(o.voids[p].reduce((m, v, s) => m | (v ? 1 << s : 0), 0));
    }
    w.u8(o.hand.length);
    for (const c of o.hand) w.u8(c);
    w.u8(o.currentTrick.length);
    for (const pl of o.currentTrick) {
      w.u8(pl.player);
      w.u8(pl.card);
    }
    w.u8(o.tricks.length);
    for (const t of o.tricks) {
      w.u8(t.leader);
      w.u8(t.winner);
      w.u8(t.plays.length);
      for (const pl of t.plays) {
        w.u8(pl.player);
        w.u8(pl.card);
      }
    }
    w.u8(o.legalMoves.length);
    o.legalMoves.forEach((m, i) => {
      const [k, c] = encodeMove(m);
      w.u8(k);
      w.u8(c);
      w.f32(moves[i].value);
      w.u32(moves[i].visits);
      w.u8(moves[i].chosen ? 1 : 0);
    });
    w.f32(outcome);
  }
  return w.bytes();
}

/** Decode records. A truncated final record (file still being written) is dropped. */
export function decodeRecords(bytes: Uint8Array, config: GameConfig): SearchRecord[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u8 = () => v.getUint8(at++);
  const u16 = () => ((at += 2), v.getUint16(at - 2, true));
  const i16 = () => ((at += 2), v.getInt16(at - 2, true));
  const u32 = () => ((at += 4), v.getUint32(at - 4, true));
  const f32 = () => ((at += 4), v.getFloat32(at - 4, true));
  const plays = (k: number) => Array.from({ length: k }, () => ({ player: u8(), card: u8() }));

  const out: SearchRecord[] = [];
  while (at < bytes.byteLength) {
    const start = at;
    try {
      const n = u8();
      const player = u8();
      const dealer = u8();
      const toAct = u8();
      const phase = PHASES[u8()];
      const handsPlayed = u16();
      const flags = u8();
      const turnUp = u8();
      const trump = unopt(u8());
      const ownDiscard = unopt(u8());
      const tl = u8();
      const scores: number[] = [];
      const startScores: number[] = [];
      const handSizes: number[] = [];
      const playing: (boolean | null)[] = [];
      const tricksWon: number[] = [];
      const voids: boolean[][] = [];
      for (let p = 0; p < n; p++) {
        scores.push(i16());
        startScores.push(i16());
        handSizes.push(u8());
        const pl = u8();
        playing.push(pl === 2 ? null : pl === 1);
        tricksWon.push(u8());
        const vm = u8();
        voids.push([0, 1, 2, 3].map((s) => (vm & (1 << s)) !== 0));
      }
      const hand = Array.from({ length: u8() }, u8);
      const currentTrick = plays(u8());
      const tricks = Array.from({ length: u8() }, () => {
        const leader = u8();
        const winner = u8();
        return { leader, winner, plays: plays(u8()) };
      });
      const legalMoves: Move[] = [];
      const moves: MoveStats[] = [];
      const nm = u8();
      for (let i = 0; i < nm; i++) {
        const k = u8();
        legalMoves.push(decodeMove(k, u8()));
        moves.push({ value: f32(), visits: u32(), chosen: u8() === 1 });
      }
      const outcome = f32();
      out.push({
        obs: {
          config,
          numPlayers: n,
          player,
          scores,
          startScores,
          handsPlayed,
          dealer,
          phase,
          toAct,
          hand,
          handSizes,
          turnUp,
          trump,
          forced: (flags & 1) !== 0,
          dealerTookTurnUp: (flags & 2) !== 0,
          ownDiscard,
          playing,
          currentTrick,
          trickLeader: tl === NONE ? -1 : tl,
          tricks,
          tricksWon,
          voids,
          legalMoves,
        },
        moves,
        outcome,
      });
    } catch (e) {
      if (e instanceof RangeError && start > 0 && at > bytes.byteLength - 1) break;
      throw e;
    }
  }
  return out;
}
