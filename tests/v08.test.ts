import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeSteps, STEP_IDS, T, BANNED_IN_SIMPLE, ENGINE_COPY_KEYS, friendlyError, charStatus, formatDuration, translate, PROVIDERS, channelKey } from '../public/guided-core.js';

const base = { aiOk: false, project: null, understood: false, draftsWithBody: 0, approvedCount: 0, publishedOrScheduled: false, copied: false, monthPlanStarted: false, monthSkipped: false };

test('stepper always has exactly one current step and moves forward as facts appear', () => {
  let plan = computeSteps(base);
  assert.equal(plan.current, 'ai'); assert.equal(plan.doneCount, 0);
  plan = computeSteps({ ...base, aiOk: true });
  assert.equal(plan.current, 'business');
  plan = computeSteps({ ...base, aiOk: true, project: { id: 'p' } });
  assert.equal(plan.current, 'understood');
  plan = computeSteps({ ...base, aiOk: true, project: { id: 'p' }, understood: true });
  assert.equal(plan.current, 'posts');
  plan = computeSteps({ ...base, aiOk: true, project: { id: 'p' }, understood: true, draftsWithBody: 5 });
  assert.equal(plan.current, 'review');
  plan = computeSteps({ ...base, aiOk: true, project: { id: 'p' }, understood: true, draftsWithBody: 5, approvedCount: 1 });
  assert.equal(plan.current, 'publish');
  plan = computeSteps({ ...base, aiOk: true, project: { id: 'p' }, understood: true, draftsWithBody: 5, approvedCount: 1, copied: true });
  assert.equal(plan.current, 'month');
  plan = computeSteps({ ...base, aiOk: true, project: { id: 'p' }, understood: true, draftsWithBody: 5, approvedCount: 1, copied: true, monthSkipped: true });
  assert.equal(plan.current, null); assert.equal(plan.doneCount, plan.total);
  for (const facts of [base, { ...base, aiOk: true }, { ...base, aiOk: true, project: {} }]) assert.equal(computeSteps(facts).steps.filter((step) => step.status === 'current').length, 1);
});

test('stepper marks later steps done only when facts say so, and the month step is optional', () => {
  const plan = computeSteps({ ...base, aiOk: true, project: { id: 'p' }, understood: true, draftsWithBody: 2 });
  assert.deepEqual(plan.steps.map((step) => step.status), ['done', 'done', 'done', 'done', 'current', 'upcoming', 'upcoming']);
  assert.equal(plan.steps.find((step) => step.id === 'month')?.optional, true);
  assert.deepEqual(STEP_IDS, plan.steps.map((step) => step.id));
});

