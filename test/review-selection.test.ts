import assert from 'node:assert/strict';
import test from 'node:test';

import { selectRepositorySession, type RepositoryScopedSessionDescriptor, type ReviewSelectionPrompt } from '../src/review/selection.js';

const sessions: readonly RepositoryScopedSessionDescriptor[] = [
  { id: 'other', repositoryIdentity: '/repo-other', repositoryHintVerified: true, updatedAt: '2026-08-24T12:00:00.000Z' },
  { id: 'old', repositoryIdentity: '/repo-current', repositoryHintVerified: true, updatedAt: '2026-08-24T10:00:00.000Z' },
  { id: 'new', repositoryIdentity: '/repo-current', repositoryHintVerified: true, updatedAt: '2026-08-24T11:00:00.000Z' },
  { id: 'unverified', repositoryIdentity: '/repo-current', updatedAt: '2026-08-24T13:00:00.000Z' }
];

test('uses an injected prompt to choose and confirm only verified repository-scoped sessions', async () => {
  const calls: string[] = [];
  const prompt: ReviewSelectionPrompt = {
    async choose(options) { calls.push(options.map(({ id }) => id).join(',')); return 'old'; },
    async confirm(session) { calls.push(`confirm:${session.id}`); return true; }
  };

  assert.equal(await selectRepositorySession(sessions, { interactive: true, repositoryIdentity: '/repo-current' }, prompt), 'old');
  assert.deepEqual(calls, ['old,new', 'confirm:old']);
});

test('selects and confirms the latest verified session only within the interactive repository scope', async () => {
  const confirmed: string[] = [];
  const prompt: ReviewSelectionPrompt = { async choose() { return undefined; }, async confirm(session) { confirmed.push(session.id); return true; } };

  assert.equal(await selectRepositorySession(sessions, { session: 'latest', interactive: true, repositoryIdentity: '/repo-current' }, prompt), 'new');
  assert.deepEqual(confirmed, ['new']);
  await assert.rejects(selectRepositorySession(sessions, { session: 'latest', interactive: false, repositoryIdentity: '/repo-current' }, prompt), /Interactive repository scope/);
  await assert.rejects(selectRepositorySession(sessions, { session: 'latest', interactive: true }, prompt), /Interactive repository scope/);
});
