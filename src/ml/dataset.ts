/**
 * Compact binary format for ISMCTS search data. Features are mostly zeros, so
 * vectors are stored sparse (u16 index + f32 value).
 *
 * Decision record:
 *   u16 nState, nState x (u16 idx, f32 val)
 *   u8  nActions, per action: u8 n, n x (u16 idx, f32 val), f32 value, u32 visits, u8 chosen
 *   f32 outcome
 */
export interface Sparse {
  idx: Uint16Array;
  val: Float32Array;
}

export interface SearchedAction {
  feat: Sparse;
  /** Mean search reward for this move. */
  value: number;
  visits: number;
  chosen: boolean;
}

export interface Decision {
  state: Sparse;
  actions: SearchedAction[];
  /** Actual end-of-hand reward for the player who decided. */
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
    this.view.setUint8(this.at, x);
    this.at += 1;
  }
  u16(x: number) {
    this.ensure(2);
    this.view.setUint16(this.at, x, true);
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

function writeSparse(w: ByteWriter, s: Sparse, wide: boolean) {
  if (wide) w.u16(s.idx.length);
  else w.u8(s.idx.length);
  for (let i = 0; i < s.idx.length; i++) {
    w.u16(s.idx[i]);
    w.f32(s.val[i]);
  }
}

export function encodeDecisions(ds: Decision[]): Uint8Array {
  const w = new ByteWriter();
  for (const d of ds) {
    writeSparse(w, d.state, true);
    w.u8(d.actions.length);
    for (const a of d.actions) {
      writeSparse(w, a.feat, false);
      w.f32(a.value);
      w.u32(a.visits);
      w.u8(a.chosen ? 1 : 0);
    }
    w.f32(d.outcome);
  }
  return w.bytes();
}

export function decodeDecisions(bytes: Uint8Array): Decision[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const readSparse = (wide: boolean): Sparse => {
    const n = wide ? v.getUint16(at, true) : v.getUint8(at);
    at += wide ? 2 : 1;
    const idx = new Uint16Array(n);
    const val = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      idx[i] = v.getUint16(at, true);
      val[i] = v.getFloat32(at + 2, true);
      at += 6;
    }
    return { idx, val };
  };
  const out: Decision[] = [];
  while (at < bytes.byteLength) {
    const start = at;
    try {
    const state = readSparse(true);
    const nA = v.getUint8(at++);
    const actions: SearchedAction[] = [];
    for (let k = 0; k < nA; k++) {
      const feat = readSparse(false);
      const value = v.getFloat32(at, true);
      const visits = v.getUint32(at + 4, true);
      const chosen = v.getUint8(at + 8) === 1;
      at += 9;
      actions.push({ feat, value, visits, chosen });
    }
    const outcome = v.getFloat32(at, true);
    at += 4;
    out.push({ state, actions, outcome });
    } catch (e) {
      // A truncated final record (file still being written): drop it.
      if (e instanceof RangeError && start > 0) break;
      throw e;
    }
  }
  return out;
}
