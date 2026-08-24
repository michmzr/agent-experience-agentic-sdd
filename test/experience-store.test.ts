import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ExperienceImport, EventId, KnowledgeEntry } from '../src/domain/types.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

function validImport(): ExperienceImport {
  return {
    sessions: [{ id: 'session-1' as ExperienceImport['sessions'][number]['id'], source: 'codex', startedAt: '2026-08-24T10:00:00.000Z' }],
    events: [{ id: 'event-1' as EventId, sessionId: 'session-1' as ExperienceImport['sessions'][number]['id'], kind: 'test-result', occurredAt: '2026-08-24T10:01:00.000Z', outcome: 'passed' }],
    observations: [{ id: 'observation-1' as ExperienceImport['observations'][number]['id'], eventIds: ['event-1' as EventId], statement: 'The focused test passed.' }],
    clusters: [{ id: 'cluster-1' as ExperienceImport['clusters'][number]['id'], observationIds: ['observation-1' as ExperienceImport['observations'][number]['id']] }],
    candidates: [{ id: 'candidate-1' as ExperienceImport['candidates'][number]['id'], clusterId: 'cluster-1' as ExperienceImport['clusters'][number]['id'], kind: 'successful-workflow', statement: 'Run focused tests before a full check.' }],
    evidence: [{ id: 'evidence-1' as ExperienceImport['evidence'][number]['id'], candidateId: 'candidate-1' as ExperienceImport['candidates'][number]['id'], polarity: 'confirms', summary: 'Focused test passed.' }],
    knowledge: [{ id: 'knowledge-1' as KnowledgeEntry['id'], candidateId: 'candidate-1' as ExperienceImport['candidates'][number]['id'], evidenceIds: ['evidence-1' as ExperienceImport['evidence'][number]['id']], state: 'verified', statement: 'Run focused tests before a full check.' }]
  };
}

test('persists a valid import and reopens it for knowledge inspection', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-')), 'experience.sqlite');
  const record = validImport();
  const store = new ExperienceStore(databasePath);

  store.import(record);
  store.close();

  const reopened = new ExperienceStore(databasePath);
  assert.deepEqual(reopened.inspect('knowledge-1' as KnowledgeEntry['id']), record.knowledge[0]);
  assert.deepEqual(reopened.listKnowledge(), record.knowledge);
  reopened.close();
});

test('creates a local SQLite database file with owner-only permissions', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);

  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  store.close();
});

test('rejects an invalid import before it can mutate stored knowledge', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-')), 'experience.sqlite');
  const record = validImport();
  record.observations[0].eventIds = ['event-missing' as EventId];
  const store = new ExperienceStore(databasePath);

  assert.throws(() => store.import(record), /Event references a missing session|Observation references a missing event/);
  assert.deepEqual(store.listKnowledge(), []);
  store.close();
});
