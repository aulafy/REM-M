import test from 'node:test';
import assert from 'node:assert/strict';
import type { LLM } from '../src/types.js';
import { runAgent } from '../src/agents.js';
import { loadConfig } from '../src/config.js';
import { OpenAICompatibleLLM } from '../src/llm.js';

class StubLLM implements LLM {
  calls: Array<{ system: string; user: string }> = [];
  constructor(private answer = '# A focused article\n\nUseful body.') {}
  async complete(system: string, user: string): Promise<string> {
    this.calls.push({ system, user });
    return this.answer;
  }
}

test('writer agent works with an injected LLM stub', async () => {
  const llm = new StubLLM();
  const project = { id: 'p1', name: 'Acme', url: 'https://example.com', description: 'Tools', audience: 'Teams', tone: 'Direct', strategy: 'Focus on trust.', createdAt: '', updatedAt: '' };
  const drafts = await runAgent('writer', project, 'analytics for small teams', llm);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].channel, 'blog');
  assert.equal(drafts[0].title, 'A focused article');
  assert.match(llm.calls[0].user, /analytics for small teams/);
  assert.match(llm.calls[0].user, /Focus on trust/);
});

test('social agents return reviewable drafts through the same LLM boundary', async () => {
  const llm = new StubLLM('A concise social post.');
  const project = { id: 'p1', name: 'Acme', url: '', description: '', audience: '', tone: '', strategy: null, createdAt: '', updatedAt: '' };
  const [draft] = await runAgent('x', project, 'launch update', llm);
  assert.equal(draft.channel, 'x');
  assert.equal(draft.body, 'A concise social post.');
  assert.equal(llm.calls.length, 1);
});

test('LLM timeout defaults to five minutes and accepts LLM_TIMEOUT_MS', () => {
  assert.equal(loadConfig({}).llmTimeoutMs, 300_000);
  assert.equal(loadConfig({ LLM_TIMEOUT_MS: '45000' }).llmTimeoutMs, 45_000);
  assert.throws(() => loadConfig({ LLM_TIMEOUT_MS: 'nope' }), /positive integer/);
});

test('OpenAI-compatible LLM uses its configured request timeout', async () => {
  const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
  const llm = new OpenAICompatibleLLM('https://llm.example/v1', 'key', 'model', fetcher, 5);
  await assert.rejects(() => llm.complete('System', 'User'), /LLM request failed/);
});

test('SEO agent constrains recommendations to deterministic evidence', async () => {
  const llm = new StubLLM('1. Evidence-backed fix.');
  const project = { id: 'p1', name: 'Acme', url: 'https://example.com', description: '', audience: '', tone: '', strategy: null, createdAt: '', updatedAt: '' };
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    if (String(input).endsWith('/robots.txt') || String(input).endsWith('/sitemap.xml')) return new Response('', { status: 200 });
    return new Response('<html><head><title>A perfectly acceptable title with fifty characters</title></head><body><h1>Home</h1></body></html>', { status: 200 });
  };
  await runAgent('seo', project, 'https://example.com', llm, fetcher, { allowPrivateFetch: true });
  assert.match(llm.calls[0].system, /deterministic audit is authoritative/i);
  assert.match(llm.calls[0].system, /at most 6/i);
  assert.match(llm.calls[0].system, /evidence for every recommendation/i);
  assert.match(llm.calls[0].user, /Do not recommend changing checks that passed/);
});
