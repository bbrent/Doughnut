import { describe, expect, it } from 'vitest';
import { loadDotEnv, parseDotEnv } from '../src/server/env';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('.env', () => {
  it('parses comments, quotes, export and trailing comments', () => {
    expect(
      parseDotEnv(`# comment
PUBLIC_URL=https://x.test
export PORT = 4000
MAIL_FROM="Doughnut <no-reply@x.test>"
SMTP_PASS='p@ss #not a comment'
EMPTY=
NOTE=hello # trailing
bad line
`),
    ).toEqual({
      PUBLIC_URL: 'https://x.test',
      PORT: '4000',
      MAIL_FROM: 'Doughnut <no-reply@x.test>',
      SMTP_PASS: 'p@ss #not a comment',
      EMPTY: '',
      NOTE: 'hello',
    });
  });

  it('does not override variables already set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    writeFileSync(join(dir, '.env'), 'A=from-file\nB=from-file\n');
    const env: NodeJS.ProcessEnv = { A: 'from-env' };
    expect(loadDotEnv(join(dir, '.env'), env)).toEqual(['B']);
    expect(env).toEqual({ A: 'from-env', B: 'from-file' });
    expect(loadDotEnv(join(dir, 'missing'), env)).toEqual([]);
  });
});