test('every Spanish key exists in English and vice versa, and every step has its full copy', () => {
  const es = Object.keys(T.es).sort(); const en = Object.keys(T.en).sort();
  assert.deepEqual(es, en);
  for (const id of STEP_IDS) for (const part of ['title', 'short', 'why', 'time', 'next']) assert.ok(T.es[`step.${id}.${part}`] && T.en[`step.${id}.${part}`], `missing step.${id}.${part}`);
  for (const key of es) for (const lang of ['es', 'en'] as const) {
    const placeholders = [...T[lang][key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const other = [...T[lang === 'es' ? 'en' : 'es'][key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders, other, `placeholder mismatch in ${key}`);
  }
});

test('simple mode copy contains no technical jargon outside the AI-engine setup help', () => {
  for (const lang of ['es', 'en'] as const) for (const [key, value] of Object.entries(T[lang])) {
    if (ENGINE_COPY_KEYS.has(key)) continue;
    for (const word of BANNED_IN_SIMPLE) assert.equal(new RegExp(`\\b${word}\\b`, 'i').test(value), false, `${lang}:${key} contains jargon "${word}"`);
  }
});

test('friendly errors explain the problem in plain words and keep technical details separate', () => {
  const timeout = friendlyError(new Error('LLM request failed: The operation was aborted due to timeout.'), 'es');
  assert.match(timeout.message, /tardando más/); assert.match(timeout.details, /timeout/); assert.equal(timeout.fix, 'retry');
  assert.equal(friendlyError('connect ECONNREFUSED 127.0.0.1:11434', 'en').fix, 'ai');
  assert.equal(friendlyError(new Error('LLM returned 401: invalid api key'), 'es').fix, 'ai');
  assert.match(friendlyError(new Error('url is required'), 'es').message, /dirección de tu web/);
  const unknown = friendlyError(new Error('weird'), 'es'); assert.equal(unknown.fix, 'retry');
  for (const text of [timeout.message, unknown.message]) assert.doesNotMatch(text, /HTTP|\d{3}|stack|LLM/);
});

test('character counter speaks plain language and duration is human', () => {
  assert.equal(charStatus(100, 280, 'es').ok, true); assert.match(charStatus(292, 280, 'es').text, /12 caracteres/);
  assert.equal(charStatus(5, null, 'es').text, '');
  assert.match(formatDuration(30, 'es'), /menos de 1 minuto/); assert.match(formatDuration(1300, 'en'), /minutes/); assert.match(formatDuration(8000, 'es'), /horas/);
  assert.equal(translate('es', 'plan.done', { done: 2, total: 7 }), '2 de 7 listos');
  assert.equal(channelKey('linkedin'), 'linkedin'); assert.equal(channelKey('meta-description'), 'other');
});

test('online AI providers all have beginner instructions and valid endpoints', () => {
  for (const provider of Object.values(PROVIDERS)) { assert.match(provider.baseUrl, /^https:\/\//); assert.ok(provider.site && provider.section && provider.prefix && provider.model); }
});

test('guided page is served at / and the full app at /advanced, and html/js reference each other correctly', async () => {
  const html = fs.readFileSync(new URL('../public/guided.html', import.meta.url), 'utf8'); const js = fs.readFileSync(new URL('../public/guided.js', import.meta.url), 'utf8');
  assert.match(html, /guided\.js/); assert.match(html, /href="\/advanced"/); assert.match(js, /\/api\/onboarding\/profile/); assert.match(js, /esc\(/);
  const { createApp } = await import('../src/app.js'); const { loadConfig } = await import('../src/config.js'); const { Store } = await import('../src/db.js');
  const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencmo-v08-'));
  const config = loadConfig({ DATA_DIR: dir, MARKDOWN_EXPORT_DIR: path.join(dir, 'exports'), LLM_BASE_URL: 'http://127.0.0.1:9/v1' });
  const app = createApp({ config, store: new Store(path.join(dir, 'x.sqlite')) });
  const root = await app.request('/'); const advanced = await app.request('/advanced');
  assert.equal(root.status, 200); assert.match(await root.text(), /Tu plan de marketing/);
  assert.equal(advanced.status, 200); assert.match(await advanced.text(), /Marketing workspace/);
});

test('projects can be corrected by the user after onboarding', async () => {
  const { createApp } = await import('../src/app.js'); const { loadConfig } = await import('../src/config.js'); const { Store } = await import('../src/db.js');
  const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencmo-v08b-'));
  const app = createApp({ config: loadConfig({ DATA_DIR: dir, MARKDOWN_EXPORT_DIR: path.join(dir, 'exports') }), store: new Store(path.join(dir, 'x.sqlite')) });
  const created = await (await app.request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tienda', url: 'https://tienda.example', language: 'es' }) })).json() as { project: { id: string } };
  const patched = await (await app.request(`/api/projects/${created.project.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Mi tienda', description: 'Vendo velas', audience: 'Regalos', tone: 'Cercano' }) })).json() as { project: { name: string; description: string; audience: string; tone: string; language: string } };
  assert.deepEqual([patched.project.name, patched.project.description, patched.project.audience, patched.project.tone, patched.project.language], ['Mi tienda', 'Vendo velas', 'Regalos', 'Cercano', 'es']);
});
