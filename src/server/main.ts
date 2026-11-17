/**
 * Entry point: node dist/server.cjs (or app.js in a release package)
 *
 * Settings come from environment variables, or a .env file next to app.js
 * (variables already set win). See DEPLOY.md.
 *
 * Environment:
 *   PORT, APP_ROOT, PUBLIC_DIR, MODEL_PATH
 *   PUBLIC_URL     the address players open (where index.html is), used in email links;
 *                  that site may connect even when this server is on another address
 *   ALLOWED_ORIGINS  more websites allowed to connect, comma-separated
 *   DATABASE_URL   mysql://user:pass@host:3306/db  (or MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE)
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
 * Without a database nothing is saved across restarts; without SMTP, emails are printed to the log.
 */
import { resolve } from 'node:path';
import { loadDotEnv } from './env';
import { AccountService } from './accounts';
import { mailerFromEnv } from './mailer';
import { startServer } from './server';
import { MemoryRepo, MySqlRepo, type Repo } from './store';

function repoFromEnv(env: NodeJS.ProcessEnv): Repo {
  if (env.DATABASE_URL) return new MySqlRepo(env.DATABASE_URL);
  if (env.MYSQL_HOST || env.MYSQL_DATABASE) {
    return new MySqlRepo({
      host: env.MYSQL_HOST ?? 'localhost',
      port: Number(env.MYSQL_PORT ?? 3306),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
    });
  }
  return new MemoryRepo();
}

/** The app folder: the parent of dist/ when bundled, else the working directory. */
function appRoot(): string {
  if (process.env.APP_ROOT) return process.env.APP_ROOT;
  return typeof __dirname !== 'undefined' && __dirname.endsWith('dist') ? resolve(__dirname, '..') : process.cwd();
}

async function main() {
  const base = appRoot();
  const fromFile = loadDotEnv(resolve(base, '.env'));
  if (fromFile.length) console.log(`Loaded ${fromFile.length} setting(s) from .env`);
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;
  if (!env.PUBLIC_URL) console.warn(`PUBLIC_URL not set: email links will point to ${publicUrl}`);
  const mailer = mailerFromEnv(env);
  if (!mailer.delivers) console.warn('SMTP not configured: emails are printed to this log instead of sent');

  let repo = repoFromEnv(env);
  try {
    await repo.init();
    console.log(repo instanceof MemoryRepo ? 'No database configured: accounts are kept in memory only' : 'Connected to MySQL');
  } catch (e) {
    console.error('Could not connect to the database; running without saving anything:', (e as Error).message);
    repo = new MemoryRepo();
  }

  const { server, close } = startServer({
    port: env.PORT && !/^\d+$/.test(env.PORT) ? env.PORT : port, // some hosts pass a socket path
    publicDir: env.PUBLIC_DIR ?? resolve(base, 'dist/public'),
    modelPath: env.MODEL_PATH ?? resolve(base, 'models/doughnut.json'),
    store: new AccountService(repo, mailer, { publicUrl }),
    // Path prefix the host removes before requests reach Node (cPanel/Passenger sets PASSENGER_BASE_URI).
    basePath: env.BASE_PATH ?? env.PASSENGER_BASE_URI ?? '',
    // The site in PUBLIC_URL may always connect, plus any listed in ALLOWED_ORIGINS.
    allowedOrigins: [publicUrl, ...(env.ALLOWED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean)],
  });
  server.on('listening', () =>
    console.log(`Doughnut ${VERSION} on Node ${process.version}, listening on ${env.PORT ?? port}${env.BASE_PATH || env.PASSENGER_BASE_URI ? ` under ${env.BASE_PATH ?? env.PASSENGER_BASE_URI}` : ''}`),
  );
  server.on('error', (e) => {
    console.error('Server error:', e.message);
    process.exit(1);
  });

  // Hosts stop or restart apps with SIGTERM: close connections and the database cleanly.
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    await close().catch(() => {});
    await repo.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

main();
