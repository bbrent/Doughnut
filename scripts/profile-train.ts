// Where does training time go? npx tsx scripts/profile-train.ts
import { DOUGHNUT, applyUnchecked, mulberry32, newGame, observe } from '../src/engine';
import { argmax, concatInput, createModel, evaluateMoves } from '../src/ml';
const rng = mulberry32(1);
const net = createModel(rng);
const xs: Float32Array[] = [];
let t = performance.now();
const H = 1000;
for (let h = 0; h < H; h++) {
  const s = newGame(DOUGHNUT, 2 + (h % 7), h, 0);
  while (s.phase !== 'handOver' && s.phase !== 'gameOver') {
    const o = observe(s, s.toAct);
    if (o.legalMoves.length === 1) { applyUnchecked(s, o.legalMoves[0]); continue; }
    const ev = evaluateMoves(net, o);
    const i = argmax(ev.q);
    xs.push(concatInput(ev.state, ev.actions[i]));
    applyUnchecked(s, o.legalMoves[i]);
  }
}
const play = performance.now() - t;
console.log(`self-play: ${(H / (play / 1000)).toFixed(0)} hands/s, ${(xs.length / H).toFixed(1)} samples/hand`);
t = performance.now();
const B = 256, N = 20;
for (let k = 0; k < N; k++) net.trainBatch(xs.slice(k * B, (k + 1) * B), Array(B).fill(0.1), 5e-4);
const tr = performance.now() - t;
console.log(`training: ${((N * B) / (tr / 1000)).toFixed(0)} samples/s`);
