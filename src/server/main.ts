/** Entry point: node dist/server.cjs (PORT, PUBLIC_DIR, MODEL_PATH env vars). */
import { resolve } from 'node:path';
import { startServer } from './server';

const port = Number(process.env.PORT ?? 3000);
const base = process.env.APP_ROOT ?? process.cwd();
const { server } = startServer({
  port,
  publicDir: process.env.PUBLIC_DIR ?? resolve(base, 'dist/public'),
  modelPath: process.env.MODEL_PATH ?? resolve(base, 'models/doughnut.json'),
});
server.on('listening', () => console.log(`Doughnut server on port ${port}`));
