import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { AppError } from './errors.js';
import type { Draft, DraftInput, DraftStatus, GeoHistory, Project } from './types.js';

type ProjectRow = Omit<Project, 'createdAt' | 'updatedAt'> & { created_at: string; updated_at: string };
type DraftRow = Omit<Draft, 'projectId' | 'metadata' | 'createdAt' | 'updatedAt'> & {
  project_id: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  scheduled_at: string | null;
  scheduled_connector: string | null;
};

const now = () => new Date().toISOString();

type Statement = { run(...values: unknown[]): { changes: number | bigint }; get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
type SqliteDatabase = { pragma(source: string): unknown; exec(source: string): unknown; prepare(source: string): Statement; close(): void };

function openDatabase(filename: string): SqliteDatabase {
  try {
    const BetterSqlite = createRequire(import.meta.url)('better-sqlite3') as new (name: string) => SqliteDatabase;
    return new BetterSqlite(filename);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND';
    if (!missing) throw error;
    // Node 22.5+ fallback keeps the app usable in constrained/offline environments.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (name: string) => {
        exec(source: string): unknown;
        prepare(source: string): Statement & { setAllowBareNamedParameters(value: boolean): void };
        close(): void;
      };
    };
    const db = new DatabaseSync(filename);
    return {
      pragma: (source) => db.exec(`PRAGMA ${source}`),
      exec: (source) => db.exec(source),
      prepare: (source) => {
        const statement = db.prepare(source);
        statement.setAllowBareNamedParameters(true);
        return statement as unknown as Statement;
      },
      close: () => db.close(),
    };
  }
}

export class Store {
  readonly db: SqliteDatabase;

