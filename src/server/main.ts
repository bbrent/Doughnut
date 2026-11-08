/**
 * Entry point: node dist/server.cjs
 *
 * Environment:
 *   PORT, APP_ROOT, PUBLIC_DIR, MODEL_PATH
 *   PUBLIC_URL     the site's address, used in email links (https://doughnut.example.com)
 *   DATABASE_URL   mysql://user:pass@host:3306/db  (or MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE)
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
 * Without a database nothing is saved across restarts; without SMTP, emails are printed to the log.
 */
import { resolve } from 'node:path';
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

async function main() {
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  const base = env.APP_ROOT ?? process.cwd();
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

  const { server } = startServer({
    port,
    publicDir: env.PUBLIC_DIR ?? resolve(base, 'dist/public'),
    modelPath: env.MODEL_PATH ?? resolve(base, 'models/doughnut.json'),
    store: new AccountService(repo, mailer, { publicUrl }),
  });
  server.on('listening', () => console.log(`Doughnut server on port ${port}`));
}

main();
