import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { buildClientReport, competitorMetric, findSearchOpportunities, parseGscQueriesCsv, whereCompetitorsBeatYou } from '../src/v05.js';
import type { SeoAudit } from '../src/web.js';

const audit = (overrides: Partial<SeoAudit> = {}): SeoAudit => ({
  url: 'https://example.com/', title: 'A useful search title for a small business today', titleLength: 48,
  metaDescription: 'A useful page description that gives prospective customers enough clear context to decide whether to visit.',
  h1: ['Useful service'], internalLinks: 0, externalLinks: 0, images: 0, missingAlt: 0, canonical: 'https://example.com/', robotsMeta: null, htmlLang: 'en',
  openGraph: { title: 'Title', description: 'Description', image: '/image.png', url: null }, twitterCard: { card: null, title: null, description: null, image: null },
  hasJsonLd: true, jsonLdCount: 1, checkedInternalLinks: 0, brokenInternalLinks: [], hasSitemap: true, hasRobotsTxt: true, issues: [], warnings: [], htmlBytes: 20_000, ...overrides,
});

test('v0.5 parses English and Spanish GSC CSV and ranks realistic opportunities', () => {
  const en = parseGscQueriesCsv('Query,Clicks,Impressions,CTR,Position\n"local marketing",5,1000,0.5%,12\nbrand,50,100,50%,1');
  const es = parseGscQueriesCsv('Consulta,Clics,Impresiones,CTR,Posición\n"marketing local",3,900,"1,5%","18,2"');
  assert.equal(en[0].ctr, 0.005); assert.equal(es[0].position, 18.2);
  const opportunities = findSearchOpportunities([...en, ...es]);
  assert.deepEqual(opportunities.map((item) => item.query), ['local marketing', 'marketing local']);
  assert.throws(() => parseGscQueriesCsv('Name,Views\na,1'), /must include/);
});

test('v0.5 competitor metrics are deterministic and explain advantages', () => {
  const yours = competitorMetric(audit({ title: null, titleLength: 0, hasJsonLd: false, jsonLdCount: 0, htmlBytes: 100_000 }));
  const theirs = competitorMetric(audit({ url: 'https://competitor.example/', htmlBytes: 40_000 }));
  const result = whereCompetitorsBeatYou(yours, [theirs]);
  assert.equal(yours.title, 'missing'); assert.deepEqual(result[0].advantages, ['title', 'structured data', 'lighter HTML']);
});

test('v0.5 report is standalone, branded only when requested, and includes all client sections', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject({ name: '<Acme>', language: 'en' });
    const health = store.addHealthHistory(project.id, 72, { issues: ['Missing meta description'] });
    const geo = store.addGeoHistory(project.id, 2, 5, []);
    const draft = store.createDraft(project.id, 'planner', { channel: 'blog', title: 'Plan item', body: 'Body', metadata: { plannedAt: '2026-11-01T09:00:00Z' } });
    const report = buildClientReport({ project, health, geo, drafts: [draft], opportunities: [], branding: { brandingAgencyName: 'North Agency', brandingAccentColor: '#123456' }, generatedAt: new Date('2026-10-20T00:00:00Z') });
    assert.match(report, /<!doctype html>/); assert.match(report, /North Agency/); assert.match(report, /Executive summary/); assert.match(report, /Website health/); assert.match(report, /AI visibility/); assert.match(report, /30-day plan/); assert.match(report, /Next steps/); assert.doesNotMatch(report, /Powered by OpenCMO/); assert.match(report, /&lt;Acme&gt;/); assert.doesNotMatch(report, /<link|<script/i);
    const powered = buildClientReport({ project, health, geo, drafts: [], opportunities: [], branding: { brandingPoweredBy: '1' } });
    assert.match(powered, /Powered by OpenCMO/);
  } finally { store.close(); }
});

