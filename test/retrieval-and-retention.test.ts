import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ExperienceImport, KnowledgeEntry } from '../src/domain/types.js';
import { ExperienceStore, type RetrievalFilter } from '../src/storage/experience-store.js';

function fixture(): ExperienceImport & { knowledgeMetadata: NonNullable<ExperienceImport['knowledgeMetadata']> } {
  return {
    sessions: [
      { id: 'session-repo-a' as ExperienceImport['sessions'][number]['id'], source: 'codex', startedAt: '2026-08-20T10:00:00.000Z', repositoryId: 'repo-a' as ExperienceImport['sessions'][number]['repositoryId'] },
      { id: 'session-repo-b' as ExperienceImport['sessions'][number]['id'], source: 'codex', startedAt: '2026-08-20T10:00:00.000Z', repositoryId: 'repo-b' as ExperienceImport['sessions'][number]['repositoryId'] }
    ],
    events: [
      { id: 'event-old' as ExperienceImport['events'][number]['id'], sessionId: 'session-repo-a' as ExperienceImport['sessions'][number]['id'], kind: 'file-edit', occurredAt: '2026-08-20T10:00:00.000Z', path: 'src/a.ts', tool: 'git' },
      { id: 'event-new' as ExperienceImport['events'][number]['id'], sessionId: 'session-repo-a' as ExperienceImport['sessions'][number]['id'], kind: 'file-edit', occurredAt: '2026-08-21T10:00:00.000Z', path: 'src/a.ts', tool: 'git' },
      { id: 'event-other-repo' as ExperienceImport['events'][number]['id'], sessionId: 'session-repo-b' as ExperienceImport['sessions'][number]['id'], kind: 'file-edit', occurredAt: '2026-08-22T10:00:00.000Z', path: 'src/a.ts', tool: 'git' },
      { id: 'event-disputed' as ExperienceImport['events'][number]['id'], sessionId: 'session-repo-a' as ExperienceImport['sessions'][number]['id'], kind: 'test-result', occurredAt: '2026-08-23T10:00:00.000Z' }
    ],
    observations: [
      { id: 'observation-old' as ExperienceImport['observations'][number]['id'], eventIds: ['event-old' as ExperienceImport['events'][number]['id']], statement: 'Old exact observation.' },
      { id: 'observation-new' as ExperienceImport['observations'][number]['id'], eventIds: ['event-new' as ExperienceImport['events'][number]['id']], statement: 'New exact observation.' },
      { id: 'observation-other-repo' as ExperienceImport['observations'][number]['id'], eventIds: ['event-other-repo' as ExperienceImport['events'][number]['id']], statement: 'Other repository observation.' },
      { id: 'observation-disputed' as ExperienceImport['observations'][number]['id'], eventIds: ['event-disputed' as ExperienceImport['events'][number]['id']], statement: 'Disputed observation.' }
    ],
    clusters: [
      { id: 'cluster-old' as ExperienceImport['clusters'][number]['id'], observationIds: ['observation-old' as ExperienceImport['observations'][number]['id']] },
      { id: 'cluster-new' as ExperienceImport['clusters'][number]['id'], observationIds: ['observation-new' as ExperienceImport['observations'][number]['id']] },
      { id: 'cluster-other-repo' as ExperienceImport['clusters'][number]['id'], observationIds: ['observation-other-repo' as ExperienceImport['observations'][number]['id']] },
      { id: 'cluster-disputed' as ExperienceImport['clusters'][number]['id'], observationIds: ['observation-disputed' as ExperienceImport['observations'][number]['id']] }
    ],
    candidates: [
      { id: 'candidate-old' as ExperienceImport['candidates'][number]['id'], clusterId: 'cluster-old' as ExperienceImport['clusters'][number]['id'], kind: 'convention', statement: 'Old convention.' },
      { id: 'candidate-new' as ExperienceImport['candidates'][number]['id'], clusterId: 'cluster-new' as ExperienceImport['clusters'][number]['id'], kind: 'convention', statement: 'New convention.' },
      { id: 'candidate-other-repo' as ExperienceImport['candidates'][number]['id'], clusterId: 'cluster-other-repo' as ExperienceImport['clusters'][number]['id'], kind: 'convention', statement: 'Other convention.' },
      { id: 'candidate-disputed' as ExperienceImport['candidates'][number]['id'], clusterId: 'cluster-disputed' as ExperienceImport['clusters'][number]['id'], kind: 'failure', statement: 'Disputed failure.' }
    ],
    evidence: [
      { id: 'evidence-old' as ExperienceImport['evidence'][number]['id'], candidateId: 'candidate-old' as ExperienceImport['candidates'][number]['id'], polarity: 'confirms', summary: 'Old evidence.' },
      { id: 'evidence-new' as ExperienceImport['evidence'][number]['id'], candidateId: 'candidate-new' as ExperienceImport['candidates'][number]['id'], polarity: 'confirms', summary: 'New evidence.' },
      { id: 'evidence-other-repo' as ExperienceImport['evidence'][number]['id'], candidateId: 'candidate-other-repo' as ExperienceImport['candidates'][number]['id'], polarity: 'confirms', summary: 'Other evidence.' },
      { id: 'evidence-disputed' as ExperienceImport['evidence'][number]['id'], candidateId: 'candidate-disputed' as ExperienceImport['candidates'][number]['id'], polarity: 'contradicts', summary: 'Disputed evidence.' }
    ],
    knowledge: [
      { id: 'knowledge-old' as KnowledgeEntry['id'], candidateId: 'candidate-old' as ExperienceImport['candidates'][number]['id'], evidenceIds: ['evidence-old' as ExperienceImport['evidence'][number]['id']], state: 'verified', statement: 'Old convention.' },
      { id: 'knowledge-new' as KnowledgeEntry['id'], candidateId: 'candidate-new' as ExperienceImport['candidates'][number]['id'], evidenceIds: ['evidence-new' as ExperienceImport['evidence'][number]['id']], state: 'verified', statement: 'New convention.' },
      { id: 'knowledge-other-repo' as KnowledgeEntry['id'], candidateId: 'candidate-other-repo' as ExperienceImport['candidates'][number]['id'], evidenceIds: ['evidence-other-repo' as ExperienceImport['evidence'][number]['id']], state: 'verified', statement: 'Other convention.' },
      { id: 'knowledge-disputed' as KnowledgeEntry['id'], candidateId: 'candidate-disputed' as ExperienceImport['candidates'][number]['id'], evidenceIds: ['evidence-disputed' as ExperienceImport['evidence'][number]['id']], state: 'disputed', statement: 'Disputed failure.' }
    ],
    knowledgeMetadata: {
      'knowledge-old': { path: 'src/a.ts', tool: 'git', tags: ['safety'], createdAt: '2026-08-20T10:00:00.000Z', activation: 'merged-team-active', mergedProvenance: 'repo-a:merge-old' },
      'knowledge-new': { path: 'src/a.ts', tool: 'git', tags: ['safety'], createdAt: '2026-08-21T10:00:00.000Z', activation: 'merged-team-active', mergedProvenance: 'repo-a:merge-new' },
      'knowledge-other-repo': { path: 'src/a.ts', tool: 'git', tags: ['safety'], createdAt: '2026-08-22T10:00:00.000Z', activation: 'merged-team-active', mergedProvenance: 'repo-b:merge-other' },
      'knowledge-disputed': { path: 'src/disputed.ts', tool: 'node', tags: ['retention'], createdAt: '2026-08-23T10:00:00.000Z', activation: 'merged-team-active', mergedProvenance: 'repo-a:merge-disputed' }
    }
  };
}

