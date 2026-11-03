// Compare models against ISMCTS on held-out search data.
//   npx tsx scripts/agreement.ts <data.bin> <model.json>...
// agree  = picks the search's most-visited move
// regret = search value of that move minus search value of the model's move (reward units; lower is better)
import { readFileSync } from 'node:fs';
import { ACTION_SIZE, STATE_SIZE, decodeDecisions, loadModel, scatter } from '../src/ml';
const [data, ...models] = process.argv.slice(2);
const ds = decodeDecisions(new Uint8Array(readFileSync(data)));
const KIND = ['exchange', 'exchange', 'declare', 'declare', 'pickup', 'card'];
const kindOf = (d: (typeof ds)[0]) => {
  const k = d.actions.map((a) => KIND[a.feat.idx[0]]);
  return k.includes('pickup') ? 'dealer pickup/fold' : k[0] === 'card' ? 'card play' : k[0];
};
for (const m of models) {
  const net = loadModel(JSON.parse(readFileSync(m, 'utf8')));
  const stats = new Map<string, { n: number; agree: number; regret: number }>();
  for (const d of ds) {
    const s = new Float32Array(STATE_SIZE);
    scatter(d.state, s);
    const q = net.predictShared(s, d.actions.map((a) => { const x = new Float32Array(ACTION_SIZE); scatter(a.feat, x); return x; }));
    let pick = 0, top = 0;
    d.actions.forEach((a, i) => { if (q[i] > q[pick]) pick = i; if (a.visits > d.actions[top].visits) top = i; });
    for (const key of ['all', kindOf(d)]) {
      const st = stats.get(key) ?? { n: 0, agree: 0, regret: 0 };
      st.n++;
      if (pick === top) st.agree++;
      st.regret += d.actions[top].value - d.actions[pick].value;
      stats.set(key, st);
    }
  }
  console.log(m);
  for (const [k, st] of stats) console.log(`  ${k.padEnd(20)} n=${String(st.n).padStart(6)}  agree ${(100 * st.agree / st.n).toFixed(1)}%  regret ${(st.regret / st.n).toFixed(4)}`);
}
