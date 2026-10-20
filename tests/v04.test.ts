import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { dashboardActions, draftQuality, monthPlan, normalizeProjectUrl, siteHealthFromAudit } from '../src/product.js';
import type { LLM } from '../src/types.js';
import type { SeoAudit } from '../src/web.js';
import fs from 'node:fs';

const baseAudit: SeoAudit = {
  url: 'https://example.com/', title: 'A useful title with the right length for search', titleLength: 47,
  metaDescription: 'A clear and useful description long enough to explain this page to a prospective customer without padding.',
  h1: ['A useful service'], internalLinks: 0, externalLinks: 0, images: 1, missingAlt: 0,
  canonical: 'https://example.com/', robotsMeta: null, htmlLang: 'en',
  openGraph: { title: 'Acme', description: 'Useful service', image: 'https://example.com/image.jpg', url: 'https://example.com/' },
  twitterCard: { card: 'summary', title: 'Acme', description: 'Useful service', image: 'https://example.com/image.jpg' },
  hasJsonLd: true, jsonLdCount: 1, checkedInternalLinks: 0, brokenInternalLinks: [], hasSitemap: true, hasRobotsTxt: true, issues: [], warnings: [],
};

test('v0.4 deterministic product checks score health, normalize URLs, and flag quality', () => {
  assert.equal(siteHealthFromAudit(baseAudit).score, 100);
  assert.equal(normalizeProjectUrl('https://www.Example.com/?utm_source=x'), normalizeProjectUrl('http://example.com'));
  const quality = draftQuality('linkedin', `${'x'.repeat(1301)} In today's fast-paced world`);
  assert.equal(quality.violations.length, 1);
  assert.match(quality.cliches[0], /fast-paced/i);
});

test('v0.4 duplicate project URLs are blocked and can be merged explicitly', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject({ name: 'Acme', url: 'https://www.example.com/' });
    assert.throws(() => store.createProject({ name: 'Duplicate', url: 'http://example.com' }), /already exists/);
    const merged = store.mergeProject(project.id, { audience: 'Small teams', tone: 'Clear' });
    assert.equal(merged.audience, 'Small teams'); assert.equal(store.listProjects().length, 1);
  } finally { store.close(); }
});

test('v0.4 channel limits are enforced at approval and rejected drafts can be restored', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject({ name: 'Acme' });
    const draft = store.createDraft(project.id, 'linkedin', { channel: 'linkedin', title: 'Too long', body: 'x'.repeat(1301) });
    assert.throws(() => store.transitionDraft(draft.id, 'approved'), /channel limits/);
    store.updateDraft(draft.id, { body: 'Useful and concise.' });
    assert.equal(store.transitionDraft(draft.id, 'rejected').status, 'rejected');
    assert.equal(store.transitionDraft(draft.id, 'pending').status, 'pending');
  } finally { store.close(); }
});

test('v0.4 month planner always produces 30 varied pending-plan inputs', () => {
  const project = { id: 'p', name: 'Acme', url: '', description: '', audience: '', tone: '', language: 'es' as const, competitors: [], strategy: '# Plan', createdAt: '', updatedAt: '' };
  const plan = monthPlan(project, 'not-json', new Date('2026-10-20T08:00:00Z'));
  assert.equal(plan.length, 30); assert.equal(new Set(plan.map((item) => item.metadata.plannedAt)).size, 30);
  assert.deepEqual([...new Set(plan.slice(0, 4).map((item) => item.channel))], ['blog', 'linkedin', 'x', 'newsletter']);
});