function createStore(): ExperienceStore {
  return new ExperienceStore(join(mkdtempSync(join(tmpdir(), 'ael-retrieval-')), 'experience.sqlite'));
}

test('orders exact retrieval by matched filters, recency, then identifier', () => {
  const store = createStore();
  store.import(fixture());
  const filter: RetrievalFilter = { scope: 'repository', repositoryId: 'repo-a', path: './src/a.ts', tool: 'git', tags: ['safety'] };

  assert.deepEqual(store.retrieve(filter).map(({ id }) => id), ['knowledge-new', 'knowledge-old']);
  store.close();
});

test('does not return cross-repository knowledge', () => {
  const store = createStore();
  store.import(fixture());

  assert.deepEqual(store.retrieve({ scope: 'repository', repositoryId: 'repo-a' }).map(({ id }) => id), ['knowledge-disputed', 'knowledge-new', 'knowledge-old']);
  store.close();
});

test('does not expire an observation referenced by disputed knowledge', () => {
  const store = createStore();
  store.import(fixture());

  assert.equal(store.expireUnprotected('2030-01-01T00:00:00.000Z'), 0);
  store.close();
});

test('does not return unapproved global knowledge as authoritative', () => {
  const store = createStore();
  const record = fixture();
  for (const id of ['knowledge-old', 'knowledge-new', 'knowledge-disputed']) {
    record.knowledgeMetadata[id] = { ...record.knowledgeMetadata[id], activation: 'local', mergedProvenance: undefined };
  }
  record.knowledgeMetadata['knowledge-new'] = { tags: ['safety'], createdAt: '2026-08-21T10:00:00.000Z' };
  record.sessions[0] = { ...record.sessions[0], repositoryId: undefined };
  store.import(record);

  const entry = store.retrieve({ scope: 'global' }).find(({ id }) => id === 'knowledge-new');
  assert.equal(entry?.authoritative, false);
  store.close();
});

