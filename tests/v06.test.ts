import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { parseOutlineBatch } from '../src/jobs.js';
import type { LLM } from '../src/types.js';

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, timeout = 2_000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error('Timed out waiting for job'); await pause(); }
}

function outline(count: number, prefix = 'Topic') {
  return JSON.stringify(Array.from({ length: count }, (_, index) => ({ topic: `${prefix} ${index}`, title: 'A useful repeated title', channel: ['blog', 'linkedin', 'x', 'newsletter'][index % 4], angle: `Angle ${index}` })));
}

test('v0.6 outline parser extracts and repairs common local-model JSON mistakes', () => {
  const raw = `Here is the plan:\n\`\`\`json\n[{topic:'Search basics',title:'A useful guide',channel:'blog',angle:'Practical steps',},]\n\`\`\``;
  assert.deepEqual(parseOutlineBatch(raw, 1), [{ topic: 'Search basics', title: 'A useful guide', channel: 'blog', angle: 'Practical steps' }]);
  assert.throws(() => parseOutlineBatch('[{"title":"Missing fields"}]', 1), /missing a valid/);
});

test('v0.6 local-model job concurrency defaults to one and validates overrides', () => {
  assert.equal(loadConfig({}).llmMaxConcurrency, 1); assert.equal(loadConfig({ LLM_MAX_CONCURRENCY: '2' }).llmMaxConcurrency, 2);
  assert.throws(() => loadConfig({ LLM_MAX_CONCURRENCY: '0' }), /positive integer/);
});

test('v0.6 running jobs return to queued after a database restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencmo-jobs-')); const filename = path.join(directory, 'test.sqlite');
  try {
    let store = new Store(filename); const project = store.createProject({ name: 'Acme' }); const job = store.createJob(project.id, 'strategy'); store.updateJob(job.id, { status: 'running', message: 'Working' }); store.close();
    store = new Store(filename); assert.equal(store.getJob(job.id).status, 'queued'); assert.match(store.getJob(job.id).message, /Resuming/); store.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('v0.6 month plan retries malformed outline JSON, creates placeholders, then fills all bodies', async () => {
  let malformedSent = false; let repairCalls = 0; let bodyCalls = 0;
  const llm: LLM = { complete: async (system) => {
    const count = Number(system.match(/exactly (\d+) objects/)?.[1] || 0);
    if (system.includes('content planner')) {
      if (!malformedSent) { malformedSent = true; return 'not json'; }
      if (system.includes('previous response was invalid')) repairCalls += 1;
      return outline(count);
    }
    bodyCalls += 1; return 'Specific, useful body grounded in the supplied facts.';
  } };
  const store = new Store(':memory:'); const app = createApp({ store, llm, config: loadConfig({}) });
  try {
    const project = store.createProject({ name: 'Acme', strategy: '# Plan' });
    const response = await app.request(`/api/projects/${project.id}/month-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 202); const job = (await response.json()).job;
    await waitFor(() => ['done', 'failed'].includes(store.getJob(job.id).status));
    assert.equal(store.getJob(job.id).status, 'done'); assert.equal(repairCalls, 1); assert.equal(bodyCalls, 30);
    const drafts = store.listDrafts(project.id); assert.equal(drafts.length, 30); assert.equal(new Set(drafts.map((draft) => draft.title)).size, 30);
    assert.equal(drafts.every((draft) => draft.status === 'pending' && draft.metadata.needsBody === false && draft.body.startsWith('Specific')), true);
  } finally { store.close(); }
});

test('v0.6 drafts needing bodies cannot be approved, scheduled, or published', async () => {
  const store = new Store(':memory:'); const app = createApp({ store, llm: { complete: async () => 'Body' }, config: loadConfig({}) });
  try {
    const project = store.createProject({ name: 'Acme' }); const draft = store.createDraft(project.id, 'month-planner', { channel: 'blog', title: 'Pending body', body: 'Writing…', metadata: { needsBody: true } });
    let response = await app.request(`/api/drafts/${draft.id}/approve`, { method: 'POST' }); assert.equal(response.status, 409);
    response = await app.request(`/api/drafts/${draft.id}/schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'markdown', scheduledAt: new Date().toISOString() }) }); assert.equal(response.status, 409);
    response = await app.request(`/api/drafts/${draft.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'markdown' }) }); assert.equal(response.status, 409);
  } finally { store.close(); }
});

test('v0.6 a running job can be cancelled without losing the partial job record', async () => {
  let release!: (value: string) => void; const blocked = new Promise<string>((resolve) => { release = resolve; });
  const store = new Store(':memory:'); const app = createApp({ store, llm: { complete: async () => blocked }, config: loadConfig({}) });
  try {
    const project = store.createProject({ name: 'Acme' }); const created = await app.request(`/api/projects/${project.id}/month-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const job = (await created.json()).job;
    await waitFor(() => store.getJob(job.id).status === 'running');
    const listed = await (await app.request(`/api/jobs?project=${project.id}`)).json(); assert.equal(listed.jobs[0].id, job.id);
    const stream = await app.request(`/api/jobs/stream?project=${project.id}`); const reader = stream.body!.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /event: jobs/); await reader.cancel();
    const cancelled = await app.request(`/api/jobs/${job.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).job.status, 'cancelled');
    release(outline(8)); await pause(30);
    assert.equal(store.getJob(job.id).status, 'cancelled'); assert.equal(store.listDrafts(project.id).length, 0);
  } finally { store.close(); }
});

test('v0.6 browser exposes persistent job progress, retry, cancel, and priority writing controls', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'); const js = fs.readFileSync(new URL('../public/app-v04.js', import.meta.url), 'utf8');
  for (const marker of ['id="job-chip"', 'name="llmFastModel"']) assert.ok(html.includes(marker), marker);
  for (const marker of ['/api/jobs/stream', '/write-now', 'confirmEstimate', 'writeNow', "t('cancel')", "t('retry')"]) assert.ok(js.includes(marker), marker);
});

test('outline parser keeps valid JSON that contains single-quoted phrases inside strings', async () => {
  const { parseOutlineBatch } = await import('../src/jobs.js');
  const raw = JSON.stringify([{ topic: "IA 'sin código'", title: "Guía 'rápida' para pymes", channel: 'blog', angle: "Explica el 'cómo' paso a paso" }]);
  const items = parseOutlineBatch(raw, 1);
  assert.equal(items[0].title, "Guía 'rápida' para pymes");
});
