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
const pub = `${out}/public_html`;
cpSync('dist/public', pub, { recursive: true });
rmSync(`${pub}/app.js.map`, { force: true });
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
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connect}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  # index.html must never be cached; it links app.js and styles.css with ?v=<hash>, so those can be.
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  <FilesMatch "^(app\\.js|styles\\.css)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\\.json$">
    Header set Cache-Control "public, max-age=3600"
  </FilesMatch>
</IfModule>
DirectoryIndex index.html
`,
);

// ---- app: the Node app (game server) -------------------------------------------------
const app = `${out}/app`;
mkdirSync(`${app}/models`, { recursive: true });
// It can serve the pages too (empty server address: same place), for hosting it all in Node.
cpSync('dist', `${app}/dist`, { recursive: true });
cpSync('models/doughnut.json', `${app}/models/doughnut.json`);
cpSync('deploy/.env.example', `${app}/.env.example`);
writeFileSync(`${app}/app.js`, "// Doughnut game server. Settings: environment variables or .env (see DEPLOY.md).\nrequire('./dist/server.cjs');\n");
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
console.log(`  public_html/  pages for your web server's public folder${serverUrl ? ` (game server: ${serverUrl})` : ' (no game server address set: only for Node serving everything)'}`);
console.log('  app/          the Node app');
