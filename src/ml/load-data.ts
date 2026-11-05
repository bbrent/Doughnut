/** Node-only: load search data files and featurize with the current encoding. */
import { readFileSync } from 'node:fs';
import { MODES } from '../engine';
import { DATA_FORMAT, decodeRecords, featurize, type Decision } from './dataset';

export function loadSearchData(files: string[]): Decision[] {
  const out: Decision[] = [];
  for (const f of files) {
    const meta = JSON.parse(readFileSync(f + '.meta.json', 'utf8'));
    if (meta.format !== DATA_FORMAT) throw new Error(`${f}: data format ${meta.format} != ${DATA_FORMAT}; regenerate`);
    const config = MODES[meta.mode];
    if (!config) throw new Error(`${f}: unknown mode ${meta.mode}`);
    for (const r of decodeRecords(new Uint8Array(readFileSync(f)), config)) out.push(featurize(r));
  }
  return out;
}
