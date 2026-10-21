import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';

test('analytics API summarizes SEO, GEO, content, and AI operations', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store, config: loadConfig({}) });
  try {
    const project = store.createProject({ name: 'Aulafy', url: 'https://aulafy.net', language: 'es' });
    store.addHealthHistory(project.id, 64, { issues: ['title', 'description'] });
    store.addHealthHistory(project.id, 82, { issues: [] });
    store.addGeoHistory(project.id, 1, 4, []);
    store.addGeoHistory(project.id, 3, 4, []);
    store.replaceSearchOpportunities(project.id, [{ query: 'curso ia', clicks: 4, impressions: 500, ctr: 0.008, position: 7, score: 20 }]);
    const draft = store.createDraft(project.id, 'writer', { channel: 'linkedin', title: 'Useful post', body: 'Useful body' });
    store.transitionDraft(draft.id, 'approved'); store.transitionDraft(draft.id, 'published');
    store.recordLlmCall({ purpose: 'analytics-test', model: 'stub', ms: 500, tokensIn: 100, tokensOut: 200, status: 'ok' });

    const response = await app.request(`/api/projects/${project.id}/analytics?days=7`);
    assert.equal(response.status, 200);
    const data = await response.json() as { rangeDays: number; summary: Record<string, number>; series: { health: unknown[]; geo: unknown[]; content: unknown[] }; distribution: { channels: Array<{ name: string; value: number }> }; operations: { calls24h: number } };
    assert.equal(data.rangeDays, 7);
    assert.deepEqual([data.summary.healthScore, data.summary.healthTrend, data.summary.geoScore, data.summary.geoTrend], [82, 18, 75, 50]);
    assert.deepEqual([data.summary.seoIssuesOpen, data.summary.opportunities, data.summary.published], [0, 1, 1]);
    assert.equal(data.series.health.length, 2); assert.equal(data.series.geo.length, 2); assert.equal(data.series.content.length, 7);
    assert.deepEqual(data.distribution.channels, [{ name: 'linkedin', value: 1 }]); assert.equal(data.operations.calls24h, 1);
  } finally { store.close(); }
});

test('Prometheus endpoint exports aggregates and escapes labels without private content', async () => {
  const store = new Store(':memory:'); const app = createApp({ store, config: loadConfig({}) });
  try {
    const project = store.createProject({ name: 'A "Brand"', description: 'private campaign body' });
    store.addHealthHistory(project.id, 91, { issues: [] }); store.addGeoHistory(project.id, 4, 5, []);
    const response = await app.request('/metrics'); const body = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type') || '', /text\/plain/);
    assert.match(body, /opencmo_site_health_score\{project_id="[^"]+",project="A \\"Brand\\""\} 91/);
    assert.match(body, /opencmo_ai_visibility_score.* 80/); assert.match(body, /opencmo_llm_calls_24h 0/);
    assert.doesNotMatch(body, /private campaign body|api.?key|prompt/i);
  } finally { store.close(); }
});

test('advanced UI and provisioned Grafana dashboard expose the analytics surfaces', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app-v04.js', import.meta.url), 'utf8');
  const dashboard = JSON.parse(fs.readFileSync(new URL('../observability/grafana/dashboards/opencmo-dashboard.json', import.meta.url), 'utf8')) as { uid: string; refresh: string; panels: Array<{ type: string; targets?: Array<{ expr?: string }> }> };
  for (const marker of ['data-nav-tab="analytics"', 'id="analytics-dashboard"', 'id="analytics-range"', 'href="/metrics"']) assert.ok(html.includes(marker), marker);
  for (const marker of ['/analytics?days=', 'renderTrendChart', 'renderContentBars', 'Operación de IA']) assert.ok(js.includes(marker), marker);
  assert.equal(dashboard.uid, 'opencmo-marketing'); assert.equal(dashboard.refresh, '30s'); assert.ok(dashboard.panels.length >= 8);
  assert.ok(dashboard.panels.flatMap((panel) => panel.targets || []).some((target) => target.expr?.includes('opencmo_ai_visibility_score')));
});
