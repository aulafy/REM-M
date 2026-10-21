import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { VISIBILITY_PROVIDERS, analyzeAnswer, askAssistant, extractCitations, fallbackQuestions, summarizeVisibility } from '../src/visibility.js';

test('visibility providers use live web search and expose useful setup metadata', () => {
  assert.deepEqual(VISIBILITY_PROVIDERS.map((provider) => provider.id), ['perplexity', 'openrouter', 'openai']);
  for (const provider of VISIBILITY_PROVIDERS) {
    assert.equal(provider.searches, true);
    assert.match(provider.baseUrl, /^https:\/\//);
    assert.ok(provider.model && provider.site && provider.section && provider.prefix);
  }
  assert.equal(VISIBILITY_PROVIDERS.find((provider) => provider.id === 'openrouter')?.webSearchTool, true);
});

test('visibility analysis recognizes a brand mention or citation without inventing either', () => {
  const project = { name: 'Aulafy', url: 'https://www.aulafy.net', competitors: ['Coursera', 'https://udemy.com'] };
  const cited = analyzeAnswer(project, 'Where can I learn?', { answer: 'Consider Coursera or Udemy.', citations: ['https://aulafy.net/course', 'https://example.com'] });
  assert.equal(cited.brandAppears, true); assert.equal(cited.mentioned, false); assert.equal(cited.domainCited, true); assert.deepEqual(cited.competitors, ['Coursera', 'udemy.com']);
  const mentioned = analyzeAnswer(project, 'What is Aulafy?', { answer: 'Aulafy offers practical courses.', citations: [] });
  assert.equal(mentioned.brandAppears, true); assert.equal(mentioned.mentioned, true); assert.equal(mentioned.domainCited, false);
  const absent = analyzeAnswer(project, 'Other options?', { answer: 'Try an independent teacher.', citations: ['https://example.org'] });
  assert.equal(absent.brandAppears, false);
});

test('citations, fallback buyer questions, and summaries are deterministic', () => {
  const citations = extractCitations({ citations: ['https://one.example/a', { url: 'https://two.example/b' }], search_results: [{ url: 'https://three.example/c' }], choices: [{ message: { annotations: [{ url_citation: { url: 'https://four.example/d' } }] } }] });
  assert.equal(citations.length, 4);
  const questions = fallbackQuestions({ name: 'Aulafy', description: 'cursos prácticos de IA', language: 'es' }, 3);
  assert.equal(questions.length, 3); assert.match(questions[0], /cursos prácticos/);
  const summary = summarizeVisibility([
    { question: 'a', answer: '', brandAppears: true, mentioned: true, domainCited: false, citedDomains: ['one.example'], competitors: ['Rival'] },
    { question: 'b', answer: '', brandAppears: false, mentioned: false, domainCited: false, citedDomains: ['one.example'], competitors: [] },
  ]);
  assert.equal(summary.percent, 50); assert.deepEqual(summary.topSources, [{ name: 'one.example', count: 2 }]);
});

test('assistant request enables OpenRouter web search and keeps returned citations', async () => {
  let sent: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A result [source](https://source.example/page).', annotations: [{ url_citation: { url: 'https://annotated.example/item' } }] } }] }), { headers: { 'content-type': 'application/json' } });
  };
  const result = await askAssistant(fetcher, { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', webSearchTool: true }, 'sk-test', 'Best option?', 'en');
  assert.deepEqual(sent.tools, [{ type: 'openrouter:web_search', parameters: { max_results: 5 } }]);
  assert.deepEqual(result.citations, ['https://annotated.example/item', 'https://source.example/page']);
});

test('live visibility API saves the provider key locally, measures answers, and stores history', async () => {
  const calls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: String((init?.headers as Record<string, string>)?.authorization || ''), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const messages = calls.at(-1)?.body.messages as Array<{ content: string }> | undefined;
    const question = String(messages?.at(-1)?.content || '');
    return new Response(JSON.stringify({ citations: ['https://aulafy.net/useful'], choices: [{ message: { content: `Aulafy is relevant to: ${question}` } }] }), { headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(':memory:'); const app = createApp({ store, fetcher, config: loadConfig({}), llm: { complete: async () => 'unused' } });
  try {
    const project = store.createProject({ name: 'Aulafy', url: 'https://aulafy.net', language: 'es' });
    const providers = await (await app.request('/api/visibility/providers')).json() as { providers: unknown[]; keySaved: boolean };
    assert.equal(providers.providers.length, 3); assert.equal(providers.keySaved, false); assert.doesNotMatch(JSON.stringify(providers), /secret-key/);

    let response = await app.request(`/api/projects/${project.id}/ai-visibility`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'perplexity', apiKey: 'pplx-secret-key', questions: ['¿Dónde aprendo IA?', '¿Qué cursos recomiendas?'] }) });
    assert.equal(response.status, 200); const payload = await response.json() as { result: { percent: number; visible: number; total: number; checks: unknown[] } };
    assert.deepEqual([payload.result.percent, payload.result.visible, payload.result.total], [100, 2, 2]); assert.equal(payload.result.checks.length, 2);
    assert.equal(store.getSettings().visibilityKey, 'pplx-secret-key'); assert.equal(store.listGeoHistory(project.id).length, 1);
    assert.ok(calls.every((call) => call.authorization === 'Bearer pplx-secret-key'));

    response = await app.request(`/api/projects/${project.id}/ai-visibility`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'perplexity', questions: ['¿Otra pregunta?'] }) });
    assert.equal(response.status, 200);
    response = await app.request(`/api/projects/${project.id}/ai-visibility`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', questions: ['Question'] }) });
    assert.equal(response.status, 400); assert.match((await response.json() as { error: string }).error, /API key/);
  } finally { store.close(); }
});

test('advanced browser includes the live visibility setup, evidence view, and bilingual copy', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app-v04.js', import.meta.url), 'utf8');
  for (const marker of ['id="live-visibility"', 'id="visibility-provider"', 'id="visibility-key"', 'id="visibility-results"']) assert.ok(html.includes(marker), marker);
  for (const marker of ['/ai-visibility', 'renderVisibilityResult', '¿Los asistentes de IA recomiendan tu marca?']) assert.ok(js.includes(marker), marker);
});
