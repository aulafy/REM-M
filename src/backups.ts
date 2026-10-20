import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import type { Store } from './db.js';

export class BackupManager {
  readonly directory: string;
  constructor(private store: Store, dataDir: string) { this.directory = path.join(dataDir, 'backups'); }
  list() { if (!fs.existsSync(this.directory)) return []; return fs.readdirSync(this.directory).filter((name) => /^opencmo-[\w.-]+\.sqlite$/.test(name)).map((name) => ({ name, size: fs.statSync(path.join(this.directory, name)).size, createdAt: fs.statSync(path.join(this.directory, name)).mtime.toISOString() })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  create(kind: 'daily' | 'manual' = 'manual') {
    if (this.store.filename === ':memory:') throw new AppError('Backups require a file-based database', 409);
    fs.mkdirSync(this.directory, { recursive: true });
    const name = `opencmo-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}-${kind}.sqlite`;
    const destination = path.join(this.directory, name);
    this.store.db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
    this.prune();
    return { name, size: fs.statSync(destination).size };
  }
  prune() { for (const item of this.list().slice(20)) fs.unlinkSync(path.join(this.directory, item.name)); }
  tick() { const latest = this.list().find((item) => item.name.endsWith('-daily.sqlite')); if (!latest || Date.now() - Date.parse(latest.createdAt) >= 86_400_000) return this.create('daily'); return null; }
  verify(name: string) {
    if (!/^opencmo-[\w.-]+\.sqlite$/.test(name)) throw new AppError('Invalid backup name');
    const filename = path.join(this.directory, name); if (!fs.existsSync(filename)) throw new AppError('Backup not found', 404);
    type ReadOnlyDb = { prepare(sql: string): { get(): Record<string, string> }; close(): void };
    let db: ReadOnlyDb;
    try {
      const BetterSqlite = createRequire(import.meta.url)('better-sqlite3') as new (name: string, options?: { readonly?: boolean }) => ReadOnlyDb;
      db = new BetterSqlite(filename, { readonly: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')) throw error;
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (name: string, options?: { readOnly?: boolean }) => ReadOnlyDb };
      db = new DatabaseSync(filename, { readOnly: true });
    }
    try { const result = db.prepare('PRAGMA integrity_check').get(); return Object.values(result)[0] === 'ok'; } finally { db.close(); }
  }
  restore(name: string) {
    if (!this.verify(name)) throw new AppError('Backup failed integrity check', 409);
    if (this.store.filename === ':memory:') throw new AppError('Restore requires a file-based database', 409);
    // Keep a consistent safety snapshot. Applying a restore requires a restart so no open connection observes a half-replaced file.
    fs.copyFileSync(path.join(this.directory, name), `${this.store.filename}.restore-pending`);
    const safety = this.create('manual').name;
    return { restartRequired: true, pendingPath: `${this.store.filename}.restore-pending`, safetyBackup: safety };
  }
}

export function applyPendingRestore(filename: string) {
  const pending = `${filename}.restore-pending`;
  if (fs.existsSync(pending)) {
    fs.renameSync(pending, filename);
    for (const suffix of ['-wal', '-shm']) { const sidecar = `${filename}${suffix}`; if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar); }
  }
}