test('v0.4 demo mode, Today dashboard, month generation, and deletion work without an LLM for demo', async () => {
  const store = new Store(':memory:'); const llm: LLM = { complete: async () => 'not-json' };
  const app = createApp({ store, llm, config: loadConfig({}) });
  try {
    let response = await app.request('/api/demo?language=es', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 201); const project = (await response.json()).project;
    assert.equal(project.isDemo, true); assert.equal(store.listDrafts(project.id).length, 5); assert.equal(store.listGeoHistory(project.id).length, 2);
    response = await app.request(`/api/projects/${project.id}/dashboard`); const dashboard = await response.json();
    assert.equal(dashboard.health.score, 78); assert.ok(dashboard.actions.length > 0);
    response = await app.request(`/api/projects/${project.id}/month-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 201); assert.equal((await response.json()).drafts.length, 30);
    assert.equal(store.listDrafts(project.id).every((draft) => draft.status === 'pending'), true);
    assert.equal((await app.request(`/api/projects/${project.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(store.listProjects().length, 0);
  } finally { store.close(); }
});

test('v0.4 onboarding creates health, strategy, knowledge, and five sourced drafts in one run', async () => {
  const html = `<!doctype html><html lang="en"><head><title>A useful title with the right length for search</title><meta name="description" content="A clear and useful description long enough to explain this page to a prospective customer without padding."><link rel="canonical" href="https://example.com/"><meta property="og:title" content="Acme"><meta property="og:description" content="Useful service"><meta property="og:image" content="https://example.com/image.jpg"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="Acme"><meta name="twitter:description" content="Useful service"><meta name="twitter:image" content="https://example.com/image.jpg"><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head><body><h1>A useful service</h1><img src="x" alt="Useful"><p>Acme helps small teams do useful work with less friction.</p></body></html>`;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml');
    if (url.endsWith('/sitemap.xml')) return new Response('<urlset></urlset>', { headers: { 'content-type': 'application/xml' } });
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  };
  const llm: LLM = { complete: async (system) => system.includes('JSON array') ? JSON.stringify(Array.from({ length: 5 }, (_, index) => ({ title: `Draft ${index + 1}`, body: `Useful draft ${index + 1}`, angle: 'Practical' }))) : '# Strategy\nA practical plan.' };
  const store = new Store(':memory:'); const app = createApp({ store, llm, fetcher, config: loadConfig({ ALLOW_PRIVATE_FETCH: '1' }) });
  try {
    const response = await app.request('/api/onboarding/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/', language: 'en', profile: { name: 'Acme', audience: 'Small teams', tone: 'Clear' } }) });
    assert.equal(response.status, 201); const data = await response.json();
    assert.equal(data.health.score, 100); assert.match(data.project.strategy, /Strategy/); assert.equal(data.drafts.length, 5);
    assert.equal(store.listKnowledgeDocuments(data.project.id).length, 1);
    assert.equal((store.listDrafts(data.project.id)[0].metadata.sources as unknown[]).length, 1);
  } finally { store.close(); }
});

test('v0.4 Today actions prioritize strategy, approvals, calendar gaps, and stale visibility', () => {
  const project = { id: 'p', name: 'Acme', url: '', description: '', audience: '', tone: '', language: 'en' as const, competitors: [], strategy: null, createdAt: '', updatedAt: '' };
  const actions = dashboardActions(project, [], [], 'en');
  assert.equal(actions[0].tab, 'strategy'); assert.equal(actions.length, 3);
});

test('v0.4 engine detection and simplified settings expose local model warnings and basic fields', async () => {
  const fetcher: typeof fetch = async (input) => String(input).endsWith('/api/tags')
    ? new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b', details: { parameter_size: '3.2B' } }, { name: 'qwen:9b', details: { parameter_size: '9B' } }] }), { headers: { 'content-type': 'application/json' } })
    : new Response('not found', { status: 404 });
  const store = new Store(':memory:'); const app = createApp({ store, fetcher, llm: { complete: async () => 'OK' }, config: loadConfig({}) });
  try {
    let response = await app.request('/api/engines/ollama'); const engines = await response.json();
    assert.equal(engines.available, true); assert.equal(engines.models[0].small, true); assert.equal(engines.models[1].small, false);
    response = await app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uiLanguage: 'es', markdownExportDir: '/tmp/exports' }) });
    assert.equal(response.status, 200);
    const settings = (await (await app.request('/api/settings')).json()).settings;
    assert.equal(settings.uiLanguage, 'es'); assert.equal(settings.markdownExportDir, '/tmp/exports');
  } finally { store.close(); }
});

test('v0.4 feedback regeneration replaces a draft while retaining its source metadata', async () => {
  const store = new Store(':memory:'); const app = createApp({ store, llm: { complete: async () => 'Specific, useful copy.' }, config: loadConfig({}) });
  try {
    const project = store.createProject({ name: 'Acme' });
    const draft = store.createDraft(project.id, 'writer', { channel: 'linkedin', title: 'Draft', body: "In today's fast-paced world, unlock your potential.", metadata: { sources: [{ label: 'K1', title: 'Brand guide' }] } });
    const response = await app.request(`/api/drafts/${draft.id}/regenerate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feedback: 'Use concrete language' }) });
    assert.equal(response.status, 200); const updated = (await response.json()).draft;
    assert.equal(updated.body, 'Specific, useful copy.'); assert.equal(updated.metadata.sources[0].label, 'K1'); assert.equal(updated.quality.cliches.length, 0);
  } finally { store.close(); }
});

test('v0.4 browser artifact includes every product-pass surface', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app-v04.js', import.meta.url), 'utf8');
  for (const marker of ['id="wizard"', 'data-tab="today"', 'id="generate-month"', 'id="shortcut-dialog"', 'class="advanced-settings"', 'data-demo']) assert.match(html, new RegExp(marker));
  for (const marker of ['/api/onboarding/run', '/api/projects/${state.current.id}/dashboard', '/month-plan', '/regenerate', '/undo-reject', "es: {"]) assert.ok(js.includes(marker), marker);
});