test('rejects repository team activation without matching merged provenance', () => {
  const store = createStore();
  const record = fixture();
  record.knowledgeMetadata['knowledge-new'] = {
    path: 'src/a.ts', tool: 'git', tags: ['safety'],
    createdAt: '2026-08-21T10:00:00.000Z', activation: 'merged-team-active'
  };
  assert.throws(() => store.import(record), /INVALID_METADATA/);
  assert.deepEqual(store.listKnowledge(), []);
  store.close();
});

test('tombstones terminal knowledge observations without purging referenced records', () => {
  const store = createStore();
  const record = fixture();
  record.knowledge[0] = { ...record.knowledge[0], state: 'superseded' };
  store.import(record);

  assert.equal(store.expireUnprotected('2030-01-01T00:00:00.000Z'), 1);
  assert.equal(store.expireUnprotected('2030-01-02T00:00:00.000Z'), 2);
  assert.equal(store.expireUnprotected('2030-01-03T00:00:00.000Z'), 1);
  assert.equal(store.inspect('knowledge-old' as KnowledgeEntry['id'])?.statement, 'Old convention.');
  store.close();
});

test('rejects secret-bearing metadata atomically', () => {
  const store = createStore();
  const record = fixture();
  record.knowledgeMetadata['knowledge-new'] = {
    ...record.knowledgeMetadata['knowledge-new'],
    mergedProvenance: 'repo-a:bearer_token: secret-value'
  };

  assert.throws(() => store.import(record), /SENSITIVE_TEXT/);
  assert.deepEqual(store.listKnowledge(), []);
  store.close();
});

test('rejects malformed metadata fields atomically', () => {
  const store = createStore();
  const record = fixture();
  record.knowledgeMetadata['knowledge-new'] = {
    ...record.knowledgeMetadata['knowledge-new'],
    tags: [123] as unknown as string[],
    approvedAt: 'not-a-timestamp'
  };

  assert.throws(() => store.import(record), /INVALID_SHAPE/);
  assert.deepEqual(store.listKnowledge(), []);
  store.close();
});

test('rejects repository metadata that contradicts source provenance', () => {
  const store = createStore();
  const record = fixture();
  record.knowledgeMetadata['knowledge-new'] = {
    ...record.knowledgeMetadata['knowledge-new'],
    scope: 'global', repositoryId: 'repo-b' as ExperienceImport['sessions'][number]['repositoryId']
  };

  assert.throws(() => store.import(record), /INVALID_METADATA/);
  assert.deepEqual(store.listKnowledge(), []);
  store.close();
});

test('rejects durable repository knowledge with mixed repository source provenance', () => {
  const store = createStore();
  const record = fixture();
  record.clusters[1] = {
    ...record.clusters[1],
    observationIds: [
      'observation-new' as ExperienceImport['observations'][number]['id'],
      'observation-other-repo' as ExperienceImport['observations'][number]['id']
    ]
  };

  assert.throws(() => store.import(record), /INVALID_METADATA: Mixed repository provenance/);
  assert.deepEqual(store.listKnowledge(), []);
  store.close();
});

test('tombstones an unreferenced event before purging it on a later expiry', () => {
  const store = createStore();
  const record = fixture();
  record.events.push({
    id: 'event-unreferenced' as ExperienceImport['events'][number]['id'],
    sessionId: 'session-repo-a' as ExperienceImport['sessions'][number]['id'],
    kind: 'tool-result',
    occurredAt: '2026-08-24T00:00:00.000Z'
  });
  store.import(record);

  assert.equal(store.expireUnprotected('2030-01-01T00:00:00.000Z'), 1);
  assert.equal(store.expireUnprotected('2030-01-02T00:00:00.000Z'), 1);
  assert.equal(store.expireUnprotected('2030-01-03T00:00:00.000Z'), 0);
  store.close();
});
