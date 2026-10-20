import test from 'node:test';
import assert from 'node:assert/strict';
import type { LLM } from '../src/types.js';
import { runAgent } from '../src/agents.js';

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
