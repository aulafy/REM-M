import path from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { agentDefinitions, runAgent } from './agents.js';
import type { Config } from './config.js';
import { createConnectors } from './connectors.js';
import { Store } from './db.js';
import { AppError } from './errors.js';
import { OpenAICompatibleLLM } from './llm.js';
import { ObservedLLM } from './observability.js';
import { effectiveConfig, publicSettings, secretSettingKeys, settingKeys } from './settings.js';
import { extractWebsiteProfile, fetchPage, validateProfileDraft } from './web.js';
import type { Draft, LLM } from './types.js';
import { chunkText, fetchEmbedding, formatKnowledgeData, searchKnowledge } from './rag.js';
import { ActionRunner, actionFloor, defaultPolicy } from './policy.js';
import { BackupManager } from './backups.js';
import { HindsightMemory } from './hindsight.js';
import { briefIsDue, buildBrief } from './briefs.js';

export interface AppDependencies {
  store: Store;
  llm?: LLM;
  config: Config;
  fetcher?: typeof fetch;
  publicDir?: string;
}

async function jsonBody(c: { req: { json: <T>() => Promise<T> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new AppError('A valid JSON object body is required'); }
}

function textField(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

function sse(operation: (send: (event: string, data: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let heartbeat: ReturnType<typeof setInterval>;
      const enqueue = (value: string) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(value)); }
        catch { open = false; clearInterval(heartbeat); }
      };
      const send = (event: string, data: unknown) => enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      heartbeat = setInterval(() => enqueue(': keep-alive\n\n'), 15_000);
      operation(send).catch((error) => send('error', { error: error instanceof Error ? error.message : String(error) })).finally(() => {
        const shouldClose = open;
        open = false;
        clearInterval(heartbeat);
        if (shouldClose) controller.close();
      });
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
}

function configuredConnectors(store: Store, config: Config, fetcher: typeof fetch) {
  return createConnectors(effectiveConfig(config, store.getSettings()), fetcher);
}

export async function publishDraft(store: Store, config: Config, fetcher: typeof fetch, draft: Draft, connectorId: string): Promise<{ draft: Draft; result: unknown }> {
  if (draft.status !== 'approved') throw new AppError('Draft must be approved before publishing', 409);
  const connector = configuredConnectors(store, config, fetcher).find((item) => item.id === connectorId);
  if (!connector) throw new AppError('Connector not found', 404);
  if (!connector.configured) throw new AppError(`${connector.name} connector is not configured`);
  const result = await connector.publish(draft, store.getProject(draft.projectId));
  const published = store.transitionDraft(draft.id, 'published', { publication: { connector: connector.id, publishedAt: new Date().toISOString(), result } });
  return { draft: published, result };
}

export async function publishDueDrafts(store: Store, config: Config, fetcher: typeof fetch = fetch): Promise<void> {
  const actions = new ActionRunner(store, store.filename === ':memory:' ? undefined : config.dataDir);
  for (const draft of store.listDueDrafts()) {
    try { await actions.runAction({ actor: 'scheduler', action: 'publish', params: { draftId: draft.id, connector: draft.scheduledConnector }, summary: `Publish scheduled draft: ${draft.title}`, apply: () => publishDraft(store, config, fetcher, draft, draft.scheduledConnector!) }); }
    catch (error) { console.error(`Scheduled publication failed for ${draft.id}:`, error); }
  }
}

export async function runMaintenance(store: Store, config: Config, fetcher: typeof fetch = fetch, now = new Date()): Promise<void> {
  await publishDueDrafts(store, config, fetcher);
  if (store.filename !== ':memory:') { try { new BackupManager(store, config.dataDir).tick(); } catch (error) { console.error('Daily backup failed:', error); } }
  const settings = store.getSettings(); const actions = new ActionRunner(store, store.filename === ':memory:' ? undefined : config.dataDir);
  for (const project of store.listProjects()) for (const period of ['morning', 'evening'] as const) {
    const lastKey = `briefLast${period}:${project.id}`;
    if (!briefIsDue({ ...settings, [`briefLast${period}`]: settings[lastKey] || '' }, period, now)) continue;
    const draftInput = buildBrief(store, project.id, period, now);
    const outcome = await actions.runAction({ actor: `${period}-agent`, action: 'write_briefing', params: { projectId: project.id, period }, summary: draftInput.title, apply: () => store.createDraft(project.id, `${period}-brief`, draftInput) });
    store.setSettings({ [lastKey]: now.toLocaleDateString('sv-SE') });
    if (outcome.decision === 'proceed') {
      const cfg = effectiveConfig(config, store.getSettings());
      if (cfg.telegram.botToken && cfg.telegram.chatId && store.getSettings().briefTelegram === '1') {
        await fetcher(`https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `${draftInput.title}\n\n${draftInput.body}`.slice(0, 4096) }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      }
    }
  }
}

export function createApp({ store, llm, config, fetcher = fetch, publicDir = path.resolve('public') }: AppDependencies): Hono {
  const app = new Hono();
  const rate = new Map<string, { count: number; reset: number }>();
  const currentConfig = () => effectiveConfig(config, store.getSettings());
  const actions = new ActionRunner(store, store.filename === ':memory:' ? undefined : config.dataDir);
  const backups = new BackupManager(store, config.dataDir);
  const memory = new HindsightMemory(() => store.getSettings(), fetcher);
  const currentLLM = (purpose = 'general') => {
    const active = currentConfig();
    const inner = llm || new OpenAICompatibleLLM(active.llmBaseUrl, active.llmApiKey, active.llmModel, fetcher, active.llmTimeoutMs);
    return new ObservedLLM(inner, store, purpose, active.llmModel);
  };

  app.onError((error, c) => {
    const status = error instanceof AppError ? error.status : 500;
    if (!(error instanceof AppError)) console.error(error);
    return c.json({ error: error.message || 'Internal server error' }, status as 400);
  });
  app.use('/api/*', async (c, next) => {
    const key = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    const stamp = Date.now();
    const old = rate.get(key);
    const bucket = !old || old.reset <= stamp ? { count: 0, reset: stamp + 60_000 } : old;
    bucket.count += 1; rate.set(key, bucket);
    c.header('X-RateLimit-Limit', '120'); c.header('X-RateLimit-Remaining', String(Math.max(0, 120 - bucket.count)));
    if (bucket.count > 120) return c.json({ error: 'Too many requests; try again in a minute' }, 429);
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: store.integrityStatus === 'ok', version: '0.3.0', integrity: store.integrityStatus }));
  app.get('/api/settings', (c) => {
    const stored = store.getSettings();
    const extras = Object.fromEntries(settingKeys.filter((key) => !secretSettingKeys.has(key) && stored[key] !== undefined).map((key) => [key, stored[key]]));
    const configuredCap = Number(stored.llm_max_per_hour || stored.llmMaxPerHour || 60); const maxPerHour = Number.isInteger(configuredCap) && configuredCap > 0 ? configuredCap : 60;
    return c.json({ settings: { ...publicSettings(currentConfig()), ...extras }, llm: { ...store.llmStats(), maxPerHour }, backups: backups.list(), integrity: store.integrityStatus });
  });
  app.put('/api/settings', async (c) => {
    const body = await jsonBody(c);
    const updates: Record<string, string> = {};
    for (const key of settingKeys) {
      const value = textField(body[key]);
      if (value !== undefined && !(secretSettingKeys.has(key) && value.startsWith('••••'))) updates[key] = value.trim();
    }
    await actions.runAction({ actor: 'human', action: 'change_settings', apply: () => store.setSettings(updates) });
    return c.json({ settings: { ...publicSettings(currentConfig()), ...updates } });
  });
  app.post('/api/settings/test-llm', async (c) => {
    const result = await currentLLM('connection-test').complete('Reply with exactly OK.', 'Connection test');
    return c.json({ ok: true, response: result.slice(0, 100) });
  });
  app.post('/api/onboarding/profile', async (c) => {
    const body = await jsonBody(c); const url = textField(body.url); if (!url) throw new AppError('url is required');
    const page = await fetchPage(url, fetcher, config.allowPrivateFetch); const extracted = extractWebsiteProfile(page.html, page.url);
    let gaps: ReturnType<typeof validateProfileDraft> = null;
    if (!extracted.description || !extracted.audience || !extracted.tone) {
      try {
        const raw = await currentLLM('website-profile').complete('Return only JSON with exactly these string keys: name, description, audience, tone. Use only supplied website data. Keep name <=120, description <=1000, audience <=500, tone <=200 characters.', JSON.stringify({ name: extracted.name, description: extracted.description, headings: extracted.headings, text: extracted.text.slice(0, 10000) }));
        gaps = validateProfileDraft(raw);
      } catch { /* deterministic profile remains usable when the optional LLM fill is unavailable */ }
    }
    return c.json({ profile: { ...extracted, ...(gaps || {}) } });
  });

  app.get('/api/projects', (c) => c.json({ projects: store.listProjects() }));
  app.post('/api/projects', async (c) => {
    const body = await jsonBody(c);
    const language = textField(body.language);
    const project = store.createProject({
      name: textField(body.name), url: textField(body.url), description: textField(body.description),
      audience: textField(body.audience), tone: textField(body.tone), language: language === 'es' ? 'es' : 'en',
      competitors: textField(body.competitors)?.split(',').map((value) => value.trim()).filter(Boolean),
    });
    return c.json({ project }, 201);
  });
  app.patch('/api/projects/:id', async (c) => {
    const body = await jsonBody(c);
    const competitors = Array.isArray(body.competitors) ? body.competitors.map(String) : textField(body.competitors)?.split(',');
    return c.json({ project: store.updateProject(c.req.param('id'), { language: textField(body.language), competitors }) });
  });

  app.post('/api/projects/:id/strategy', async (c) => {
    const execute = async (send?: (event: string, data: unknown) => void) => {
      const project = store.getProject(c.req.param('id'));
      if (!project.url) throw new AppError('Project URL is required to build a strategy');
      send?.('progress', { message: 'Fetching and reading the website…' });
      const page = await fetchPage(project.url, fetcher, config.allowPrivateFetch);
      send?.('progress', { message: 'Building the strategy with the LLM…' });
      const strategy = await currentLLM('strategy').complete(
        `You are a pragmatic chief marketing officer. Write in ${project.language === 'es' ? 'Spanish' : 'English'}. Build a concise strategy grounded only in supplied information. Use Markdown sections: Positioning, Ideal customer profile, Keyword themes, Competitors to investigate, and Recommended channels. Clearly label assumptions.`,
        `Project: ${JSON.stringify(project)}\n\nWebsite text:\n${page.text}`,
      );
      const updated = store.setStrategy(project.id, strategy);
      send?.('result', { project: updated });
      return updated;
    };
    if (c.req.query('stream') === '1') return sse(async (send) => { send('progress', { message: 'Starting…' }); await execute(send); });
    return c.json({ project: await execute() });
  });

  app.get('/api/agents', (c) => c.json({ agents: agentDefinitions.map(({ systemPrompt: _hidden, ...agent }) => agent) }));
  app.post('/api/projects/:id/agents/:agent/run', async (c) => {
    const body = await jsonBody(c);
    const execute = async (send?: (event: string, data: unknown) => void) => {
      const project = store.getProject(c.req.param('id'));
      if (actions.isPaused()) throw new AppError('Agents are paused by Stop all', 409);
      send?.('progress', { message: `Running ${c.req.param('agent')} agent…` });
      const task = textField(body.task) || ''; const active = currentConfig();
      const queryEmbedding = store.getSettings().ragEmbeddings === '1' ? await fetchEmbedding(active.llmBaseUrl, active.llmApiKey, store.getSettings().embeddingModel || active.llmModel, task, fetcher) : null;
      const chunks = searchKnowledge(store.listKnowledgeChunks(project.id), task, { k: 4, queryEmbedding });
      const memories = await memory.recall(task);
      const outputs = await runAgent(c.req.param('agent'), project, task, currentLLM(`agent:${c.req.param('agent')}`), fetcher, {
        questionCount: typeof body.questionCount === 'number' ? body.questionCount : undefined,
        questions: Array.isArray(body.questions) ? body.questions.map(String) : undefined,
        allowPrivateFetch: config.allowPrivateFetch,
        knowledgeData: formatKnowledgeData(chunks), memoryData: memories.map((item, index) => `[M${index + 1}] ${item}`).join('\n'),
      });
      send?.('progress', { message: 'Saving drafts…' });
      const drafts: Draft[] = [];
      for (const output of outputs) {
        const outcome = await actions.runAction({ actor: c.req.param('agent'), action: 'create_draft', params: { projectId: project.id, agentId: c.req.param('agent'), output }, summary: `Create draft: ${output.title}`, apply: () => store.createDraft(project.id, c.req.param('agent'), output) });
        if (outcome.result) drafts.push(outcome.result);
      }
      for (const draft of drafts) {
        if (draft.agentId === 'geo') {
          const score = draft.metadata.score as { visible?: number; total?: number } | undefined;
          if (score?.total) store.addGeoHistory(project.id, score.visible || 0, score.total, (draft.metadata.checks as unknown[]) || []);
        }
      }
      send?.('result', { drafts });
      return drafts;
    };
    if (c.req.query('stream') === '1') return sse(async (send) => { send('progress', { message: 'Starting…' }); await execute(send); });
    return c.json({ drafts: await execute() }, 201);
  });
  app.get('/api/projects/:id/geo-history', (c) => c.json({ history: store.listGeoHistory(c.req.param('id')) }));

  app.get('/api/projects/:id/knowledge', (c) => c.json({ documents: store.listKnowledgeDocuments(c.req.param('id')) }));
  app.post('/api/projects/:id/knowledge', async (c) => {
    const body = await jsonBody(c); const text = textField(body.text)?.trim(); if (!text) throw new AppError('text is required');
    const active = currentConfig(); const useEmbeddings = store.getSettings().ragEmbeddings === '1';
    const parts = chunkText(text, 700); const chunks = [];
    for (const part of parts) chunks.push({ text: part, embedding: useEmbeddings ? await fetchEmbedding(active.llmBaseUrl, active.llmApiKey, store.getSettings().embeddingModel || active.llmModel, part, fetcher) : null });
    const document = store.addKnowledgeDocument(c.req.param('id'), textField(body.title) || 'Pasted note', textField(body.source) || 'paste', chunks);
    return c.json({ document }, 201);
  });
  app.post('/api/projects/:id/knowledge/import-site', async (c) => {
    const project = store.getProject(c.req.param('id')); if (!project.url) throw new AppError('Project URL is required');
    const page = await fetchPage(project.url, fetcher, config.allowPrivateFetch); const active = currentConfig(); const useEmbeddings = store.getSettings().ragEmbeddings === '1'; const chunks = [];
    for (const text of chunkText(page.text)) chunks.push({ text, embedding: useEmbeddings ? await fetchEmbedding(active.llmBaseUrl, active.llmApiKey, store.getSettings().embeddingModel || active.llmModel, text, fetcher) : null });
    const document = store.addKnowledgeDocument(project.id, `Website: ${new URL(page.url).hostname}`, page.url, chunks);
    return c.json({ document }, 201);
  });
  app.delete('/api/knowledge/:id', (c) => { store.deleteKnowledgeDocument(c.req.param('id')); return c.json({ ok: true }); });

  app.get('/api/policy', (c) => c.json({ policy: actions.getPolicy(), defaults: defaultPolicy, floor: [...actionFloor], paused: actions.isPaused(), approvals: store.listApprovals(), activity: actions.activity() }));
  app.put('/api/policy', async (c) => c.json({ policy: actions.setPolicy(await jsonBody(c)) }));
  app.post('/api/agents/stop', async (c) => { const body = await jsonBody(c); return c.json({ paused: actions.stop(body.paused !== false) }); });
  app.post('/api/approvals/:id/:decision', async (c) => {
    const approve = c.req.param('decision') === 'approve'; if (!approve && c.req.param('decision') !== 'reject') throw new AppError('Invalid decision');
    await actions.decide(c.req.param('id'), approve, {
      create_draft: (params) => store.createDraft(String(params.projectId), String(params.agentId), params.output as Parameters<Store['createDraft']>[2]),
      save_memory: async (params) => { await memory.retain(String(params.text || '')); },
    });
    return c.json({ ok: true });
  });

  app.get('/api/backups', (c) => c.json({ backups: backups.list(), integrity: store.integrityStatus }));
  app.post('/api/backups', (c) => c.json({ backup: backups.create('manual') }, 201));
  app.post('/api/backups/:name/restore', (c) => c.json(backups.restore(c.req.param('name'))));
  app.post('/api/projects/:id/briefs/:period', async (c) => {
    const period = c.req.param('period'); if (period !== 'morning' && period !== 'evening') throw new AppError('Invalid briefing period');
    const input = buildBrief(store, c.req.param('id'), period); const outcome = await actions.runAction({ actor: `${period}-agent`, action: 'write_briefing', params: { projectId: c.req.param('id'), period }, summary: input.title, apply: () => store.createDraft(c.req.param('id'), `${period}-brief`, input) });
    return c.json(outcome, outcome.result ? 201 : 202);
  });

  app.get('/api/drafts', (c) => c.json({ drafts: store.listDrafts(c.req.query('project'), c.req.query('status')) }));
  app.patch('/api/drafts/:id', async (c) => {
    const body = await jsonBody(c);
    return c.json({ draft: store.updateDraft(c.req.param('id'), { title: textField(body.title), body: textField(body.body) }) });
  });
  app.post('/api/drafts/:id/approve', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'approved') }));
  app.post('/api/drafts/:id/reject', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'rejected') }));
  app.post('/api/drafts/:id/schedule', async (c) => {
    const body = await jsonBody(c);
    const outcome = await actions.runAction({ actor: 'human', action: 'schedule', apply: () => store.scheduleDraft(c.req.param('id'), textField(body.scheduledAt) || null, textField(body.connector) || null) });
    return c.json({ draft: outcome.result });
  });
  app.post('/api/drafts/bulk', async (c) => {
    const body = await jsonBody(c);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const action = body.action === 'approve' ? 'approved' : body.action === 'reject' ? 'rejected' : null;
    if (!ids.length || !action) throw new AppError('ids and a valid action are required');
    const drafts = ids.flatMap((id) => {
      const draft = store.getDraft(id);
      if (draft.status === action || draft.status === 'published') return [];
      const eligible = action === 'approved' ? ['pending', 'rejected'].includes(draft.status) : ['pending', 'approved'].includes(draft.status);
      return eligible ? [store.transitionDraft(id, action)] : [];
    });
    return c.json({ drafts });
  });
  app.post('/api/drafts/:id/publish', async (c) => {
    const body = await jsonBody(c);
    const connectorId = textField(body.connector);
    if (!connectorId) throw new AppError('connector is required');
    const outcome = await actions.runAction({ actor: 'human', action: 'publish', apply: () => publishDraft(store, config, fetcher, store.getDraft(c.req.param('id')), connectorId) });
    return c.json(outcome.result!);
  });
  app.get('/api/connectors', (c) => c.json({ connectors: configuredConnectors(store, config, fetcher).map(({ id, name, configured }) => ({ id, name, configured })) }));

  app.all('/api/*', (c) => c.json({ error: 'API route not found' }, 404));
  app.use('/*', serveStatic({ root: publicDir }));
  app.get('*', serveStatic({ path: path.join(publicDir, 'index.html') }));
  return app;
}
