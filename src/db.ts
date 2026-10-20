import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';
import type { Draft, DraftInput, DraftStatus, Project } from './types.js';

type ProjectRow = Omit<Project, 'createdAt' | 'updatedAt'> & { created_at: string; updated_at: string };
type DraftRow = Omit<Draft, 'projectId' | 'metadata' | 'createdAt' | 'updatedAt'> & {
  project_id: string;
  metadata: string;
  created_at: string;
  updated_at: string;
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drafts_project_status ON drafts(project_id, status);
    `);
  }

  close() { this.db.close(); }

  private mapProject(row: ProjectRow | undefined): Project | undefined {
    if (!row) return undefined;
    const { created_at, updated_at, ...rest } = row;
    return { ...rest, createdAt: created_at, updatedAt: updated_at };
  }

  private mapDraft(row: DraftRow | undefined): Draft | undefined {
    if (!row) return undefined;
    const { project_id, created_at, updated_at, metadata, ...rest } = row;
    return { ...rest, projectId: project_id, metadata: JSON.parse(metadata), createdAt: created_at, updatedAt: updated_at };
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
      createdAt: stamp, updatedAt: stamp,
    };
    this.db.prepare(`INSERT INTO projects (id,name,url,description,audience,tone,strategy,created_at,updated_at)
      VALUES (@id,@name,@url,@description,@audience,@tone,@strategy,@createdAt,@updatedAt)`).run(project);
    return project;
  }

  setStrategy(id: string, strategy: string): Project {
    const result = this.db.prepare('UPDATE projects SET strategy = ?, updated_at = ? WHERE id = ?').run(strategy, now(), id);
    if (!result.changes) throw new AppError('Project not found', 404);
    return this.getProject(id);
  }

  createDraft(projectId: string, agentId: string, input: DraftInput): Draft {
    this.getProject(projectId);
    const stamp = now();
    const draft: Draft = {
      id: randomUUID(), projectId, agentId, status: 'pending', channel: input.channel,
      title: input.title, body: input.body, metadata: input.metadata || {}, createdAt: stamp, updatedAt: stamp,
    };
    this.db.prepare(`INSERT INTO drafts (id,project_id,agentId,status,channel,title,body,metadata,created_at,updated_at)
      VALUES (@id,@projectId,@agentId,@status,@channel,@title,@body,@metadata,@createdAt,@updatedAt)`)
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
    this.db.prepare('UPDATE drafts SET title = ?, body = ?, updated_at = ? WHERE id = ?')
      .run(input.title ?? draft.title, input.body ?? draft.body, now(), id);
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
}
