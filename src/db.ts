import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { AppError } from './errors.js';
import type { Approval, Draft, DraftInput, DraftStatus, GeoHistory, HealthHistory, Job, KnowledgeDocument, Project, SearchOpportunity } from './types.js';
import type { KnowledgeChunk } from './rag.js';
import { draftQuality, normalizeProjectUrl } from './product.js';

type ProjectRow = Omit<Project, 'createdAt' | 'updatedAt' | 'isDemo'> & { is_demo: number; created_at: string; updated_at: string };
type DraftRow = Omit<Draft, 'projectId' | 'metadata' | 'createdAt' | 'updatedAt'> & {
  project_id: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  scheduled_at: string | null;
  scheduled_connector: string | null;
};
type JobRow = Omit<Job, 'projectId' | 'payload' | 'createdAt' | 'updatedAt'> & { project_id: string; payload: string; created_at: string; updated_at: string };

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
  db: SqliteDatabase;
  readonly filename: string;
  integrityStatus = 'ok';

  constructor(filename: string) {
    this.filename = filename;
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
        is_demo INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS health_history (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        score INTEGER NOT NULL, report TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS health_history_project_created ON health_history(project_id, created_at);
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'paste', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_project ON knowledge_chunks(project_id);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, action TEXT NOT NULL, params TEXT NOT NULL, summary TEXT NOT NULL,
        decision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL, ms INTEGER NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS search_opportunities (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        query TEXT NOT NULL, clicks REAL NOT NULL, impressions REAL NOT NULL, ctr REAL NOT NULL,
        position REAL NOT NULL, score REAL NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_opportunities_project_score ON search_opportunities(project_id, score DESC);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
        progress INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 1, message TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status_priority ON jobs(status, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS jobs_project_created ON jobs(project_id, created_at DESC);
    `);
    this.migrateColumn('projects', 'language', "TEXT NOT NULL DEFAULT 'en'");
    this.migrateColumn('projects', 'competitors', "TEXT NOT NULL DEFAULT '[]'");
    this.migrateColumn('projects', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    this.migrateColumn('drafts', 'scheduled_at', 'TEXT');
    this.migrateColumn('drafts', 'scheduled_connector', 'TEXT');
    this.migrateColumn('jobs', 'payload', "TEXT NOT NULL DEFAULT '{}'");
    this.migrateColumn('jobs', 'priority', 'INTEGER NOT NULL DEFAULT 0');
    this.db.prepare("UPDATE jobs SET status = 'queued', message = 'Resuming after restart', updated_at = ? WHERE status = 'running'").run(now());
    const integrity = this.db.prepare('PRAGMA integrity_check').get() as Record<string, string> | undefined;
    this.integrityStatus = integrity ? Object.values(integrity)[0] || 'unknown' : 'unknown';
  }

  private migrateColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close() { this.db.close(); }

  private mapProject(row: ProjectRow | undefined): Project | undefined {
    if (!row) return undefined;
    const { created_at, updated_at, is_demo, ...rest } = row as ProjectRow & { competitors: string };
    return { ...rest, isDemo: Boolean(is_demo), language: rest.language || 'en', competitors: typeof rest.competitors === 'string' ? JSON.parse(rest.competitors || '[]') : rest.competitors, createdAt: created_at, updatedAt: updated_at } as Project;
  }

  private mapDraft(row: DraftRow | undefined): Draft | undefined {
    if (!row) return undefined;
    const { project_id, created_at, updated_at, scheduled_at, scheduled_connector, metadata, ...rest } = row;
    return { ...rest, projectId: project_id, metadata: JSON.parse(metadata), scheduledAt: scheduled_at, scheduledConnector: scheduled_connector, createdAt: created_at, updatedAt: updated_at };
  }

  private mapJob(row: JobRow | undefined): Job | undefined {
    if (!row) return undefined;
    const { project_id, payload, created_at, updated_at, ...rest } = row;
    return { ...rest, projectId: project_id, payload: JSON.parse(payload || '{}'), createdAt: created_at, updatedAt: updated_at };
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[]).map((r) => this.mapProject(r)!);
  }

  getProject(id: string): Project {
    const project = this.mapProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined);
    if (!project) throw new AppError('Project not found', 404);
    return project;
  }

  findProjectByUrl(url: string): Project | undefined {
    const normalized = normalizeProjectUrl(url);
    if (!normalized) return undefined;
    return this.listProjects().find((project) => normalizeProjectUrl(project.url) === normalized);
  }

  createProject(input: Partial<Omit<Project, 'id' | 'strategy' | 'createdAt' | 'updatedAt'>> & { strategy?: string | null }): Project {
    const name = input.name?.trim();
    if (!name) throw new AppError('name is required');
    const stamp = now();
    const duplicate = input.url ? this.findProjectByUrl(input.url) : undefined;
    if (duplicate) throw new AppError('A project for this website already exists', 409, { code: 'duplicate_project', project: duplicate });
    const project: Project = {
      id: randomUUID(), name, url: input.url?.trim() || '', description: input.description?.trim() || '',
      audience: input.audience?.trim() || '', tone: input.tone?.trim() || '', strategy: input.strategy || null, isDemo: Boolean(input.isDemo),
      language: input.language === 'es' ? 'es' : 'en', competitors: Array.isArray(input.competitors) ? input.competitors.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 5) : [],
      createdAt: stamp, updatedAt: stamp,
    };
    this.db.prepare(`INSERT INTO projects (id,name,url,description,audience,tone,language,competitors,strategy,is_demo,created_at,updated_at)
      VALUES (@id,@name,@url,@description,@audience,@tone,@language,@competitors,@strategy,@isDemo,@createdAt,@updatedAt)`).run({ ...project, isDemo: project.isDemo ? 1 : 0, competitors: JSON.stringify(project.competitors) });
    return project;
  }

  deleteDemoProject(id: string) {
    const project = this.getProject(id);
    if (!project.isDemo) throw new AppError('Only sample projects can be deleted here', 403);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  setStrategy(id: string, strategy: string): Project {
    const result = this.db.prepare('UPDATE projects SET strategy = ?, updated_at = ? WHERE id = ?').run(strategy, now(), id);
    if (!result.changes) throw new AppError('Project not found', 404);
    return this.getProject(id);
  }

  updateProject(id: string, input: { language?: string; competitors?: string[] }): Project {
    const project = this.getProject(id);
    const language = input.language === 'es' ? 'es' : input.language === 'en' ? 'en' : project.language || 'en';
    const competitors = Array.isArray(input.competitors) ? input.competitors.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 5) : project.competitors || [];
    this.db.prepare('UPDATE projects SET language = ?, competitors = ?, updated_at = ? WHERE id = ?').run(language, JSON.stringify(competitors), now(), id);
    return this.getProject(id);
  }

  mergeProject(id: string, input: Partial<Pick<Project, 'name' | 'description' | 'audience' | 'tone' | 'language' | 'competitors'>>): Project {
    const project = this.getProject(id);
    const name = input.name?.trim() || project.name;
    const description = input.description?.trim() || project.description;
    const audience = input.audience?.trim() || project.audience;
    const tone = input.tone?.trim() || project.tone;
    const language = input.language === 'es' ? 'es' : input.language === 'en' ? 'en' : project.language || 'en';
    const competitors = Array.isArray(input.competitors) && input.competitors.length ? input.competitors.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 5) : project.competitors || [];
    this.db.prepare('UPDATE projects SET name = ?, description = ?, audience = ?, tone = ?, language = ?, competitors = ?, updated_at = ? WHERE id = ?').run(name, description, audience, tone, language, JSON.stringify(competitors), now(), id);
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
    const changedMetadata = input.body !== undefined && input.body.trim() && draft.metadata.needsBody ? { ...draft.metadata, needsBody: false, writing: false } : draft.metadata;
    const metadata = (nextTitle !== draft.title || nextBody !== draft.body)
      ? { ...changedMetadata, revisions: [...revisions, { title: draft.title, body: draft.body, editedAt: now() }].slice(-20) }
      : changedMetadata;
    this.db.prepare('UPDATE drafts SET title = ?, body = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .run(nextTitle, nextBody, JSON.stringify(metadata), now(), id);
    return this.getDraft(id);
  }

  transitionDraft(id: string, next: DraftStatus, metadata?: Record<string, unknown>): Draft {
    const draft = this.getDraft(id);
    if (next === 'approved') {
      if (draft.metadata.needsBody) throw new AppError('This draft is still being written and cannot be approved', 409, { code: 'draft_needs_body' });
      const quality = draftQuality(draft.channel, draft.body);
      if (quality.violations.length) throw new AppError(`Fix channel limits before approval: ${quality.violations.join('; ')}`, 422, { quality });
    }
    const allowed: Record<DraftStatus, DraftStatus[]> = {
      pending: ['approved', 'rejected'], approved: ['rejected', 'published'], rejected: ['pending', 'approved'], published: [],
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
    if (draft.metadata.needsBody) throw new AppError('This draft is still being written and cannot be scheduled', 409, { code: 'draft_needs_body' });
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

  addHealthHistory(projectId: string, score: number, report: Record<string, unknown>): HealthHistory {
    this.getProject(projectId);
    const item: HealthHistory = { id: randomUUID(), projectId, score: Math.max(0, Math.min(100, Math.round(score))), report, createdAt: now() };
    this.db.prepare('INSERT INTO health_history (id,project_id,score,report,created_at) VALUES (?,?,?,?,?)').run(item.id, item.projectId, item.score, JSON.stringify(item.report), item.createdAt);
    return item;
  }

  listHealthHistory(projectId: string): HealthHistory[] {
    const rows = this.db.prepare('SELECT * FROM health_history WHERE project_id = ? ORDER BY created_at').all(projectId) as Array<{ id: string; project_id: string; score: number; report: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, score: row.score, report: JSON.parse(row.report), createdAt: row.created_at }));
  }

  replaceSearchOpportunities(projectId: string, inputs: Array<Omit<SearchOpportunity, 'id' | 'projectId' | 'createdAt'>>): SearchOpportunity[] {
    this.getProject(projectId);
    this.db.prepare('DELETE FROM search_opportunities WHERE project_id = ?').run(projectId);
    const insert = this.db.prepare('INSERT INTO search_opportunities (id,project_id,query,clicks,impressions,ctr,position,score,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    const stamp = now();
    const rows = inputs.map((input) => ({ ...input, id: randomUUID(), projectId, createdAt: stamp }));
    for (const item of rows) insert.run(item.id, item.projectId, item.query, item.clicks, item.impressions, item.ctr, item.position, item.score, item.createdAt);
    return rows;
  }

  listSearchOpportunities(projectId: string): SearchOpportunity[] {
    this.getProject(projectId);
    const rows = this.db.prepare('SELECT * FROM search_opportunities WHERE project_id = ? ORDER BY score DESC, impressions DESC').all(projectId) as Array<{ id: string; project_id: string; query: string; clicks: number; impressions: number; ctr: number; position: number; score: number; created_at: string }>;
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, query: row.query, clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position, score: row.score, createdAt: row.created_at }));
  }

  addKnowledgeDocument(projectId: string, title: string, source: string, chunks: Array<{ text: string; embedding?: number[] | null }>): KnowledgeDocument {
    this.getProject(projectId);
    const document: KnowledgeDocument = { id: randomUUID(), projectId, title: title.trim().slice(0, 200) || 'Untitled', source: source.slice(0, 500), createdAt: now() };
    this.db.prepare('INSERT INTO knowledge_documents (id,project_id,title,source,created_at) VALUES (?,?,?,?,?)').run(document.id, projectId, document.title, document.source, document.createdAt);
    const insert = this.db.prepare('INSERT INTO knowledge_chunks (id,document_id,project_id,title,text,embedding) VALUES (?,?,?,?,?,?)');
    for (const chunk of chunks) insert.run(randomUUID(), document.id, projectId, document.title, chunk.text, chunk.embedding ? JSON.stringify(chunk.embedding) : null);
    return document;
  }

  listKnowledgeDocuments(projectId: string): KnowledgeDocument[] {
    const rows = this.db.prepare('SELECT * FROM knowledge_documents WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<{ id: string; project_id: string; title: string; source: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, title: row.title, source: row.source, createdAt: row.created_at }));
  }

  listKnowledgeChunks(projectId: string): KnowledgeChunk[] {
    const rows = this.db.prepare('SELECT id,document_id,title,text,embedding FROM knowledge_chunks WHERE project_id = ?').all(projectId) as Array<{ id: string; document_id: string; title: string; text: string; embedding: string | null }>;
    return rows.map((row) => ({ id: row.id, documentId: row.document_id, title: row.title, text: row.text, embedding: row.embedding ? JSON.parse(row.embedding) as number[] : null }));
  }

  deleteKnowledgeDocument(id: string) { const result = this.db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id); if (!result.changes) throw new AppError('Knowledge document not found', 404); }

  createApproval(agent: string, action: string, params: Record<string, unknown>, summary: string, decision: string, reason: string): Approval {
    const item: Approval = { id: randomUUID(), agent, action, params, summary, decision, status: 'pending', reason, createdAt: now(), decidedAt: null };
    this.db.prepare('INSERT INTO approvals (id,agent,action,params,summary,decision,status,reason,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(item.id, agent, action, JSON.stringify(params), summary, decision, item.status, reason, item.createdAt, null);
    return item;
  }

  private mapApproval(row: Record<string, unknown> | undefined): Approval | undefined {
    if (!row) return undefined;
    return { id: String(row.id), agent: String(row.agent), action: String(row.action), params: JSON.parse(String(row.params)), summary: String(row.summary), decision: String(row.decision), status: String(row.status), reason: String(row.reason), createdAt: String(row.created_at), decidedAt: row.decided_at ? String(row.decided_at) : null };
  }
  getApproval(id: string): Approval { const item = this.mapApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined); if (!item) throw new AppError('Approval not found', 404); return item; }
  listApprovals(): Approval[] { return (this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC").all() as Record<string, unknown>[]).map((row) => this.mapApproval(row)!); }
  decideApproval(id: string, status: 'approved' | 'rejected') { this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, now(), id); }
  clearPendingApprovals() { this.db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE status = 'pending'").run(now()); }

  recordLlmCall(item: { purpose: string; model: string; ms: number; tokensIn: number; tokensOut: number; status: string; error?: string }) {
    this.db.prepare('INSERT INTO llm_calls (at,purpose,model,ms,tokens_in,tokens_out,status,error) VALUES (?,?,?,?,?,?,?,?)').run(now(), item.purpose, item.model, item.ms, item.tokensIn, item.tokensOut, item.status, item.error || '');
  }
  countLlmCallsSince(since: string): number { return Number((this.db.prepare('SELECT COUNT(*) AS count FROM llm_calls WHERE at > ?').get(since) as { count: number }).count); }
  llmStats() {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const rows = this.db.prepare('SELECT * FROM llm_calls WHERE at > ? ORDER BY id DESC').all(since) as Array<{ ms: number; tokens_in: number; tokens_out: number; status: string; purpose: string; model: string; at: string; error: string }>;
    const ok = rows.filter((row) => row.status === 'ok');
    const timed = ok.filter((row) => row.ms > 0 && row.tokens_out > 0).slice(0, 20);
    const tokensPerSecond = timed.length ? Number((timed.reduce((sum, row) => sum + row.tokens_out, 0) / (timed.reduce((sum, row) => sum + row.ms, 0) / 1000)).toFixed(1)) : 0;
    return { calls24h: rows.length, errors24h: rows.length - ok.length, avgMs: ok.length ? Math.round(ok.reduce((sum, row) => sum + row.ms, 0) / ok.length) : 0, tokens24h: rows.reduce((sum, row) => sum + row.tokens_in + row.tokens_out, 0), tokensPerSecond, recent: rows.slice(0, 12) };
  }

  createJob(projectId: string, kind: string, input: { total?: number; message?: string; payload?: Record<string, unknown>; priority?: number } = {}): Job {
    this.getProject(projectId);
    const stamp = now();
    const job: Job = { id: randomUUID(), projectId, kind, status: 'queued', progress: 0, total: Math.max(1, Math.round(input.total || 1)), message: input.message || 'Queued', error: '', payload: input.payload || {}, priority: Math.round(input.priority || 0), createdAt: stamp, updatedAt: stamp };
    this.db.prepare('INSERT INTO jobs (id,project_id,kind,status,progress,total,message,error,payload,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(job.id, job.projectId, job.kind, job.status, job.progress, job.total, job.message, job.error, JSON.stringify(job.payload), job.priority, job.createdAt, job.updatedAt);
    return job;
  }

  getJob(id: string): Job {
    const job = this.mapJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined);
    if (!job) throw new AppError('Job not found', 404);
    return job;
  }

  listJobs(projectId?: string): Job[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
    return (rows as JobRow[]).map((row) => this.mapJob(row)!);
  }

  nextQueuedJob(): Job | undefined {
    return this.mapJob(this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1").get() as JobRow | undefined);
  }

  updateJob(id: string, input: Partial<Pick<Job, 'status' | 'progress' | 'total' | 'message' | 'error' | 'payload' | 'priority'>>): Job {
    const job = this.getJob(id);
    const next = { ...job, ...input, progress: input.progress === undefined ? job.progress : Math.max(0, Math.round(input.progress)), total: input.total === undefined ? job.total : Math.max(1, Math.round(input.total)), updatedAt: now() };
    this.db.prepare('UPDATE jobs SET status=?, progress=?, total=?, message=?, error=?, payload=?, priority=?, updated_at=? WHERE id=?').run(next.status, next.progress, next.total, next.message, next.error, JSON.stringify(next.payload), next.priority, next.updatedAt, id);
    return this.getJob(id);
  }

  cancelJob(id: string): Job {
    const job = this.getJob(id);
    if (job.status === 'done' || job.status === 'failed') throw new AppError(`Cannot cancel a ${job.status} job`, 409);
    if (job.status === 'cancelled') return job;
    return this.updateJob(id, { status: 'cancelled', message: 'Cancelled' });
  }

  retryJob(id: string): Job {
    const job = this.getJob(id);
    if (!['failed', 'cancelled'].includes(job.status)) throw new AppError('Only failed or cancelled jobs can be retried', 409);
    return this.updateJob(id, { status: 'queued', error: '', message: 'Queued to retry', priority: job.priority + 1 });
  }

  updateDraftMetadata(id: string, values: Record<string, unknown>): Draft {
    const draft = this.getDraft(id);
    const metadata = { ...draft.metadata, ...values };
    this.db.prepare('UPDATE drafts SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), now(), id);
    return this.getDraft(id);
  }

  briefingFacts(projectId: string, at = new Date()) {
    const drafts = this.listDrafts(projectId);
    const day = at.toISOString().slice(0, 10);
    const tomorrow = new Date(at.getTime() + 86_400_000).toISOString().slice(0, 10);
    const geo = this.listGeoHistory(projectId);
    const change = geo.length > 1 ? geo.at(-1)!.score - geo.at(-2)!.score : 0;
    const latestSeo = drafts.find((draft) => draft.agentId === 'seo');
    const seoAudit = latestSeo?.metadata.audit as { issues?: unknown[] } | undefined;
    return { pending: drafts.filter((draft) => draft.status === 'pending').length, scheduledToday: drafts.filter((draft) => draft.scheduledAt?.startsWith(day)).length, scheduledTomorrow: drafts.filter((draft) => draft.scheduledAt?.startsWith(tomorrow)).length, publishedToday: drafts.filter((draft) => draft.status === 'published' && draft.updatedAt.startsWith(day)).length, geoChange: change, seoIssuesOpen: Array.isArray(seoAudit?.issues) ? seoAudit.issues.length : 0 };
  }
}
