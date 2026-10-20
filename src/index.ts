import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp, runMaintenance } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { applyPendingRestore } from './backups.js';

try { process.loadEnvFile(); } catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const config = loadConfig();
const databaseFile = path.join(config.dataDir, 'opencmo.sqlite');
applyPendingRestore(databaseFile);
const store = new Store(databaseFile);
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const app = createApp({ store, config, publicDir });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`OpenCMO v0.6 running at http://${config.host}:${info.port}`);
});
server.on('error', (error) => {
  console.error(`OpenCMO could not start: ${error.message}`);
  clearInterval(scheduler);
  store.close();
  process.exitCode = 1;
});

function shutdown() {
  clearInterval(scheduler);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
let schedulerBusy = false;
async function runScheduler() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try { await runMaintenance(store, config); } finally { schedulerBusy = false; }
}
const scheduler = setInterval(() => { void runScheduler(); }, 60_000);
void runScheduler();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
