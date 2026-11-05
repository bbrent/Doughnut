// Build the web client and a self-contained server bundle into dist/.
//   node scripts/build.mjs
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/public/models', { recursive: true });

await build({
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  sourcemap: true,
  outfile: 'dist/public/app.js',
});
cpSync('src/client/index.html', 'dist/public/index.html');
cpSync('src/client/styles.css', 'dist/public/styles.css');
cpSync('models/doughnut.json', 'dist/public/models/doughnut.json');

await build({
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/server.cjs',
  // ws optionally uses these native add-ons; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
});
console.log('Built dist/public (client) and dist/server.cjs (server)');
