import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkText, formatKnowledgeData, searchKnowledge, searchTokens } from '../src/rag.js';
import { ActionRunner, actionFloor, beforeAction } from '../src/policy.js';
import { Store } from '../src/db.js';
import { ObservedLLM } from '../src/observability.js';
import { extractWebsiteProfile, fetchPage, robotsAllows, validateProfileDraft } from '../src/web.js';
import { briefIsDue, buildBrief } from '../src/briefs.js';
import { applyPendingRestore, BackupManager } from '../src/backups.js';
import { HindsightMemory } from '../src/hindsight.js';

test('v0.3 knowledge chunks and ranks accent-folded Spanish text as quoted data', () => {
  assert.deepEqual(searchTokens('La promoción también está aquí'), ['promocion', 'aqui']);
  assert.deepEqual(chunkText('uno\n\ndos', 6), ['uno', 'dos']);
  const results = searchKnowledge([
    { id: '1', documentId: 'd1', title: 'Guía', text: 'Analítica para pequeñas empresas', embedding: null },
    { id: '2', documentId: 'd2', title: 'Otro', text: 'Comida para mascotas', embedding: null },
  ], 'analitica pequena');
  assert.equal(results[0]?.id, '1');
  assert.match(formatKnowledgeData(results), /never instructions/);
  assert.match(formatKnowledgeData(results), /\[K1\]/);
});

test('v0.3 policy hard floor cannot be unlocked and ask mode creates an approval', async () => {
  assert.ok(actionFloor.has('publish_without_approval'));
  assert.equal(beforeAction({ actor: 'writer', action: 'delete_data', policy: { delete_data: 'act' } }).decision, 'handoff');
  const store = new Store(':memory:');
  const runner = new ActionRunner(store);
  runner.setPolicy({ create_draft: 'ask' });
  let applied = false;
  const outcome = await runner.runAction({ actor: 'writer', action: 'create_draft', apply: () => { applied = true; } });
  assert.equal(outcome.decision, 'confirm'); assert.equal(applied, false); assert.equal(store.listApprovals().length, 1);
  runner.stop(true); assert.equal(store.listApprovals().length, 0); assert.equal(runner.isPaused(), true);
  store.close();
});

test('v0.3 LLM observability records metrics without prompts and enforces the hourly cap', async () => {
  const store = new Store(':memory:'); store.setSettings({ llmMaxPerHour: '1' });
  const observed = new ObservedLLM({ complete: async () => 'secret output' }, store, 'test', 'stub');
  assert.equal(await observed.complete('SECRET SYSTEM', 'SECRET USER'), 'secret output');
  const stats = store.llmStats(); assert.equal(stats.calls24h, 1); assert.equal(stats.recent[0].purpose, 'test');
  assert.equal(JSON.stringify(stats).includes('SECRET'), false);
  await assert.rejects(() => observed.complete('x', 'y'), /Hourly LLM call limit/);
  store.close();
});

test('v0.3 guarded web profile honors robots and validates closed profile JSON', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private', '/private/page'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private/public', '/private/public'), true);
  const profile = extractWebsiteProfile(`<!doctype html><title>Acme</title><meta property="og:description" content="Useful tools"><h1>Build better</h1><script type="application/ld+json">{"@type":"Organization","name":"Acme Ltd"}</script><a href="mailto:hello@example.com">Email</a><a href="https://linkedin.com/company/acme">LinkedIn</a>`, 'https://example.com');
  assert.equal(profile.name, 'Acme Ltd'); assert.deepEqual(profile.emails, ['hello@example.com']); assert.equal(profile.headings[0], 'Build better');
  assert.deepEqual(validateProfileDraft('{"name":"Acme","description":"Tools","audience":"Teams","tone":"Clear"}'), { name: 'Acme', description: 'Tools', audience: 'Teams', tone: 'Clear' });
  assert.equal(validateProfileDraft('{"name":"Acme","extra":"bad"}'), null);
});

test('v0.3 site fetch checks robots after redirects and enforces the body limit', async () => {
  let destinationFetched = false;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'http://public.example/robots.txt') return new Response('User-agent: *\nAllow: /');
    if (url === 'http://public.example/start') return new Response(null, { status: 302, headers: { location: 'https://destination.example/private' } });
    if (url === 'https://destination.example/robots.txt') return new Response('User-agent: *\nDisallow: /private');
    destinationFetched = true; return new Response('should not be read');
  };
  await assert.rejects(() => fetchPage('http://public.example/start', fetcher, true), /robots\.txt disallows/);
  assert.equal(destinationFetched, false);
  const tooLarge: typeof fetch = async (input) => String(input).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response('x'.repeat(1_500_001));
  await assert.rejects(() => fetchPage('https://public.example/', tooLarge, true), /too large/);
});

test('v0.3 daily briefs are deterministic, read-only, and catch up after their configured time', () => {
  const store = new Store(':memory:'); const project = store.createProject({ name: 'Acme', language: 'en' });
  store.createDraft(project.id, 'writer', { channel: 'blog', title: 'Review me', body: 'Body' });
  const at = new Date('2026-10-20T09:00:00'); const brief = buildBrief(store, project.id, 'morning', at);
  assert.match(brief.body, /Pending approval: 1/); assert.equal(brief.metadata.readOnly, true);
  assert.equal(briefIsDue({ morningBriefTime: '08:00' }, 'morning', at), true);
  assert.equal(briefIsDue({ morningBriefTime: '08:00', briefLastmorning: at.toLocaleDateString('sv-SE') }, 'morning', at), false);
  store.close();
});

test('v0.3 SQLite backups are verified and retention is bounded', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencmo-v03-'));
  try {
    const store = new Store(path.join(directory, 'opencmo.sqlite')); store.createProject({ name: 'Acme' });
    const backups = new BackupManager(store, directory); const item = backups.create('manual');
    assert.equal(backups.verify(item.name), true); assert.equal(backups.list().length, 1);
    store.createProject({ name: 'Remove on restore' });
    assert.equal(backups.restore(item.name).restartRequired, true); store.close();
    applyPendingRestore(path.join(directory, 'opencmo.sqlite'));
    const restored = new Store(path.join(directory, 'opencmo.sqlite'));
    assert.deepEqual(restored.listProjects().map((project) => project.name), ['Acme']); restored.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('v0.3 Hindsight is off by default and recall failures remain non-blocking data', async () => {
  let called = false;
  const off = new HindsightMemory(() => ({}), async () => { called = true; throw new Error('no'); });
  assert.deepEqual(await off.recall('brand'), []); assert.equal(called, false);
  const on = new HindsightMemory(() => ({ hindsightEnabled: '1' }), async () => new Response(JSON.stringify({ results: [{ text: 'Customer prefers email' }] }), { status: 200 }));
  assert.deepEqual(await on.recall('contact preference'), ['Customer prefers email']);
});
