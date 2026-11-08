/**
 * Entry point: node dist/server.cjs
 * Environment: PORT, APP_ROOT, PUBLIC_DIR, MODEL_PATH, and either DATABASE_URL
 * (mysql://user:pass@host:3306/db) or MYSQL_HOST / MYSQL_PORT / MYSQL_USER /
 * MYSQL_PASSWORD / MYSQL_DATABASE. Without a database, nothing is saved.
 */
import { resolve } from 'node:path';
import { startServer } from './server';
import { MemoryStore, storeFromEnv, type Store } from './store';

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const base = process.env.APP_ROOT ?? process.cwd();

  let store: Store = storeFromEnv(process.env);
  try {
    await store.init();
    console.log(store instanceof MemoryStore ? 'No database configured: players and ratings are not saved' : 'Connected to MySQL');
  } catch (e) {
    console.error('Could not connect to the database; running without saving anything:', (e as Error).message);
    store = new MemoryStore();
  }

  const { server } = startServer({
    port,
    publicDir: process.env.PUBLIC_DIR ?? resolve(base, 'dist/public'),
    modelPath: process.env.MODEL_PATH ?? resolve(base, 'models/doughnut.json'),
    store,
  });
  server.on('listening', () => console.log(`Doughnut server on port ${port}`));
}

main();
