import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { OpenAICompatibleLLM } from './llm.js';

try { process.loadEnvFile(); } catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const config = loadConfig();
const store = new Store(path.join(config.dataDir, 'opencmo.sqlite'));
const llm = new OpenAICompatibleLLM(config.llmBaseUrl, config.llmApiKey, config.llmModel);
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const app = createApp({ store, llm, config, publicDir });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`OpenCMO v0.1 running at http://${config.host}:${info.port}`);
});
server.on('error', (error) => {
  console.error(`OpenCMO could not start: ${error.message}`);
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
