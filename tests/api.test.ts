import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import type { LLM } from '../src/types.js';

const llm: LLM = { complete: async () => '# Generated content\n\nReady for review.' };

test('API creates a draft and enforces approval before Markdown publication', async () => {
  const store = new Store(':memory:');
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencmo-test-'));
  const config = loadConfig({ PORT: '3000', MARKDOWN_EXPORT_DIR: exportDir });
  const app = createApp({ store, llm, config });
  try {
    let response = await app.request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Acme' }) });
    assert.equal(response.status, 201);
    const project = (await response.json()).project;

    response = await app.request(`/api/projects/${project.id}/agents/writer/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'Write a launch article' }) });
    assert.equal(response.status, 201);
    const draft = (await response.json()).drafts[0];

    response = await app.request(`/api/drafts/${draft.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'markdown' }) });
    assert.equal(response.status, 409);

    response = await app.request(`/api/drafts/${draft.id}/approve`, { method: 'POST' });
    assert.equal(response.status, 200);
    response = await app.request(`/api/drafts/${draft.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'markdown' }) });
    assert.equal(response.status, 200);
    const published = await response.json();
    assert.equal(published.draft.status, 'published');
    assert.equal(fs.readdirSync(exportDir).length, 1);

    response = await app.request('/api/does-not-exist');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'API route not found' });
  } finally {
    store.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
});
