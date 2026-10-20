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
import { dashboardActions, draftQuality, monthPlan, siteHealthFromAudit, starterDrafts } from './product.js';
import { auditUrl } from './web.js';
import { buildClientReport, competitorMetric, findSearchOpportunities, parseGscQueriesCsv, whereCompetitorsBeatYou } from './v05.js';
import { bodySystemPrompt, completeWithTokens, conciseStrategyPrompt, dedupeOutlineTitles, enforceBodyLimit, jobEstimate, JobWorker, monthBatchSizes, parseOutlineBatch, trimWords } from './jobs.js';
import { readFileSync } from 'node:fs';
import type { JobContext } from './jobs.js';

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

function modelIsSmall(value: string): boolean {
  const matches = [...value.toUpperCase().matchAll(/(?:^|[:_-]|\b)(\d+(?:\.\d+)?)\s*B\b/g)];
  return matches.some((match) => Number(match[1]) < 7);
}

function modelIsEmbeddingOnly(name: string): boolean {
  const model = name.toLowerCase().split('/').at(-1) || name.toLowerCase();
  return model.startsWith('bge-') || model.includes('embed');
}

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
  if (draft.metadata.needsBody) throw new AppError('This draft is still being written and cannot be published', 409, { code: 'draft_needs_body' });
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

