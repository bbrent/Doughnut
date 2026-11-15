// Make a deployable release: everything the host needs, no npm install required.
//   node scripts/package.mjs   ->  release/doughnut/  and  release/doughnut-<version>.zip
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

execSync('node scripts/build.mjs', { stdio: 'inherit' });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'release/doughnut';
rmSync('release', { recursive: true, force: true });
mkdirSync(`${out}/models`, { recursive: true });

cpSync('dist', `${out}/dist`, { recursive: true });
cpSync('models/doughnut.json', `${out}/models/doughnut.json`);
cpSync('deploy/.env.example', `${out}/.env.example`);
cpSync('DEPLOY.md', `${out}/DEPLOY.md`);
// Startup file: what Node hosting panels (e.g. cPanel "Setup Node.js App") run.
writeFileSync(`${out}/app.js`, "// Doughnut: start the server. Settings: environment variables or .env (see DEPLOY.md).\nrequire('./dist/server.cjs');\n");
writeFileSync(
  `${out}/package.json`,
  JSON.stringify(
    {
      name: 'doughnut',
      version: pkg.version,
      private: true,
      description: 'Doughnut card game server (self-contained build: no dependencies to install)',
      main: 'app.js',
      scripts: { start: 'node app.js' },
      engines: pkg.engines,
    },
    null,
    2,
  ) + '\n',
);

let archive = '';
if (existsSync('/usr/bin/zip') || existsSync('/bin/zip')) {
  archive = `release/doughnut-${pkg.version}.zip`;
  execSync(`cd release && zip -qr ../${archive} doughnut`);
} else {
  archive = `release/doughnut-${pkg.version}.tar.gz`;
  execSync(`tar -czf ${archive} -C release doughnut`);
}
console.log(`\nRelease ready: ${out}/  and  ${archive}`);
