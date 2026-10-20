import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { AppError } from '../src/errors.js';

test('drafts cannot be published before approval', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject({ name: 'Test Co' });
    const draft = store.createDraft(project.id, 'writer', { channel: 'blog', title: 'Draft', body: 'Body' });
    assert.throws(() => store.transitionDraft(draft.id, 'published'), (error) => error instanceof AppError && error.status === 409);
    assert.equal(store.getDraft(draft.id).status, 'pending');
  } finally { store.close(); }
});

test('approval state machine supports approval, rejection, re-approval, and publication', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject({ name: 'Test Co' });
    const draft = store.createDraft(project.id, 'writer', { channel: 'blog', title: 'Draft', body: 'Body' });
    assert.equal(store.transitionDraft(draft.id, 'approved').status, 'approved');
    assert.equal(store.transitionDraft(draft.id, 'rejected').status, 'rejected');
    assert.equal(store.transitionDraft(draft.id, 'approved').status, 'approved');
    assert.equal(store.transitionDraft(draft.id, 'published').status, 'published');
    assert.throws(() => store.updateDraft(draft.id, { body: 'Changed' }), AppError);
  } finally { store.close(); }
});