  constructor(filename: string) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = openDatabase(filename);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        audience TEXT NOT NULL DEFAULT '',
        tone TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'en',
        competitors TEXT NOT NULL DEFAULT '[]',
        strategy TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agentId TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','published')),
        channel TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        scheduled_at TEXT,
        scheduled_connector TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drafts_project_status ON drafts(project_id, status);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS geo_history (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        score REAL NOT NULL, visible INTEGER NOT NULL, total INTEGER NOT NULL, checks TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS geo_history_project_created ON geo_history(project_id, created_at);
    `);
    this.migrateColumn('projects', 'language', "TEXT NOT NULL DEFAULT 'en'");
    this.migrateColumn('projects', 'competitors', "TEXT NOT NULL DEFAULT '[]'");
    this.migrateColumn('drafts', 'scheduled_at', 'TEXT');
    this.migrateColumn('drafts', 'scheduled_connector', 'TEXT');
  }

  private migrateColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close() { this.db.close(); }

  private mapProject(row: ProjectRow | undefined): Project | undefined {
    if (!row) return undefined;
    const { created_at, updated_at, ...rest } = row as ProjectRow & { competitors: string };
    return { ...rest, language: rest.language || 'en', competitors: typeof rest.competitors === 'string' ? JSON.parse(rest.competitors || '[]') : rest.competitors, createdAt: created_at, updatedAt: updated_at } as Project;
  }

  private mapDraft(row: DraftRow | undefined): Draft | undefined {
    if (!row) return undefined;
    const { project_id, created_at, updated_at, scheduled_at, scheduled_connector, metadata, ...rest } = row;
    return { ...rest, projectId: project_id, metadata: JSON.parse(metadata), scheduledAt: scheduled_at, scheduledConnector: scheduled_connector, createdAt: created_at, updatedAt: updated_at };
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[]).map((r) => this.mapProject(r)!);
  }

  getProject(id: string): Project {
    const project = this.mapProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined);
    if (!project) throw new AppError('Project not found', 404);
    return project;
  }

  createProject(input: Partial<Omit<Project, 'id' | 'strategy' | 'createdAt' | 'updatedAt'>>): Project {
    const name = input.name?.trim();
    if (!name) throw new AppError('name is required');
    const stamp = now();
    const project: Project = {
      id: randomUUID(), name, url: input.url?.trim() || '', description: input.description?.trim() || '',
      audience: input.audience?.trim() || '', tone: input.tone?.trim() || '', strategy: null,
      language: input.language === 'es' ? 'es' : 'en', competitors: Array.isArray(input.competitors) ? input.competitors.map(String).map((value) => value.trim()).filter(Boolean) : [],
      createdAt: stamp, updatedAt: stamp,
    };
    this.db.prepare(`INSERT INTO projects (id,name,url,description,audience,tone,language,competitors,strategy,created_at,updated_at)
      VALUES (@id,@name,@url,@description,@audience,@tone,@language,@competitors,@strategy,@createdAt,@updatedAt)`).run({ ...project, competitors: JSON.stringify(project.competitors) });
    return project;
  }

  setStrategy(id: string, strategy: string): Project {
    const result = this.db.prepare('UPDATE projects SET strategy = ?, updated_at = ? WHERE id = ?').run(strategy, now(), id);
    if (!result.changes) throw new AppError('Project not found', 404);
    return this.getProject(id);
  }

  updateProject(id: string, input: { language?: string; competitors?: string[] }): Project {
    const project = this.getProject(id);
    const language = input.language === 'es' ? 'es' : input.language === 'en' ? 'en' : project.language || 'en';
    const competitors = Array.isArray(input.competitors) ? input.competitors.map(String).map((value) => value.trim()).filter(Boolean) : project.competitors || [];
    this.db.prepare('UPDATE projects SET language = ?, competitors = ?, updated_at = ? WHERE id = ?').run(language, JSON.stringify(competitors), now(), id);
    return this.getProject(id);
  }

  createDraft(projectId: string, agentId: string, input: DraftInput): Draft {
    this.getProject(projectId);
    const stamp = now();
    const draft: Draft = {
      id: randomUUID(), projectId, agentId, status: 'pending', channel: input.channel,
      title: input.title, body: input.body, metadata: input.metadata || {}, createdAt: stamp, updatedAt: stamp,
      scheduledAt: null, scheduledConnector: null,
    };
    this.db.prepare(`INSERT INTO drafts (id,project_id,agentId,status,channel,title,body,metadata,scheduled_at,scheduled_connector,created_at,updated_at)
      VALUES (@id,@projectId,@agentId,@status,@channel,@title,@body,@metadata,@scheduledAt,@scheduledConnector,@createdAt,@updatedAt)`)
      .run({ ...draft, metadata: JSON.stringify(draft.metadata) });
    return draft;
  }

  getDraft(id: string): Draft {
    const draft = this.mapDraft(this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined);
    if (!draft) throw new AppError('Draft not found', 404);
    return draft;
  }

  listDrafts(projectId?: string, status?: string): Draft[] {
    if (status && !['pending', 'approved', 'rejected', 'published'].includes(status)) throw new AppError('Invalid draft status');
    const clauses: string[] = [];
    const values: string[] = [];
    if (projectId) { clauses.push('project_id = ?'); values.push(projectId); }
    if (status) { clauses.push('status = ?'); values.push(status); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM drafts${where} ORDER BY created_at DESC`).all(...values) as DraftRow[]).map((r) => this.mapDraft(r)!);
  }

  updateDraft(id: string, input: { title?: string; body?: string }): Draft {
    const draft = this.getDraft(id);
    if (draft.status === 'published') throw new AppError('Published drafts cannot be edited', 409);
    if (typeof input.title !== 'string' && typeof input.body !== 'string') throw new AppError('title or body is required');
    const nextTitle = input.title ?? draft.title;
    const nextBody = input.body ?? draft.body;
    const revisions = Array.isArray(draft.metadata.revisions) ? draft.metadata.revisions : [];
    const metadata = (nextTitle !== draft.title || nextBody !== draft.body)
      ? { ...draft.metadata, revisions: [...revisions, { title: draft.title, body: draft.body, editedAt: now() }].slice(-20) }
      : draft.metadata;
    this.db.prepare('UPDATE drafts SET title = ?, body = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .run(nextTitle, nextBody, JSON.stringify(metadata), now(), id);
    return this.getDraft(id);
  }

  transitionDraft(id: string, next: DraftStatus, metadata?: Record<string, unknown>): Draft {
    const draft = this.getDraft(id);
    const allowed: Record<DraftStatus, DraftStatus[]> = {
      pending: ['approved', 'rejected'], approved: ['rejected', 'published'], rejected: ['approved'], published: [],
    };
    if (!allowed[draft.status].includes(next)) {
      throw new AppError(`Cannot transition draft from ${draft.status} to ${next}`, 409);
    }
    const merged = metadata ? { ...draft.metadata, ...metadata } : draft.metadata;
    this.db.prepare('UPDATE drafts SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .run(next, JSON.stringify(merged), now(), id);
    return this.getDraft(id);
  }

  scheduleDraft(id: string, scheduledAt: string | null, connector: string | null): Draft {
    const draft = this.getDraft(id);
    if (draft.status !== 'approved') throw new AppError('Only approved drafts can be scheduled', 409);
    if (scheduledAt && (!connector || Number.isNaN(Date.parse(scheduledAt)))) throw new AppError('A valid date and connector are required');
    this.db.prepare('UPDATE drafts SET scheduled_at = ?, scheduled_connector = ?, updated_at = ? WHERE id = ?').run(scheduledAt, connector, now(), id);
    return this.getDraft(id);
  }

  listDueDrafts(at = now()): Draft[] {
    return (this.db.prepare("SELECT * FROM drafts WHERE status = 'approved' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at").all(at) as DraftRow[]).map((row) => this.mapDraft(row)!);
  }

  getSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  setSettings(values: Record<string, string>): Record<string, string> {
    const statement = this.db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at');
    for (const [key, value] of Object.entries(values)) statement.run(key, value, now());
    return this.getSettings();
  }

  addGeoHistory(projectId: string, visible: number, total: number, checks: unknown[]): GeoHistory {
    const item: GeoHistory = { id: randomUUID(), projectId, visible, total, score: total ? Math.round((visible / total) * 100) : 0, checks: checks as GeoHistory['checks'], createdAt: now() };
    this.db.prepare('INSERT INTO geo_history (id,project_id,score,visible,total,checks,created_at) VALUES (?,?,?,?,?,?,?)').run(item.id, item.projectId, item.score, item.visible, item.total, JSON.stringify(item.checks), item.createdAt);
    return item;
  }

  listGeoHistory(projectId: string): GeoHistory[] {
    const rows = this.db.prepare('SELECT * FROM geo_history WHERE project_id = ? ORDER BY created_at').all(projectId) as Array<{ id: string; project_id: string; score: number; visible: number; total: number; checks: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, score: row.score, visible: row.visible, total: row.total, checks: JSON.parse(row.checks), createdAt: row.created_at }));
  }
}
