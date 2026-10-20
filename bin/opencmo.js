#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const args = process.argv.slice(2); let port = '3000'; let dataDir = path.resolve(process.cwd(), 'data'); let openBrowser = true;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--port') port = args[++index] || '';
  else if (argument === '--data-dir') dataDir = path.resolve(args[++index] || '');
  else if (argument === '--no-open') openBrowser = false;
  else if (argument === '--help' || argument === '-h') {
    console.log('Usage: opencmo [--port 3000] [--data-dir ./data] [--no-open]'); process.exit(0);
  } else { console.error(`Unknown option: ${argument}`); process.exit(1); }
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) { console.error('--port must be between 1 and 65535'); process.exit(1); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxLoader = createRequire(import.meta.url).resolve('tsx');
const child = spawn(process.execPath, ['--import', tsxLoader, path.join(root, 'src/index.ts')], { stdio: 'inherit', env: { ...process.env, PORT: port, DATA_DIR: dataDir } });
if (openBrowser) setTimeout(() => {
  const url = `http://127.0.0.1:${port}`; const command = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const opener = spawn(command[0], command[1], { stdio: 'ignore', detached: true }); opener.on('error', () => undefined); opener.unref();
}, 1200).unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
