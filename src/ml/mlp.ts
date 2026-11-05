/**
 * Small dependency-free MLP (ReLU hidden layers, linear scalar output) with
 * Adam. Runs identically in Node (training) and the browser (inference).
 *
 * Weights are stored input-major (W[i * out + o]) so sparse inputs can skip
 * zero entries, which most of our features are.
 */
import type { Rng } from '../engine';

export interface MlpJSON {
  format: 'doughnut-mlp';
  sizes: number[];
  /** Base64 Float32 little-endian, W then b per layer. */
  weights: string[];
  meta?: Record<string, unknown>;
}

export class Mlp {
  readonly W: Float32Array[];
  readonly b: Float32Array[];
  private m: Float32Array[] = [];
  private v: Float32Array[] = [];
  private step = 0;

  constructor(readonly sizes: number[]) {
    this.W = [];
    this.b = [];
    for (let l = 0; l + 1 < sizes.length; l++) {
      this.W.push(new Float32Array(sizes[l] * sizes[l + 1]));
      this.b.push(new Float32Array(sizes[l + 1]));
    }
  }

  static create(sizes: number[], rng: Rng): Mlp {
    const net = new Mlp(sizes);
    net.W.forEach((w, l) => {
      const std = Math.sqrt(2 / sizes[l]);
      for (let i = 0; i < w.length; i++) w[i] = gaussian(rng) * std;
    });
    return net;
  }

  get inputSize(): number {
    return this.sizes[0];
  }

  /** Forward one input. `acts` optionally receives each layer's activations. */
  predict(x: Float32Array, acts?: Float32Array[]): number {
    let a = x;
    acts?.push(a);
    const L = this.W.length;
    for (let l = 0; l < L; l++) {
      const out = this.sizes[l + 1];
      const z = this.b[l].slice();
      const W = this.W[l];
      for (let i = 0; i < a.length; i++) {
        const xi = a[i];
        if (xi === 0) continue;
        const row = i * out;
        for (let o = 0; o < out; o++) z[o] += xi * W[row + o];
      }
      if (l < L - 1) for (let o = 0; o < out; o++) if (z[o] < 0) z[o] = 0;
      a = z;
      acts?.push(a);
    }
    return a[0];
  }

  /**
   * Score many inputs that share a prefix (the state) and differ in a suffix
   * (the action). The first layer's state part is computed once.
   */
  predictShared(prefix: Float32Array, suffixes: Float32Array[]): number[] {
    const h = this.sizes[1];
    const W0 = this.W[0];
    const base = this.b[0].slice();
    for (let i = 0; i < prefix.length; i++) {
      const xi = prefix[i];
      if (xi === 0) continue;
      const row = i * h;
      for (let o = 0; o < h; o++) base[o] += xi * W0[row + o];
    }
    return suffixes.map((suf) => {
      const z = base.slice();
      for (let j = 0; j < suf.length; j++) {
        const xj = suf[j];
        if (xj === 0) continue;
        const row = (prefix.length + j) * h;
        for (let o = 0; o < h; o++) z[o] += xj * W0[row + o];
      }
      for (let o = 0; o < h; o++) if (z[o] < 0) z[o] = 0;
      return this.forwardFrom(1, z);
    });
  }

  private forwardFrom(l0: number, a: Float32Array): number {
    const L = this.W.length;
    for (let l = l0; l < L; l++) {
      const out = this.sizes[l + 1];
      const z = this.b[l].slice();
      const W = this.W[l];
      for (let i = 0; i < a.length; i++) {
        const xi = a[i];
        if (xi === 0) continue;
        const row = i * out;
        for (let o = 0; o < out; o++) z[o] += xi * W[row + o];
      }
      if (l < L - 1) for (let o = 0; o < out; o++) if (z[o] < 0) z[o] = 0;
      a = z;
    }
    return a[0];
  }

