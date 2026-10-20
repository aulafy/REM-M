import path from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { agentDefinitions, runAgent } from './agents.js';
import type { Config } from './config.js';
import { createConnectors } from './connectors.js';
import { Store } from './db.js';
import { AppError } from './errors.js';
import { fetchPage } from './web.js';
import type { LLM } from './types.js';

export interface AppDependencies {
  store: Store;
  llm: LLM;
  config: Config;
  fetcher?: typeof fetch;
  publicDir?: string;
}

async function jsonBody(c: { req: { json: <T>() => Promise<T> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new AppError('A valid JSON object body is required');
  }
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function createApp({ store, llm, config, fetcher = fetch, publicDir = path.resolve('public') }: AppDependencies): Hono {
  const app = new Hono();
  const connectors = createConnectors(config, fetcher);

  app.onError((error, c) => {
    const status = error instanceof AppError ? error.status : 500;
    if (!(error instanceof AppError)) console.error(error);
    return c.json({ error: error.message || 'Internal server error' }, status as 400);
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: '0.1.0' }));

  app.get('/api/projects', (c) => c.json({ projects: store.listProjects() }));
  app.post('/api/projects', async (c) => {
    const body = await jsonBody(c);
    const project = store.createProject({
      name: textField(body.name), url: textField(body.url), description: textField(body.description),
      audience: textField(body.audience), tone: textField(body.tone),
    });
    return c.json({ project }, 201);
  });

  app.post('/api/projects/:id/strategy', async (c) => {
    const project = store.getProject(c.req.param('id'));
    if (!project.url) throw new AppError('Project URL is required to build a strategy');
    const page = await fetchPage(project.url, fetcher);
    const strategy = await llm.complete(
      'You are a pragmatic chief marketing officer. Build a concise strategy document grounded only in the supplied business information and website text. Use Markdown sections: Positioning, Ideal customer profile, Keyword themes, Competitors to investigate, and Recommended channels. Clearly label assumptions.',
      `Project: ${JSON.stringify({ name: project.name, url: project.url, description: project.description, audience: project.audience, tone: project.tone })}\n\nWebsite text:\n${page.text}`,
    );
    return c.json({ project: store.setStrategy(project.id, strategy) });
  });

  app.get('/api/agents', (c) => c.json({ agents: agentDefinitions.map(({ systemPrompt: _hidden, ...agent }) => agent) }));
  app.post('/api/projects/:id/agents/:agent/run', async (c) => {
    const project = store.getProject(c.req.param('id'));
    const body = await jsonBody(c);
    const task = textField(body.task) || '';
    const outputs = await runAgent(c.req.param('agent'), project, task, llm, fetcher);
    const drafts = outputs.map((output) => store.createDraft(project.id, c.req.param('agent'), output));
    return c.json({ drafts }, 201);
  });

  app.get('/api/drafts', (c) => c.json({ drafts: store.listDrafts(c.req.query('project'), c.req.query('status')) }));
  app.patch('/api/drafts/:id', async (c) => {
    const body = await jsonBody(c);
    return c.json({ draft: store.updateDraft(c.req.param('id'), { title: textField(body.title), body: textField(body.body) }) });
  });
  app.post('/api/drafts/:id/approve', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'approved') }));
  app.post('/api/drafts/:id/reject', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'rejected') }));
  app.post('/api/drafts/:id/publish', async (c) => {
    const draft = store.getDraft(c.req.param('id'));
    if (draft.status !== 'approved') throw new AppError('Draft must be approved before publishing', 409);
    const body = await jsonBody(c);
    const connectorId = textField(body.connector);
    if (!connectorId) throw new AppError('connector is required');
    const connector = connectors.find((item) => item.id === connectorId);
    if (!connector) throw new AppError('Connector not found', 404);
    if (!connector.configured) throw new AppError(`${connector.name} connector is not configured`);
    const result = await connector.publish(draft, store.getProject(draft.projectId));
    const published = store.transitionDraft(draft.id, 'published', { publication: { connector: connector.id, publishedAt: new Date().toISOString(), result } });
    return c.json({ draft: published, result });
  });

  app.get('/api/connectors', (c) => c.json({ connectors: connectors.map(({ id, name, configured }) => ({ id, name, configured })) }));

  app.all('/api/*', (c) => c.json({ error: 'API route not found' }, 404));
  app.use('/*', serveStatic({ root: publicDir }));
  app.get('*', serveStatic({ path: path.join(publicDir, 'index.html') }));
  return app;
}
