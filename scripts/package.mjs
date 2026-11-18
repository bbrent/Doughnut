// Make a deployable release (no npm install needed on the host).
//
//   npm run package                                     Node app serves everything
//   npm run package -- --server-url=https://example.com/doughnut-server
//                                                       pages from your web server's public folder,
//                                                       game server (Node) at that address
//
// Output: release/doughnut/{public_html,app,DEPLOY.md} and release/doughnut-<version>.zip
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const arg = process.argv.find((a) => a.startsWith('--server-url='));
const serverUrl = arg ? arg.slice('--server-url='.length).replace(/\/+$/, '') : '';
if (serverUrl && !/^https?:\/\/[^/]+/.test(serverUrl)) throw new Error('--server-url must look like https://example.com/doughnut-server');

execSync('node scripts/build.mjs', { stdio: 'inherit' });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'release/doughnut';
rmSync('release', { recursive: true, force: true });

// ---- public_html: the static pages, for your web server's public folder ----------
// Only with --server-url: without it, the Node app serves the pages itself.
const pub = `${out}/public_html`;
if (serverUrl) {
cpSync('dist/public', pub, { recursive: true });
rmSync(`${pub}/doughnut-client.js.map`, { force: true });
const html = readFileSync(`${pub}/index.html`, 'utf8').replace(
  '<meta name="doughnut-server" content="" />',
  `<meta name="doughnut-server" content="${serverUrl}" />`,
);
writeFileSync(`${pub}/index.html`, html);
const serverOrigin = serverUrl ? new URL(serverUrl).origin : '';
const connect = ["'self'", 'ws:', 'wss:', serverOrigin].filter(Boolean).join(' ');
writeFileSync(
  `${pub}/.htaccess`,
  `# Doughnut: headers for the game's pages (Apache with mod_headers; ignored elsewhere).
<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "no-referrer"
  Header always set X-Frame-Options "DENY"
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connect}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  # index.html must never be cached; it links doughnut-client.js and styles.css with ?v=<hash>, so those can be.
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  <FilesMatch "^(doughnut-client\\.js|styles\\.css)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\\.json$">
    Header set Cache-Control "public, max-age=3600"
  </FilesMatch>
</IfModule>
DirectoryIndex index.html
`,
);
}

// ---- app: the Node app (game server) -------------------------------------------------
const app = `${out}/app`;
mkdirSync(`${app}/models`, { recursive: true });
// It can serve the pages too (empty server address: same place), for hosting it all in Node.
cpSync('dist', `${app}/dist`, { recursive: true });
cpSync('models/doughnut.json', `${app}/models/doughnut.json`);
cpSync('deploy/.env.example', `${app}/.env.example`);
// Kept to old-style JavaScript so even an outdated Node can show the message.
writeFileSync(
  `${app}/app.js`,
  `// Doughnut game server. Settings: environment variables or .env (see DEPLOY.md).
var v = process.versions.node.split('.').map(Number);
if (v[0] < 18 || (v[0] === 18 && v[1] < 17)) {
  var msg = 'Doughnut needs Node.js 18.17 or newer, but this is Node ' + process.version +
    '. Choose Node.js 20 or newer for this app (cPanel: Setup Node.js App > Node.js version) and restart it.';
  console.error(msg);
  throw new Error(msg);
}
var fs = require('fs');
var path = require('path');
if (!fs.existsSync(path.join(__dirname, 'dist', 'server.cjs'))) {
  var m = 'Doughnut: dist/server.cjs not found next to app.js (in ' + __dirname + '). ' +
    'This folder should contain app.js, package.json, dist/ and models/ from the app/ folder of the release.';
  console.error(m);
  throw new Error(m);
}
require('./dist/server.cjs');
`,
);
writeFileSync(
  `${app}/README.txt`,
  `DOUGHNUT GAME SERVER

Everything in this folder goes into your Node app's "Application root", as is:

  app.js          <- the startup file (set "Application startup file" to app.js)
  package.json
  dist/           <- keep this folder whole: server.cjs + public/ (the web pages)
  models/
  .env            <- your settings (copy .env.example to .env and fill it in),
                     or enter them as environment variables in your host's panel

Do not move files out of dist/. In particular dist/public/doughnut-client.js is
the game's browser script; it is not the server.

There is nothing to install: do not run "npm install".
After uploading, restart the app and open <your address>/health to check it.
Full instructions: DEPLOY.md
`,
);
writeFileSync(
  `${app}/package.json`,
  JSON.stringify(
    {
      name: 'doughnut',
      version: pkg.version,
      private: true,
      description: 'Doughnut game server (self-contained build: no dependencies to install)',
      main: 'app.js',
      scripts: { start: 'node app.js' },
      engines: pkg.engines,
    },
    null,
    2,
  ) + '\n',
);
cpSync('DEPLOY.md', `${out}/DEPLOY.md`);

let archive;
if (existsSync('/usr/bin/zip') || existsSync('/bin/zip')) {
  archive = `release/doughnut-${pkg.version}.zip`;
  execSync(`cd release && zip -qr ../${archive} doughnut`);
} else {
  archive = `release/doughnut-${pkg.version}.tar.gz`;
  execSync(`tar -czf ${archive} -C release doughnut`);
}
console.log(`\nRelease ready: ${archive}`);
if (serverUrl) console.log(`  public_html/  pages for your web server's public folder (game server: ${serverUrl})`);
console.log(serverUrl ? '  app/          the Node app (game server)' : '  app/          the Node app: serves the pages and runs the game. Upload just this folder.');