  /**
   * Gradients for any loss on the batch outputs. `lossGrad` gets the
   * predictions and returns the loss and dLoss/dPrediction for each.
   */
  gradientsFor(
    xs: Float32Array[],
    lossGrad: (yhat: number[]) => { loss: number; dy: number[] },
  ): { gW: Float32Array[]; gb: Float32Array[]; loss: number } {
    const L = this.W.length;
    const gW = this.W.map((w) => new Float32Array(w.length));
    const gb = this.b.map((b) => new Float32Array(b.length));
    const allActs: Float32Array[][] = [];
    const yhat = xs.map((x) => {
      const acts: Float32Array[] = [];
      const y = this.predict(x, acts);
      allActs.push(acts);
      return y;
    });
    const { loss, dy } = lossGrad(yhat);
    for (let n = 0; n < xs.length; n++) {
      if (dy[n] === 0) continue;
      const acts = allActs[n];
      let delta = new Float32Array([dy[n]]);
      for (let l = L - 1; l >= 0; l--) {
        const a = acts[l];
        const out = this.sizes[l + 1];
        const W = this.W[l];
        const g = gW[l];
        const gbl = gb[l];
        for (let o = 0; o < out; o++) gbl[o] += delta[o];
        const prev = l > 0 ? new Float32Array(a.length) : null;
        for (let i = 0; i < a.length; i++) {
          const ai = a[i];
          if (ai === 0) continue; // zero input or inactive ReLU: no gradient
          const row = i * out;
          let s = 0;
          for (let o = 0; o < out; o++) {
            g[row + o] += ai * delta[o];
            s += W[row + o] * delta[o];
          }
          if (prev) prev[i] = s; // hidden ai > 0, so ReLU' = 1
        }
        if (prev) delta = prev;
      }
    }
    return { gW, gb, loss };
  }

  /** Gradients of mean squared error over a batch. */
  gradients(xs: Float32Array[], ys: number[]): { gW: Float32Array[]; gb: Float32Array[]; loss: number } {
    const B = xs.length;
    return this.gradientsFor(xs, (yhat) => ({
      loss: yhat.reduce((a, y, n) => a + (y - ys[n]) ** 2, 0) / B,
      dy: yhat.map((y, n) => (2 * (y - ys[n])) / B),
    }));
  }

  /** One Adam step on mean squared error. Returns the batch loss. */
  trainBatch(xs: Float32Array[], ys: number[], lr = 1e-3): number {
    const { gW, gb, loss } = this.gradients(xs, ys);
    this.adam(gW, gb, lr);
    return loss;
  }

  /** One Adam step on a custom loss (see gradientsFor). Returns the loss. */
  trainWith(xs: Float32Array[], lossGrad: (yhat: number[]) => { loss: number; dy: number[] }, lr = 1e-3): number {
    const { gW, gb, loss } = this.gradientsFor(xs, lossGrad);
    this.adam(gW, gb, lr);
    return loss;
  }

  private adam(gW: Float32Array[], gb: Float32Array[], lr: number, beta1 = 0.9, beta2 = 0.999, eps = 1e-8): void {
    const params = [...this.W, ...this.b];
    const grads = [...gW, ...gb];
    if (!this.m.length) {
      this.m = params.map((p) => new Float32Array(p.length));
      this.v = params.map((p) => new Float32Array(p.length));
    }
    this.step++;
    const c1 = 1 - beta1 ** this.step;
    const c2 = 1 - beta2 ** this.step;
    for (let k = 0; k < params.length; k++) {
      const p = params[k];
      const g = grads[k];
      const m = this.m[k];
      const v = this.v[k];
      for (let i = 0; i < p.length; i++) {
        m[i] = beta1 * m[i] + (1 - beta1) * g[i];
        v[i] = beta2 * v[i] + (1 - beta2) * g[i] * g[i];
        p[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + eps);
      }
    }
  }

  copyWeightsFrom(other: Mlp): void {
    other.W.forEach((w, l) => this.W[l].set(w));
    other.b.forEach((b, l) => this.b[l].set(b));
  }

  toJSON(meta?: Record<string, unknown>): MlpJSON {
    const weights: string[] = [];
    this.W.forEach((w, l) => weights.push(toBase64(w), toBase64(this.b[l])));
    return { format: 'doughnut-mlp', sizes: this.sizes, weights, meta };
  }

  static fromJSON(j: MlpJSON): Mlp {
    if (j.format !== 'doughnut-mlp') throw new Error('Not a doughnut-mlp model');
    const net = new Mlp(j.sizes);
    net.W.forEach((w, l) => {
      w.set(fromBase64(j.weights[2 * l]));
      net.b[l].set(fromBase64(j.weights[2 * l + 1]));
    });
    return net;
  }
}

function gaussian(rng: Rng): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// btoa/atob exist in both browsers and Node 16+.
function toBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
