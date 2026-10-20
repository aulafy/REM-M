import path from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { agentDefinitions, runAgent } from './agents.js';
import type { Config } from './config.js';
import { createConnectors } from './connectors.js';
import { Store } from './db.js';
import { AppError } from './errors.js';
import { OpenAICompatibleLLM } from './llm.js';
import { effectiveConfig, publicSettings, secretSettingKeys, settingKeys } from './settings.js';
import { fetchPage } from './web.js';
import type { Draft, LLM } from './types.js';

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
  for (const draft of store.listDueDrafts()) {
    try { await publishDraft(store, config, fetcher, draft, draft.scheduledConnector!); }
    catch (error) { console.error(`Scheduled publication failed for ${draft.id}:`, error); }
  }
}

export function createApp({ store, llm, config, fetcher = fetch, publicDir = path.resolve('public') }: AppDependencies): Hono {
  const app = new Hono();
  const rate = new Map<string, { count: number; reset: number }>();
  const currentConfig = () => effectiveConfig(config, store.getSettings());
  const currentLLM = () => {
    const active = currentConfig();
    return llm || new OpenAICompatibleLLM(active.llmBaseUrl, active.llmApiKey, active.llmModel, fetcher, active.llmTimeoutMs);
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

  app.get('/api/health', (c) => c.json({ ok: true, version: '0.2.0' }));
  app.get('/api/settings', (c) => c.json({ settings: publicSettings(currentConfig()) }));
  app.put('/api/settings', async (c) => {
    const body = await jsonBody(c);
    const updates: Record<string, string> = {};
    for (const key of settingKeys) {
      const value = textField(body[key]);
      if (value !== undefined && !(secretSettingKeys.has(key) && value.startsWith('••••'))) updates[key] = value.trim();
    }
    store.setSettings(updates);
    return c.json({ settings: publicSettings(currentConfig()) });
  });
  app.post('/api/settings/test-llm', async (c) => {
    const result = await currentLLM().complete('Reply with exactly OK.', 'Connection test');
    return c.json({ ok: true, response: result.slice(0, 100) });
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
      const strategy = await currentLLM().complete(
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
      send?.('progress', { message: `Running ${c.req.param('agent')} agent…` });
      const outputs = await runAgent(c.req.param('agent'), project, textField(body.task) || '', currentLLM(), fetcher, {
        questionCount: typeof body.questionCount === 'number' ? body.questionCount : undefined,
        questions: Array.isArray(body.questions) ? body.questions.map(String) : undefined,
        allowPrivateFetch: config.allowPrivateFetch,
      });
      send?.('progress', { message: 'Saving drafts…' });
      const drafts = outputs.map((output) => store.createDraft(project.id, c.req.param('agent'), output));
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

  app.get('/api/drafts', (c) => c.json({ drafts: store.listDrafts(c.req.query('project'), c.req.query('status')) }));
  app.patch('/api/drafts/:id', async (c) => {
    const body = await jsonBody(c);
    return c.json({ draft: store.updateDraft(c.req.param('id'), { title: textField(body.title), body: textField(body.body) }) });
  });
  app.post('/api/drafts/:id/approve', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'approved') }));
  app.post('/api/drafts/:id/reject', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'rejected') }));
  app.post('/api/drafts/:id/schedule', async (c) => {
    const body = await jsonBody(c);
    return c.json({ draft: store.scheduleDraft(c.req.param('id'), textField(body.scheduledAt) || null, textField(body.connector) || null) });
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
    return c.json(await publishDraft(store, config, fetcher, store.getDraft(c.req.param('id')), connectorId));
  });
  app.get('/api/connectors', (c) => c.json({ connectors: configuredConnectors(store, config, fetcher).map(({ id, name, configured }) => ({ id, name, configured })) }));

  app.all('/api/*', (c) => c.json({ error: 'API route not found' }, 404));
  app.use('/*', serveStatic({ root: publicDir }));
  app.get('*', serveStatic({ path: path.join(publicDir, 'index.html') }));
  return app;
}
