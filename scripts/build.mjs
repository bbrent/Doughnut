// Build the web client and a self-contained server bundle into dist/.
//   node scripts/build.mjs
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}
const version = commit ? `${pkg.version}+${commit}` : pkg.version;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/public/models', { recursive: true });

await build({
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  sourcemap: true,
  outfile: 'dist/public/doughnut-client.js',
  // If a server ever tries to run this browser script, say so plainly.
  banner: {
    js: 'if(typeof window==="undefined"){throw new Error("doughnut-client.js is the game\'s browser script, not the server. Start the server with app.js from the release\'s app/ folder (see DEPLOY.md).")}',
  },
});
cpSync('src/client/styles.css', 'dist/public/styles.css');
cpSync('models/doughnut.json', 'dist/public/models/doughnut.json');

// Link the assets with a content hash so browsers fetch the new version after each deploy.
const hash = createHash('sha256')
  .update(readFileSync('dist/public/doughnut-client.js'))
  .update(readFileSync('dist/public/styles.css'))
  .digest('hex')
  .slice(0, 10);
const html = readFileSync('src/client/index.html', 'utf8')
  .replace('href="styles.css"', `href="styles.css?v=${hash}"`)
  .replace('src="doughnut-client.js"', `src="doughnut-client.js?v=${hash}"`);
if (!html.includes(`?v=${hash}`)) throw new Error('index.html asset links not found');
writeFileSync('dist/public/index.html', html);

await build({
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/server.cjs',
  define: { __VERSION__: JSON.stringify(version) },
  // ws optionally uses these native add-ons; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
});
console.log(`Built Doughnut ${version}: dist/public (client) and dist/server.cjs (server)`);
