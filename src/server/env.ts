/**
 * Minimal .env loader (no dependency), for hosts without an environment
 * settings panel. Lines are KEY=value; # starts a comment; values may be
 * quoted. Variables already set in the environment win.
 */
import { existsSync, readFileSync } from 'node:fs';

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      const q = v[0];
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
    }
    out[m[1]] = v;
  }
  return out;
}

/** Load `path` into process.env (without overriding). Returns the keys loaded. */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(parseDotEnv(readFileSync(path, 'utf8')))) {
    if (env[k] === undefined) {
      env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}
