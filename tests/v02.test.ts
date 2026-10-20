import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { publishDueDrafts } from '../src/app.js';
import { fuzzyMention, runAgent } from '../src/agents.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { assertSafeUrl, isPrivateAddress } from '../src/web.js';
import type { LLM } from '../src/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const llm: LLM = { complete: async () => 'OK' };

test('settings API masks secrets and preserves a masked key during updates', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store, llm, config: loadConfig({ LLM_API_KEY: 'secret-value' }) });
  try {
    let response = await app.request('/api/settings');
    assert.equal((await response.json()).settings.llmApiKey, '••••alue');
    response = await app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ llmApiKey: '••••alue', llmModel: 'new-model', llmTimeoutMs: '45000' }) });
    const settings = (await response.json()).settings;
    assert.equal(settings.llmApiKey, '••••alue');
    assert.equal(settings.llmModel, 'new-model');
    assert.equal(settings.llmTimeoutMs, '45000');
    assert.equal(store.getSettings().llmApiKey, undefined);
  } finally { store.close(); }
});

test('short secrets are never returned in full', async () => {
  const store = new Store(':memory:'); const app = createApp({ store, llm, config: loadConfig({ LLM_API_KEY: 'abc' }) });
  try { assert.equal((await (await app.request('/api/settings')).json()).settings.llmApiKey, '••••'); }
  finally { store.close(); }
});

test('API applies a basic per-client rate limit', async () => {
  const store = new Store(':memory:'); const app = createApp({ store, llm, config: loadConfig({}) });
  try {
    let response = new Response();
    for (let index = 0; index < 121; index += 1) response = await app.request('/api/health');
    assert.equal(response.status, 429);
  } finally { store.close(); }
});

test('agent streaming endpoint emits progress and a saved result', async () => {
  const store = new Store(':memory:'); const app = createApp({ store, llm, config: loadConfig({}) });
  try {
    const project = store.createProject({ name: 'Stream Co' });
    const response = await app.request(`/api/projects/${project.id}/agents/writer/run?stream=1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'A launch article' }),
    });
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const events = await response.text();
    assert.match(events, /event: progress/); assert.match(events, /event: result/);
    assert.equal(store.listDrafts(project.id).length, 1);
  } finally { store.close(); }
});

test('only approved drafts can be scheduled and due drafts are listed', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject({ name: 'Scheduled Co' });
    const draft = store.createDraft(project.id, 'writer', { channel: 'blog', title: 'Later', body: 'Body' });
    assert.throws(() => store.scheduleDraft(draft.id, new Date(0).toISOString(), 'markdown'));
    store.transitionDraft(draft.id, 'approved');
    const scheduled = store.scheduleDraft(draft.id, new Date(0).toISOString(), 'markdown');
    assert.equal(scheduled.scheduledConnector, 'markdown');
    assert.equal(store.listDueDrafts().length, 1);
  } finally { store.close(); }
});

test('scheduler publishes an approved due draft through its selected connector', async () => {
  const store = new Store(':memory:'); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencmo-scheduler-'));
  try {
    const project = store.createProject({ name: 'Scheduled Co' });
    const draft = store.createDraft(project.id, 'writer', { channel: 'blog', title: 'Due now', body: 'Body' });
    store.transitionDraft(draft.id, 'approved'); store.scheduleDraft(draft.id, new Date(0).toISOString(), 'markdown');
    await publishDueDrafts(store, loadConfig({ MARKDOWN_EXPORT_DIR: directory }));
    assert.equal(store.getDraft(draft.id).status, 'published'); assert.equal(fs.readdirSync(directory).length, 1);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('SSRF guard rejects loopback and private network targets', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('192.168.1.4'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  await assert.rejects(() => assertSafeUrl(new URL('http://localhost/admin')), /blocked/);
  await assert.rejects(() => assertSafeUrl(new URL('http://10.0.0.1/')), /blocked/);
});

test('GEO fuzzy matching handles punctuation and minor plural variation', () => {
  assert.equal(fuzzyMention('We recommend Acme.IO for teams.', 'Acme IO'), true);
  assert.equal(fuzzyMention('Northstars is another option.', 'Northstar'), true);
  assert.equal(fuzzyMention('An unrelated answer.', 'Acme'), false);
});

test('newsletter and launch agents create reviewable copy', async () => {
  const project = { id: 'p', name: 'Acme', url: '', description: '', audience: '', tone: '', language: 'en' as const, competitors: [], strategy: null, createdAt: '', updatedAt: '' };
  const newsletter = await runAgent('newsletter', project, 'October update', llm);
  const launch = await runAgent('launch', project, 'A local analytics app', llm);
  assert.equal(newsletter[0].channel, 'newsletter');
  assert.equal(launch[0].channel, 'launch-copy');
});
