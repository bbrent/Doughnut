// Noise floor for agreement/regret: re-run ISMCTS on stored positions and
// score its choices against the stored search, exactly like a model.
//   npx tsx scripts/search-noise.ts <data.bin> [iterations] [maxDecisions]
import { readFileSync } from 'node:fs';
import { DEFAULT_ISMCTS, ismctsSearch } from '../src/ai';
import { MODES, moveKey, mulberry32 } from '../src/engine';
import { decodeRecords } from '../src/ml';
const [file, it = '1000', max = '3000'] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(file + '.meta.json', 'utf8'));
const rs = decodeRecords(new Uint8Array(readFileSync(file)), MODES[meta.mode]).slice(0, Number(max));
const rng = mulberry32(4242);
const kind = (r: (typeof rs)[0]) => {
  const k = r.obs.legalMoves.map((m) => m.kind);
  return k.includes('pickup') ? 'dealer pickup/fold' : k[0] === 'card' ? 'card play' : k[0];
};
const stats = new Map<string, { n: number; agree: number; regret: number }>();
for (const r of rs) {
  const res = ismctsSearch(r.obs, rng, { ...DEFAULT_ISMCTS, iterations: Number(it) });
  const pick = r.obs.legalMoves.findIndex((m) => moveKey(m) === moveKey(res[0].move));
  let top = 0;
  r.moves.forEach((m, i) => { if (m.visits > r.moves[top].visits) top = i; });
  for (const key of ['all', kind(r)]) {
    const st = stats.get(key) ?? { n: 0, agree: 0, regret: 0 };
    st.n++;
    if (pick === top) st.agree++;
    st.regret += r.moves[top].value - r.moves[pick].value;
    stats.set(key, st);
  }
}
console.log(`ISMCTS(${it}) re-run on ${rs.length} stored decisions`);
for (const [k, st] of stats) console.log(`  ${k.padEnd(20)} n=${String(st.n).padStart(6)}  agree ${(100 * st.agree / st.n).toFixed(1)}%  regret ${(st.regret / st.n).toFixed(4)}`);