const packageVersion = (() => { try { return String((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version || '0.0.0'); } catch { return '0.0.0'; } })();

export function createApp({ store, llm, config, fetcher = fetch, publicDir = path.resolve('public') }: AppDependencies): Hono {
  const app = new Hono();
  const rate = new Map<string, { count: number; reset: number }>();
  const currentConfig = () => effectiveConfig(config, store.getSettings());
  const actions = new ActionRunner(store, store.filename === ':memory:' ? undefined : config.dataDir);
  const backups = new BackupManager(store, config.dataDir);
  const memory = new HindsightMemory(() => store.getSettings(), fetcher);
  const currentLLM = (purpose = 'general', useFastModel = false) => {
    const active = currentConfig();
    const model = useFastModel && store.getSettings().llmFastModel ? store.getSettings().llmFastModel : active.llmModel;
    const inner = llm || new OpenAICompatibleLLM(active.llmBaseUrl, active.llmApiKey, model, fetcher, active.llmTimeoutMs);
    return new ObservedLLM(inner, store, purpose, model);
  };

  const writeDraftBody = async (jobId: string, draftId: string, context: JobContext) => {
    const draft = store.getDraft(draftId); if (!draft.metadata.needsBody) return;
    const project = store.getProject(draft.projectId);
    const chunks = searchKnowledge(store.listKnowledgeChunks(project.id), `${draft.title} ${String(draft.metadata.angle || '')}`, { k: 4 });
    store.updateDraftMetadata(draft.id, { writing: true });
    try {
      const body = await currentLLM('month-plan:body', true).complete(bodySystemPrompt(project, draft.channel), `Title: ${draft.title}\nAngle: ${String(draft.metadata.angle || '')}\nTopic: ${String(draft.metadata.topic || '')}\n\n${formatKnowledgeData(chunks)}`, context.signal);
      context.assertActive();
      const grounded = body.replace(/\s*\[K(\d+)\]/g, (match, n: string) => (Number(n) >= 1 && Number(n) <= chunks.length ? match : ''));
      const updated = store.updateDraft(draft.id, { body: enforceBodyLimit(draft.channel, grounded) });
      store.updateDraftMetadata(updated.id, { needsBody: false, writing: false, bodyJobId: jobId, sources: chunks.map((chunk, index) => ({ label: `K${index + 1}`, title: chunk.title, chunkId: chunk.id, documentId: chunk.documentId })) });
    } finally {
      if (store.getDraft(draft.id).metadata.writing) store.updateDraftMetadata(draft.id, { writing: false });
    }
  };

  const worker = new JobWorker(store, async (initial, context) => {
    if (actions.isPaused()) throw new AppError('Agents are paused by Stop all', 409);
    const project = store.getProject(initial.projectId);
    if (initial.kind === 'strategy') {
      if (!project.url) throw new AppError('Project URL is required to build a strategy');
      context.update({ message: 'Reading the website…' });
      const page = await fetchPage(project.url, fetcher, config.allowPrivateFetch); context.assertActive();
      context.update({ message: 'Writing your strategy…' });
      const strategy = await completeWithTokens(currentLLM('strategy'), conciseStrategyPrompt(project), `Project: ${JSON.stringify(project)}\n\nWebsite text:\n${page.text}`, context.token, context.signal);
      context.assertActive(); store.setStrategy(project.id, trimWords(strategy));
      return;
    }
    if (initial.kind === 'onboarding') {
      context.update({ total: 3, progress: 0, message: project.language === 'es' ? 'Comprobando la salud del sitio…' : 'Checking site health…', payload: { ...initial.payload, stage: 'health' } });
      const [page, audit] = await Promise.all([fetchPage(project.url, fetcher, config.allowPrivateFetch), auditUrl(project.url, fetcher, config.allowPrivateFetch)]); context.assertActive();
      const health = siteHealthFromAudit(audit); store.addHealthHistory(project.id, health.score, health as unknown as Record<string, unknown>);
      if (page.text && !store.listKnowledgeDocuments(project.id).length) store.addKnowledgeDocument(project.id, `Website: ${new URL(page.url).hostname}`, page.url, chunkText(page.text).map((text) => ({ text })));
      context.update({ progress: 1, message: project.language === 'es' ? 'Creando tu estrategia…' : 'Building your strategy…', payload: { ...context.assertActive().payload, stage: 'strategy' } });
      const strategy = await completeWithTokens(currentLLM('onboarding-strategy'), conciseStrategyPrompt(project), JSON.stringify({ project, health, websiteText: page.text.slice(0, 20_000) }), context.token, context.signal);
      context.assertActive(); store.setStrategy(project.id, trimWords(strategy));
      context.update({ progress: 2, message: project.language === 'es' ? 'Preparando 5 primeros borradores…' : 'Preparing 5 starter drafts…', payload: { ...context.assertActive().payload, stage: 'drafts' } });
      const pack = await currentLLM('onboarding-drafts').complete(`Return only a JSON array of exactly 5 objects with title, body, angle. Write in ${project.language === 'es' ? 'Spanish' : 'English'}. The items are, in order: useful blog outline, LinkedIn post <=1300 chars, X post <=280 chars, newsletter, meta description <=155 chars. Avoid clichés and invented claims.`, JSON.stringify({ project: store.getProject(project.id), strategy: trimWords(strategy) }), context.signal);
      for (const input of starterDrafts(project, pack)) {
        context.assertActive(); const output = { ...input, metadata: { ...input.metadata, sources: [{ label: 'K1', title: `Website: ${new URL(page.url).hostname}` }] } };
        await actions.runAction({ actor: 'onboarding', action: 'create_draft', params: { projectId: project.id, agentId: 'onboarding', output }, summary: `Starter draft: ${input.title}`, apply: () => store.createDraft(project.id, 'onboarding', output) });
      }
      store.setSettings({ onboardingComplete: '1', uiLanguage: project.language || 'en' });
      return;
    }
    if (initial.kind === 'draft-body') {
      const draftId = String(initial.payload.draftId || ''); if (!draftId) throw new AppError('Draft body job is missing its draft');
      context.update({ total: 1, progress: 0, message: 'Writing this draft…', payload: { ...initial.payload, currentDraftId: draftId } });
      await writeDraftBody(initial.id, draftId, context); return;
    }
    if (initial.kind !== 'month-plan') throw new AppError(`Unknown job kind: ${initial.kind}`);

    for (const draft of store.listDrafts(project.id).filter((item) => item.metadata.monthJobId === initial.id && item.metadata.writing)) store.updateDraftMetadata(draft.id, { writing: false });
    const used = new Set(store.listDrafts(project.id).filter((draft) => draft.metadata.monthJobId === initial.id).map((draft) => draft.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\W+/g, ' ').trim()));
    let offset = 0;
    for (let batch = 0; batch < monthBatchSizes.length; batch += 1) {
      const expected = monthBatchSizes[batch];
      const existing = store.listDrafts(project.id).filter((draft) => draft.metadata.monthJobId === initial.id && draft.metadata.outlineBatch === batch);
      if (existing.length >= expected) { offset += expected; continue; }
      context.update({ message: `${project.language === 'es' ? 'Planificando semana' : 'Planning week'} ${batch + 1}/4`, payload: { ...context.assertActive().payload, outlineBatch: batch } });
      const system = `You are a practical content planner. Return only a compact JSON array of exactly ${expected} objects with keys topic, title, channel, angle. No bodies. Allowed channels: blog, linkedin, x, newsletter. Write in ${project.language === 'es' ? 'Spanish' : 'English'}. Vary formats and search intent; avoid clichés and invented claims. Do not name competitors or build titles as comparisons against named brands.`;
      const user = `Week ${batch + 1} of 4. Do not repeat these titles: ${[...used].join(' | ')}\nProject: ${JSON.stringify(project)}\n${formatKnowledgeData(searchKnowledge(store.listKnowledgeChunks(project.id), `${project.name} ${project.strategy || ''}`, { k: 6 }))}`;
      let raw = await currentLLM(`month-plan:outline:${batch + 1}`).complete(system, user, context.signal); let outline;
      try { outline = parseOutlineBatch(raw, expected); }
      catch (firstError) {
        raw = await currentLLM(`month-plan:outline-repair:${batch + 1}`).complete(`${system}\nYour previous response was invalid. Repair it and return only valid JSON with exactly ${expected} items.`, `Invalid response:\n${raw.slice(0, 12_000)}\n\nValidation error: ${firstError instanceof Error ? firstError.message : String(firstError)}`, context.signal);
        try { outline = parseOutlineBatch(raw, expected); }
        catch (secondError) { console.error(`[month-plan] outline batch ${batch + 1} unparseable. First error: ${firstError instanceof Error ? firstError.message : firstError}. Raw start: ${JSON.stringify(raw.slice(0, 600))}`); throw secondError; }
      }
      const start = new Date(String(context.assertActive().payload.start || initial.createdAt));
      for (const [itemIndex, item] of dedupeOutlineTitles(outline.slice(existing.length), used).entries()) {
        context.assertActive(); const index = offset + existing.length + itemIndex; const date = new Date(start); date.setDate(date.getDate() + index); date.setHours(9 + index % 8, 0, 0, 0);
        const input = { channel: item.channel, title: item.title, body: project.language === 'es' ? 'Escribiendo…' : 'Writing…', metadata: { monthlyPlan: true, monthJobId: initial.id, outlineBatch: batch, topic: item.topic, angle: item.angle, plannedAt: date.toISOString(), needsBody: true, writing: false, sources: [] } };
        const outcome = await actions.runAction({ actor: 'month-planner', action: 'create_draft', params: { projectId: project.id, agentId: 'month-planner', output: input }, summary: `Plan: ${input.title}`, apply: () => store.createDraft(project.id, 'month-planner', input) });
        if (!outcome.result) throw new AppError('Monthly plan draft creation requires approval in Rules', 409);
      }
      offset += expected;
    }

    while (true) {
      context.assertActive(); const all = store.listDrafts(project.id).filter((draft) => draft.metadata.monthJobId === initial.id);
      const remaining = all.filter((draft) => draft.metadata.needsBody);
      if (!remaining.length) break;
      const fresh = context.assertActive(); const preferred = (Array.isArray(fresh.payload.priorityDraftIds) ? fresh.payload.priorityDraftIds.map(String) : []).filter((id) => remaining.some((draft) => draft.id === id));
      const selected = preferred.map((id) => remaining.find((draft) => draft.id === id)).find(Boolean) || remaining.sort((a, b) => String(a.metadata.plannedAt).localeCompare(String(b.metadata.plannedAt)))[0];
      const nextPreferred = preferred.filter((id) => id !== selected.id);
      const completed = all.length - remaining.length;
      context.update({ total: all.length, progress: completed, message: project.language === 'es' ? 'Escribiendo tu plan' : 'Writing your plan', payload: { ...fresh.payload, currentDraftId: selected.id, priorityDraftIds: nextPreferred } });
      await writeDraftBody(initial.id, selected.id, context);
      const done = store.listDrafts(project.id).filter((draft) => draft.metadata.monthJobId === initial.id && !draft.metadata.needsBody).length;
      context.update({ progress: done, message: project.language === 'es' ? 'Escribiendo tu plan' : 'Writing your plan', payload: { ...context.assertActive().payload, currentDraftId: '' } });
    }
  }, config.llmMaxConcurrency);
  worker.start();

  app.onError((error, c) => {
    const status = error instanceof AppError ? error.status : 500;
    if (!(error instanceof AppError)) console.error(error);
    return c.json({ error: error.message || 'Internal server error', ...(error instanceof AppError && error.details ? error.details : {}) }, status as 400);
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

  app.get('/api/health', (c) => c.json({ ok: store.integrityStatus === 'ok', version: packageVersion, integrity: store.integrityStatus }));
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
    const body = await jsonBody(c);
    const active = currentConfig();
    const baseUrl = textField(body.llmBaseUrl)?.replace(/\/$/, '') || active.llmBaseUrl;
    const model = textField(body.llmModel) || active.llmModel;
    const key = textField(body.llmApiKey);
    const apiKey = key && !key.startsWith('••••') ? key : active.llmApiKey;
    const candidate = new ObservedLLM(llm && !body.llmBaseUrl && !body.llmModel && !body.llmApiKey ? llm : new OpenAICompatibleLLM(baseUrl, apiKey, model, fetcher, active.llmTimeoutMs), store, 'connection-test', model);
    const result = await candidate.complete('Reply with exactly OK.', 'Connection test');
    return c.json({ ok: true, response: result.slice(0, 100) });
  });
  app.get('/api/engines/ollama', async (c) => {
    const active = currentConfig();
    const candidates = [...new Set([active.llmBaseUrl.replace(/\/v1\/?$/, ''), 'http://127.0.0.1:11434'])];
    for (const base of candidates) {
      try {
        const response = await fetcher(`${base}/api/tags`, { signal: AbortSignal.timeout(2_500) });
        if (!response.ok) continue;
        const payload = await response.json() as { models?: Array<{ name?: string; size?: number; details?: { parameter_size?: string } }> };
        const models = (payload.models || []).map((item) => ({ name: String(item.name || ''), size: Number(item.size || 0), parameterSize: String(item.details?.parameter_size || ''), small: modelIsSmall(String(item.details?.parameter_size || item.name || '')) })).filter((item) => item.name && !modelIsEmbeddingOnly(item.name));
        return c.json({ available: true, baseUrl: `${base}/v1`, models });
      } catch { /* try the next local endpoint */ }
    }
    return c.json({ available: false, baseUrl: 'http://127.0.0.1:11434/v1', models: [] });
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
  app.get('/api/overview', (c) => {
    const now = Date.now();
    const projects = store.listProjects().map((project) => {
      const drafts = store.listDrafts(project.id); const health = store.listHealthHistory(project.id).at(-1) || null;
      const future = drafts.filter((draft) => draft.scheduledAt && Date.parse(draft.scheduledAt) >= now).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))[0] || null;
      const overdue = drafts.filter((draft) => { const date = draft.scheduledAt || String(draft.metadata.plannedAt || ''); return date && Date.parse(date) < now && draft.status !== 'published'; }).length;
      return { project, healthScore: health?.score ?? null, pending: drafts.filter((draft) => draft.status === 'pending').length, nextScheduled: future ? { id: future.id, title: future.title, at: future.scheduledAt } : null, overdue };
    });
    return c.json({ projects });
  });
  app.get('/api/projects/check-url', (c) => c.json({ project: store.findProjectByUrl(c.req.query('url') || '') || null }));
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
  app.delete('/api/projects/:id', (c) => { store.deleteDemoProject(c.req.param('id')); return c.json({ ok: true }); });
  app.patch('/api/projects/:id', async (c) => {
    const body = await jsonBody(c);
    const competitors = Array.isArray(body.competitors) ? body.competitors.map(String) : textField(body.competitors)?.split(',');
    return c.json({ project: store.updateProject(c.req.param('id'), { language: textField(body.language), competitors, name: textField(body.name), description: textField(body.description), audience: textField(body.audience), tone: textField(body.tone) }) });
  });
  app.post('/api/projects/:id/merge', async (c) => {
    const body = await jsonBody(c);
    const language = textField(body.language);
    return c.json({ project: store.mergeProject(c.req.param('id'), { name: textField(body.name), description: textField(body.description), audience: textField(body.audience), tone: textField(body.tone), language: language === 'es' ? 'es' : language === 'en' ? 'en' : undefined, competitors: textField(body.competitors)?.split(',') }) });
  });

  app.post('/api/projects/:id/strategy', async (c) => {
    const project = store.getProject(c.req.param('id')); if (!project.url) throw new AppError('Project URL is required to build a strategy');
    if (actions.isPaused()) throw new AppError('Agents are paused by Stop all', 409);
    const job = store.createJob(project.id, 'strategy', { message: 'Strategy queued', total: 1 }); worker.announce(job); worker.wake();
    if (c.req.query('stream') === '1') return sse(async (send) => { send('result', { job }); });
    return c.json({ job, estimate: jobEstimate('strategy', store.llmStats().tokensPerSecond) }, 202);
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
        output.metadata = { ...output.metadata, sources: chunks.map((chunk, index) => ({ label: `K${index + 1}`, title: chunk.title, chunkId: chunk.id, documentId: chunk.documentId })) };
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
  app.post('/api/projects/:id/health', async (c) => {
    const project = store.getProject(c.req.param('id')); if (!project.url) throw new AppError('Project URL is required');
    const report = siteHealthFromAudit(await auditUrl(project.url, fetcher, config.allowPrivateFetch));
    return c.json({ health: store.addHealthHistory(project.id, report.score, report as unknown as Record<string, unknown>) }, 201);
  });
  app.get('/api/projects/:id/dashboard', (c) => {
    const project = store.getProject(c.req.param('id')); const drafts = store.listDrafts(project.id); const health = store.listHealthHistory(project.id); const geo = store.listGeoHistory(project.id);
    const latest = health.at(-1) || null; const previous = health.at(-2) || null;
    const weekEnd = Date.now() + 7 * 86_400_000;
    const schedule = drafts.filter((draft) => { const date = draft.scheduledAt || String(draft.metadata.plannedAt || ''); return date && Date.parse(date) <= weekEnd && Date.parse(date) >= Date.now() - 86_400_000; }).sort((a, b) => String(a.scheduledAt || a.metadata.plannedAt).localeCompare(String(b.scheduledAt || b.metadata.plannedAt))).slice(0, 7);
    const lastBrief = drafts.find((draft) => draft.agentId.endsWith('-brief')) || null;
    return c.json({ health: latest ? { ...latest, trend: previous ? latest.score - previous.score : 0 } : null, pending: drafts.filter((draft) => draft.status === 'pending').length, schedule, lastBrief, actions: dashboardActions(project, drafts, geo.map((item) => item.createdAt), project.language === 'es' ? 'es' : 'en') });
  });

  app.get('/api/projects/:id/report', (c) => {
    const project = store.getProject(c.req.param('id')); const health = store.listHealthHistory(project.id).at(-1) || null; const geo = store.listGeoHistory(project.id).at(-1) || null;
    const html = buildClientReport({ project, health, geo, drafts: store.listDrafts(project.id), opportunities: store.listSearchOpportunities(project.id), branding: store.getSettings() });
    const filename = `${project.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'client'}-marketing-report.html`;
    c.header('content-type', 'text/html; charset=utf-8'); c.header('content-disposition', `attachment; filename="${filename}"`); c.header('cache-control', 'no-store');
    return c.body(html);
  });

  app.get('/api/projects/:id/search-console', (c) => c.json({ opportunities: store.listSearchOpportunities(c.req.param('id')) }));
  app.post('/api/projects/:id/search-console', async (c) => {
    const body = await jsonBody(c); const csv = textField(body.csv); if (!csv) throw new AppError('csv is required');
    let rows; try { rows = parseGscQueriesCsv(csv); } catch (error) { throw new AppError(error instanceof Error ? error.message : 'Invalid Search Console CSV'); }
    const opportunities = store.replaceSearchOpportunities(c.req.param('id'), findSearchOpportunities(rows));
    return c.json({ imported: rows.length, opportunities }, 201);
  });
  app.post('/api/projects/:id/search-console/:opportunityId/draft', async (c) => {
    const project = store.getProject(c.req.param('id')); const opportunity = store.listSearchOpportunities(project.id).find((item) => item.id === c.req.param('opportunityId'));
    if (!opportunity) throw new AppError('Search opportunity not found', 404);
    if (actions.isPaused()) throw new AppError('Agents are paused by Stop all', 409);
    const task = `Draft a useful, evidence-led article for the search query "${opportunity.query}". Search Console context: ${opportunity.impressions} impressions, ${(opportunity.ctr * 100).toFixed(2)}% CTR, average position ${opportunity.position.toFixed(1)}. Address the search intent without inventing claims.`;
    const chunks = searchKnowledge(store.listKnowledgeChunks(project.id), opportunity.query, { k: 4 });
    const outputs = await runAgent('writer', project, task, currentLLM('agent:writer:gsc'), fetcher, { allowPrivateFetch: config.allowPrivateFetch, knowledgeData: formatKnowledgeData(chunks) });
    const drafts: Draft[] = [];
    for (const output of outputs) {
      output.metadata = { ...output.metadata, searchOpportunity: opportunity, sources: chunks.map((chunk, index) => ({ label: `K${index + 1}`, title: chunk.title, chunkId: chunk.id, documentId: chunk.documentId })) };
      const outcome = await actions.runAction({ actor: 'writer', action: 'create_draft', params: { projectId: project.id, agentId: 'writer', output }, summary: `Search opportunity: ${opportunity.query}`, apply: () => store.createDraft(project.id, 'writer', output) });
      if (outcome.result) drafts.push(outcome.result);
    }
    return c.json({ drafts, approvalRequired: drafts.length === 0 }, drafts.length ? 201 : 202);
  });

  app.post('/api/projects/:id/competitors/audit', async (c) => {
    const project = store.getProject(c.req.param('id')); const body = await jsonBody(c);
    const requested = Array.isArray(body.urls) ? body.urls.map(String) : project.competitors || [];
    const urls = requested.map((value) => value.trim()).filter(Boolean); if (!project.url) throw new AppError('Project URL is required');
    if (!urls.length) throw new AppError('Add at least one competitor URL');
    if (urls.length > 5) throw new AppError('Add no more than five competitor URLs');
    store.updateProject(project.id, { competitors: urls });
    const audits = await Promise.all([project.url, ...urls].map((url) => auditUrl(url, fetcher, config.allowPrivateFetch)));
    const comparison = audits.map(competitorMetric); const whereTheyBeatYou = whereCompetitorsBeatYou(comparison[0], comparison.slice(1));
    return c.json({ comparison, whereTheyBeatYou });
  });

  app.post('/api/demo', (c) => {
    const es = (c.req.query('language') || 'en') === 'es';
    const project = store.createProject({ name: 'Luna Studio', description: es ? 'Estudio ficticio de diseño web sostenible para pequeños negocios.' : 'A fictional sustainable web design studio for small businesses.', audience: es ? 'Fundadores y comercios locales' : 'Founders and local businesses', tone: es ? 'Cálido, claro y práctico' : 'Warm, clear, and practical', language: es ? 'es' : 'en', isDemo: true, strategy: es ? '# Posicionamiento\nDiseño web sostenible y claro para pequeños negocios.\n\n# Cliente ideal\nFundadores que necesitan una web eficaz sin un proceso complejo.\n\n# Canales\nLinkedIn, newsletter y contenido educativo.' : '# Positioning\nClear, sustainable web design for small businesses.\n\n# Ideal customer\nFounders who need an effective website without a complex process.\n\n# Channels\nLinkedIn, newsletter, and educational content.' });
    const examples = starterDrafts(project, '');
    const source = { label: 'K1', title: es ? 'Guía de marca de Luna Studio' : 'Luna Studio brand guide', documentId: 'demo-brand-guide' };
    examples.forEach((input, index) => store.createDraft(project.id, 'demo', { ...input, metadata: { ...input.metadata, plannedAt: new Date(Date.now() + index * 86_400_000).toISOString(), demo: true, sources: [source] } }));
    store.addGeoHistory(project.id, 2, 5, []); store.addGeoHistory(project.id, 3, 5, []);
    store.addHealthHistory(project.id, 78, { issues: es ? ['Falta una descripción meta en una página'] : ['One page is missing a meta description'], demo: true });
    store.addKnowledgeDocument(project.id, es ? 'Guía de marca' : 'Brand guide', 'demo', [{ text: project.description }]);
    return c.json({ project }, 201);
  });

  app.post('/api/onboarding/run', async (c) => {
    const body = await jsonBody(c);
    if (c.req.query('stream') === '1') {
      const url = textField(body.url); if (!url) throw new AppError('url is required');
      const existing = store.findProjectByUrl(url); if (existing) throw new AppError('A project for this website already exists', 409, { code: 'duplicate_project', project: existing });
      const language = textField(body.language) === 'es' ? 'es' : 'en'; const supplied = body.profile && typeof body.profile === 'object' ? body.profile as Record<string, unknown> : {};
      const project = store.createProject({ name: textField(supplied.name) || new URL(url).hostname, url, description: textField(supplied.description), audience: textField(supplied.audience), tone: textField(supplied.tone), language });
      const job = store.createJob(project.id, 'onboarding', { total: 3, message: language === 'es' ? 'Análisis en cola' : 'Analysis queued', payload: { stage: 'health' } }); worker.announce(job); worker.wake();
      return sse(async (send) => { send('result', { project, health: null, drafts: [], job }); });
    }
    const execute = async (send?: (event: string, data: unknown) => void) => {
      const url = textField(body.url); if (!url) throw new AppError('url is required');
      const existing = store.findProjectByUrl(url); if (existing) throw new AppError('A project for this website already exists', 409, { code: 'duplicate_project', project: existing });
      const language = textField(body.language) === 'es' ? 'es' : 'en';
      const supplied = body.profile && typeof body.profile === 'object' ? body.profile as Record<string, unknown> : {};
      send?.('progress', { step: 'health', message: language === 'es' ? 'Comprobando la salud del sitio…' : 'Checking site health…' });
      const [page, audit] = await Promise.all([fetchPage(url, fetcher, config.allowPrivateFetch), auditUrl(url, fetcher, config.allowPrivateFetch)]);
      const extracted = extractWebsiteProfile(page.html, page.url);
      const profile = { ...extracted, ...Object.fromEntries(['name', 'description', 'audience', 'tone'].flatMap((key) => typeof supplied[key] === 'string' && supplied[key] ? [[key, supplied[key]]] : [])) };
      const health = siteHealthFromAudit(audit);
      const provisional = { id: '', name: profile.name, url: page.url, description: profile.description, audience: profile.audience, tone: profile.tone, language, competitors: [], strategy: null, createdAt: '', updatedAt: '' } as const;
      send?.('progress', { step: 'strategy', message: language === 'es' ? 'Creando tu estrategia…' : 'Building your strategy…' });
      const strategy = await currentLLM('onboarding-strategy').complete(`You are a pragmatic CMO. Write concise Markdown in ${language === 'es' ? 'Spanish' : 'English'} with Positioning, Ideal customer, Themes, Competitors, Channels, and First 30 days. Use only the supplied facts; label assumptions.`, JSON.stringify({ profile, health }));
      send?.('progress', { step: 'drafts', message: language === 'es' ? 'Preparando 5 primeros borradores…' : 'Preparing 5 starter drafts…' });
      const pack = await currentLLM('onboarding-drafts').complete(`Return only a JSON array of exactly 5 objects with title, body, angle. Write in ${language === 'es' ? 'Spanish' : 'English'}. The items are, in order: useful blog outline, LinkedIn post <=1300 chars, X post <=280 chars, newsletter, meta description <=155 chars. Avoid clichés and invented claims.`, JSON.stringify({ project: provisional, strategy }));
      const project = store.createProject({ name: profile.name, url: page.url, description: profile.description, audience: profile.audience, tone: profile.tone, language, strategy });
      store.addHealthHistory(project.id, health.score, health as unknown as Record<string, unknown>);
      if (page.text) store.addKnowledgeDocument(project.id, `Website: ${new URL(page.url).hostname}`, page.url, chunkText(page.text).map((text) => ({ text })));
      const drafts: Draft[] = [];
      for (const input of starterDrafts(project, pack)) {
        const output = { ...input, metadata: { ...input.metadata, sources: [{ label: 'K1', title: `Website: ${new URL(page.url).hostname}` }] } };
        const outcome = await actions.runAction({ actor: 'onboarding', action: 'create_draft', params: { projectId: project.id, agentId: 'onboarding', output }, summary: `Starter draft: ${input.title}`, apply: () => store.createDraft(project.id, 'onboarding', output) });
        if (outcome.result) drafts.push(outcome.result);
      }
      store.setSettings({ onboardingComplete: '1', uiLanguage: language });
      send?.('result', { project, health, drafts });
      return { project, health, drafts };
    };
    return c.json(await execute(), 201);
  });

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
  app.post('/api/agents/stop', async (c) => {
    const body = await jsonBody(c); const paused = actions.stop(body.paused !== false);
    if (paused) for (const job of store.listJobs().filter((item) => ['queued', 'running'].includes(item.status))) worker.cancel(job.id);
    return c.json({ paused });
  });
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

  app.post('/api/projects/:id/month-plan', async (c) => {
    const project = store.getProject(c.req.param('id'));
    if (actions.isPaused()) throw new AppError('Agents are paused by Stop all', 409);
    if (project.isDemo) {
      const created = monthPlan(project, '').map((input) => store.createDraft(project.id, 'month-planner', { ...input, metadata: { ...input.metadata, sources: [{ label: 'K1', title: 'Luna Studio brand guide' }] } }));
      return c.json({ drafts: created, job: null }, 201);
    }
    const active = store.listJobs(project.id).find((job) => job.kind === 'month-plan' && ['queued', 'running'].includes(job.status));
    if (active) return c.json({ job: active, estimate: jobEstimate('month-plan', store.llmStats().tokensPerSecond) }, 202);
    const job = store.createJob(project.id, 'month-plan', { total: 30, message: 'Monthly plan queued', payload: { start: new Date().toISOString(), priorityDraftIds: [] } }); worker.announce(job); worker.wake();
    return c.json({ job, drafts: [], estimate: jobEstimate('month-plan', store.llmStats().tokensPerSecond) }, 202);
  });

  app.get('/api/estimate', (c) => c.json({ estimate: jobEstimate(c.req.query('kind') || 'strategy', store.llmStats().tokensPerSecond) }));
  app.get('/api/projects/:id/estimate', (c) => { store.getProject(c.req.param('id')); return c.json({ estimate: jobEstimate(c.req.query('kind') || 'strategy', store.llmStats().tokensPerSecond) }); });
  app.get('/api/jobs', (c) => c.json({ jobs: store.listJobs(c.req.query('project')) }));
  app.get('/api/jobs/stream', (c) => {
    const projectId = c.req.query('project'); const encoder = new TextEncoder(); let cleanup = () => {}; let cleaned = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const send = (event: string, data: unknown) => { if (!open) return; try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { open = false; cleanup(); } };
        send('jobs', { jobs: store.listJobs(projectId) });
        const unsubscribe = worker.subscribe((event) => { if (!projectId || event.job.projectId === projectId) send(event.type, event.type === 'token' ? { job: event.job, token: event.token } : { job: event.job }); });
        const heartbeat = setInterval(() => send('ping', { at: Date.now() }), 15_000);
        cleanup = () => { if (cleaned) return; cleaned = true; open = false; clearInterval(heartbeat); unsubscribe(); };
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  });
  app.post('/api/jobs/:id/cancel', (c) => c.json({ job: worker.cancel(c.req.param('id')) }));
  app.post('/api/jobs/:id/retry', (c) => { const job = store.retryJob(c.req.param('id')); worker.announce(job); worker.wake(); return c.json({ job }); });

  app.get('/api/drafts', (c) => c.json({ drafts: store.listDrafts(c.req.query('project'), c.req.query('status')).map((draft) => ({ ...draft, quality: draftQuality(draft.channel, draft.body) })) }));
  app.patch('/api/drafts/:id', async (c) => {
    const body = await jsonBody(c);
    const draft = store.updateDraft(c.req.param('id'), { title: textField(body.title), body: textField(body.body) });
    return c.json({ draft: { ...draft, quality: draftQuality(draft.channel, draft.body) } });
  });
  app.post('/api/drafts/:id/approve', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'approved') }));
  app.post('/api/drafts/:id/reject', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'rejected') }));
  app.post('/api/drafts/:id/undo-reject', (c) => c.json({ draft: store.transitionDraft(c.req.param('id'), 'pending') }));
  app.post('/api/drafts/:id/regenerate', async (c) => {
    const body = await jsonBody(c); const draft = store.getDraft(c.req.param('id'));
    if (draft.status === 'published') throw new AppError('Published drafts cannot be regenerated', 409);
    const feedback = textField(body.feedback)?.trim() || `Remove these AI-sounding phrases: ${draftQuality(draft.channel, draft.body).cliches.join(', ') || 'generic filler'}`;
    const project = store.getProject(draft.projectId);
    const rewritten = await currentLLM('draft-regenerate').complete(`Rewrite marketing copy in ${project.language === 'es' ? 'Spanish' : 'English'}. Preserve verified facts and any [K#] citations. Respect the channel format and hard limits. Return only the rewritten body.`, `Channel: ${draft.channel}\nFeedback: ${feedback}\n\nCurrent draft:\n${draft.body}`);
    const updated = store.updateDraft(draft.id, { body: rewritten });
    return c.json({ draft: { ...updated, quality: draftQuality(updated.channel, updated.body) } });
  });
  app.post('/api/drafts/:id/write-now', (c) => {
    const draft = store.getDraft(c.req.param('id')); if (!draft.metadata.needsBody) throw new AppError('This draft already has a body', 409);
    const parentId = String(draft.metadata.monthJobId || ''); let job = parentId ? store.getJob(parentId) : undefined;
    if (job && ['running', 'queued'].includes(job.status)) {
      const priorities = Array.isArray(job.payload.priorityDraftIds) ? job.payload.priorityDraftIds.map(String).filter((id) => id !== draft.id) : [];
      job = store.updateJob(job.id, { payload: { ...job.payload, priorityDraftIds: [draft.id, ...priorities] }, priority: job.priority + 1, message: 'Priority draft queued next' });
    } else if (job && ['failed', 'cancelled'].includes(job.status)) {
      const priorities = Array.isArray(job.payload.priorityDraftIds) ? job.payload.priorityDraftIds.map(String).filter((id) => id !== draft.id) : [];
      store.updateJob(job.id, { payload: { ...job.payload, priorityDraftIds: [draft.id, ...priorities] } }); job = store.retryJob(job.id);
    } else job = store.createJob(draft.projectId, 'draft-body', { total: 1, message: 'Priority draft queued', priority: 100, payload: { draftId: draft.id } });
    worker.announce(job); worker.wake(); return c.json({ job }, 202);
  });
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
  app.get('/', serveStatic({ path: path.join(publicDir, 'guided.html') }));
  app.get('/advanced', serveStatic({ path: path.join(publicDir, 'index.html') }));
  app.use('/*', serveStatic({ root: publicDir }));
  app.get('*', serveStatic({ path: path.join(publicDir, 'index.html') }));
  return app;
}