test('v0.5 API filters embedding models, fixes demo sources, imports GSC, drafts, reports, and summarizes projects', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [
      { name: 'nomic-embed-text:latest', details: { parameter_size: '137M' } }, { name: 'bge-m3:latest', details: { parameter_size: '567M' } },
      { name: 'llama3.2:3b', details: { parameter_size: '3.2B' } }, { name: 'qwen:9b', details: { parameter_size: '9B' } },
    ] }), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\nSitemap: http://own.test/sitemap.xml');
    if (url.endsWith('/sitemap.xml')) return new Response('<urlset></urlset>');
    if (init?.method === 'HEAD') return new Response('', { status: 200 });
    const competitor = url.includes('competitor');
    return new Response(`<!doctype html><html lang="en"><head><title>${competitor ? 'A competitor title that is useful in search results' : 'Own'}</title>${competitor ? '<meta name="description" content="A useful and complete description for prospective customers that explains this competitor page clearly."><meta property="og:title" content="C"><meta property="og:description" content="D"><meta property="og:image" content="I"><script type="application/ld+json">{"@type":"Organization"}</script>' : ''}</head><body><h1>Service</h1></body></html>`);
  };
  const store = new Store(':memory:'); const app = createApp({ store, fetcher, llm: { complete: async () => '# Useful article\n\nSpecific advice.' }, config: loadConfig({ ALLOW_PRIVATE_FETCH: '1' }) });
  try {
    let response = await app.request('/api/engines/ollama'); const engines = await response.json();
    assert.deepEqual(engines.models.map((item: { name: string }) => item.name), ['llama3.2:3b', 'qwen:9b']); assert.equal(engines.models[0].small, true);
    response = await app.request('/api/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const demo = (await response.json()).project;
    assert.equal((store.listDrafts(demo.id)[0].metadata.sources as unknown[]).length, 1);
    const project = store.createProject({ name: 'Client', url: 'http://own.test/', competitors: ['http://competitor.test/'] });
    response = await app.request(`/api/projects/${project.id}/search-console`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv: 'Query,Clicks,Impressions,CTR,Position\nuseful query,2,1000,1%,14' }) });
    const imported = await response.json(); assert.equal(response.status, 201); assert.equal(imported.opportunities.length, 1);
    response = await app.request(`/api/projects/${project.id}/search-console/${imported.opportunities[0].id}/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 201); assert.match((await response.json()).drafts[0].body, /Useful article/);
    response = await app.request(`/api/projects/${project.id}/competitors/audit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: ['http://competitor.test/'] }) });
    const comparison = await response.json(); assert.equal(response.status, 200); assert.equal(comparison.comparison.length, 2); assert.ok(comparison.whereTheyBeatYou[0].advantages.length);
    response = await app.request(`/api/projects/${project.id}/report`); assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8'); assert.match(await response.text(), /Client/);
    const overview = await (await app.request('/api/overview')).json(); assert.equal(overview.projects.length, 2); assert.ok(overview.projects.every((item: { pending: number }) => typeof item.pending === 'number'));
  } finally { store.close(); }
});

test('v0.5 browser, packaging, landing pages, and launch artifacts are present', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'); const js = fs.readFileSync(new URL('../public/app-v04.js', import.meta.url), 'utf8');
  for (const marker of ['id="export-report"', 'id="gsc-file"', 'id="competitor-form"', 'id="agency-overview"', 'class="card trust-intro"', 'name="brandingAgencyName"']) assert.ok(html.includes(marker), marker);
  for (const marker of ['/search-console', '/competitors/audit', '/api/overview', '/report', 'small-badge']) assert.ok(js.includes(marker), marker);
  assert.ok(fs.statSync(new URL('../bin/opencmo.js', import.meta.url)).mode & 0o100); assert.ok(fs.statSync(new URL('../start.command', import.meta.url)).mode & 0o100);
  for (const file of ['../docs/index.html', '../docs/es/index.html', '../docs/LAUNCH.md']) assert.ok(fs.existsSync(new URL(file, import.meta.url)));
});
