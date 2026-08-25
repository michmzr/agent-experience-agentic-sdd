import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { NORMAL_PROFILE } from '../src/config/runtime-profile.js';
import type { RuntimeInput, RuntimeRule } from '../src/runtime/contracts.js';
import { createRuntimeGate } from '../src/runtime/gate.js';
import {
  applyRuntimeOverride,
  createRuntimeOverride,
  deriveOverrideLearningEvidence,
  type OverrideAuditEntry
} from '../src/runtime/override.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { compileRuntimeSnapshot } from '../src/runtime/snapshot.js';
import { openExperienceDatabase } from '../src/storage/database.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { overrideAuditMigration, OverrideStore } from '../src/storage/override-store.js';

const now = '2026-08-25T10:00:00.000Z';
const action: RuntimeInput = {
  repositoryId: 'repo-1', operationClass: 'protected',
  signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--force'], path: '/workspace/repo' }
};
const rules: RuntimeRule[] = ['rule-a', 'rule-b'].map((id) => ({
  id, state: 'verified', authoritative: true, effect: 'conflict',
  signature: action.signature.kind === 'action'
    ? { ...action.signature, arguments: [...(action.signature.arguments ?? [])] }
    : { ...action.signature },
  applicability: { scope: 'repository', repositoryId: 'repo-1' },
  reference: { knowledgeId: `knowledge-${id}`, evidenceIds: [`evidence-${id}`] }
}));
const index = createRuleIndex(compileRuntimeSnapshot({ repositoryId: 'repo-1', generatedAt: now, repositoryRules: rules }));
const decision = createRuntimeGate({
  index, profile: NORMAL_PROFILE,
  status: { health: 'healthy', profileId: 'normal', hardBlocking: true, retrievalMode: 'deterministic', fallbackSource: 'memory', circuitState: 'closed' }
}).evaluate(action);

test('requires a non-empty sanitized reason and normalized timestamps', () => {
  assert.throws(() => createRuntimeOverride({ id: 'override-1', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: '   ', createdAt: now }), /reason/i);
  assert.throws(() => createRuntimeOverride({ id: 'override-1', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Bearer abcdefghijklmnopqrstuvwxyz', createdAt: now }), /sanitized/i);
  assert.throws(() => createRuntimeOverride({ id: 'override-1', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Reviewed exception.', createdAt: 'not-a-time' }), /timestamp/i);
});

test('a rule override applies only to its referenced rule and cannot bypass another block', () => {
  const override = createRuntimeOverride({ id: 'override-1', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Reviewed exception.', createdAt: now });
  const result = applyRuntimeOverride({ decision, input: action, override, now, taskSessionId: 'task-1' });

  assert.equal(result.accepted, true);
  assert.equal(result.decision.outcome, 'BLOCK');
  assert.deepEqual(result.decision.override?.overriddenRuleIds, ['rule-a']);
  assert.equal(result.decision.explanations.length, 2);
});

test('action and task-session scopes allow continuation only for their bound target', () => {
  const actionOverride = createRuntimeOverride({ id: 'override-action', scope: { kind: 'action', signature: action.signature }, reason: 'Operator verified action.', createdAt: now });
  const acceptedAction = applyRuntimeOverride({ decision, input: action, override: actionOverride, now });
  assert.equal(acceptedAction.accepted, true);
  assert.equal(acceptedAction.decision.outcome, 'ALLOW');
  assert.equal(applyRuntimeOverride({ decision, input: { ...action, signature: { ...action.signature, arguments: ['main'] } }, override: actionOverride, now }).accepted, false);

  const sessionOverride = createRuntimeOverride({ id: 'override-session', scope: { kind: 'task-session', taskSessionId: 'task-1' }, reason: 'Session exception.', createdAt: now });
  assert.equal(applyRuntimeOverride({ decision, input: action, override: sessionOverride, now, taskSessionId: 'task-1' }).decision.outcome, 'ALLOW');
  assert.equal(applyRuntimeOverride({ decision, input: action, override: sessionOverride, now, taskSessionId: 'task-2' }).rejection, 'SCOPE_MISMATCH');
});

test('rejects expired, future-created, and nonmatching overrides without changing the decision', () => {
  const expired = createRuntimeOverride({ id: 'expired', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Short exception.', createdAt: '2026-08-25T08:00:00.000Z', expiresAt: '2026-08-25T09:00:00.000Z' });
  const future = createRuntimeOverride({ id: 'future', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Future exception.', createdAt: '2026-08-25T11:00:00.000Z' });
  const missing = createRuntimeOverride({ id: 'missing', scope: { kind: 'rule', ruleId: 'rule-c' }, reason: 'Wrong rule.', createdAt: now });

  assert.equal(applyRuntimeOverride({ decision, input: action, override: expired, now }).rejection, 'EXPIRED');
  assert.equal(applyRuntimeOverride({ decision, input: action, override: future, now }).rejection, 'NOT_YET_VALID');
  const result = applyRuntimeOverride({ decision, input: action, override: missing, now });
  assert.equal(result.rejection, 'SCOPE_MISMATCH');
  assert.equal(result.decision, decision);
});

test('does not accept an override for a contextual rule that has no enforcing outcome', () => {
  const contextualDecision = {
    ...decision,
    outcome: 'ALLOW' as const,
    explanations: decision.explanations.map((item) => ({ ...item, outcome: 'ALLOW' as const }))
  };
  const override = createRuntimeOverride({ id: 'context-only', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'No enforcement exists.', createdAt: now });
  assert.equal(applyRuntimeOverride({ decision: contextualDecision, input: action, override, now }).rejection, 'DECISION_NOT_ENFORCING');
});

function audit(id: string, overrideId: string, phase: 'authorized' | 'completed', outcome?: 'succeeded' | 'failed', useId = 'use-1'): OverrideAuditEntry {
  return {
    id,
    useId,
    override: createRuntimeOverride({ id: overrideId, scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Reviewed exception.', createdAt: now }),
    phase,
    recordedAt: phase === 'authorized' ? now : '2026-08-25T10:01:00.000Z',
    decisionReferences: decision.references,
    ...(outcome === undefined ? {} : { postActionOutcome: outcome })
  };
}

test('persists deterministic append-only authorization and post-action audit rows', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite');
  const store = new OverrideStore(databasePath);
  store.append(audit('audit-1', 'override-1', 'authorized'));
  store.append(audit('audit-2', 'override-1', 'completed', 'succeeded'));

  assert.deepEqual(store.list().map(({ id, phase, postActionOutcome }) => [id, phase, postActionOutcome]), [
    ['audit-1', 'authorized', undefined], ['audit-2', 'completed', 'succeeded']
  ]);
  assert.throws(() => store.append(audit('audit-1', 'override-1', 'authorized')), /UNIQUE|unique/i);
  assert.equal(store.list().length, 2);
  store.close();

  const reopened = new OverrideStore(databasePath);
  assert.deepEqual(reopened.list('override-1').map(({ id }) => id), ['audit-1', 'audit-2']);
  reopened.close();
});

test('ExperienceStore applies the override audit migration', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite');
  const experienceStore = new ExperienceStore(databasePath);
  experienceStore.close();

  const database = openExperienceDatabase(databasePath);
  assert.equal(database.prepare('SELECT version FROM schema_migrations WHERE version = 6').get() !== undefined, true);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_override_audit'").get() !== undefined, true);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('runtime_override_audit') WHERE name = 'use_id'").get() as { count: number }).count, 1);
  database.close();
});

test('requires authorization before completion and an identical decision reference set', () => {
  const store = new OverrideStore(join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite'));
  assert.throws(() => store.append(audit('completed-first', 'override-1', 'completed', 'succeeded')), /prior authorization/i);
  store.append(audit('authorized', 'override-1', 'authorized'));
  assert.throws(() => store.append({
    ...audit('completed-wrong', 'override-1', 'completed', 'succeeded'),
    decisionReferences: decision.references.slice(0, 1)
  }), /match its authorization/i);
  assert.deepEqual(store.list().map(({ id }) => id), ['authorized']);
  store.close();
});

test('repeated successful overrides retain history and derive contradiction and revalidation evidence', () => {
  const reusedGrant = createRuntimeOverride({ id: 'override-reused', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Reviewed exception.', createdAt: now });
  const history = [
    { ...audit('authorized-1', 'override-reused', 'authorized', undefined, 'use-1'), override: reusedGrant },
    { ...audit('completed-1', 'override-reused', 'completed', 'succeeded', 'use-1'), override: reusedGrant },
    { ...audit('authorized-2', 'override-reused', 'authorized', undefined, 'use-2'), override: reusedGrant },
    { ...audit('completed-2', 'override-reused', 'completed', 'succeeded', 'use-2'), override: reusedGrant }
  ];

  const evidence = deriveOverrideLearningEvidence(history);
  assert.deepEqual(evidence, [{
    ruleId: 'rule-a', polarity: 'contradicts',
    successfulOverrideIds: ['override-reused', 'override-reused'],
    successfulUseIds: ['use-1', 'use-2'],
    revalidationRequired: true
  }]);
  assert.equal(history.length, 4);
  assert.equal(Object.isFrozen(evidence), true);
});

test('persists two complete uses of the same reusable grant without overwriting history', () => {
  const store = new OverrideStore(join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite'));
  const reusableActionGrant = createRuntimeOverride({
    id: 'override-reused', scope: { kind: 'action', signature: action.signature }, reason: 'Reviewed reusable action.', createdAt: now
  });
  for (const useId of ['use-1', 'use-2']) {
    store.append({ ...audit(`authorized-${useId}`, 'override-reused', 'authorized', undefined, useId), override: reusableActionGrant });
    store.append({ ...audit(`completed-${useId}`, 'override-reused', 'completed', 'succeeded', useId), override: reusableActionGrant });
  }
  const rows = store.list('override-reused');
  assert.deepEqual(rows.map(({ useId, phase }) => [useId, phase]), [
    ['use-1', 'authorized'], ['use-1', 'completed'], ['use-2', 'authorized'], ['use-2', 'completed']
  ]);
  assert.equal(deriveOverrideLearningEvidence(rows)[0]?.revalidationRequired, true);
  store.close();
});

test('migrates legacy single-use audit rows without losing their authorization pair', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite');
  const database = openExperienceDatabase(databasePath);
  database.exec(overrideAuditMigration);
  const authorization = audit('legacy-authorized', 'legacy-override', 'authorized');
  const completion = audit('legacy-completed', 'legacy-override', 'completed', 'succeeded');
  const insert = database.prepare(`
    INSERT INTO runtime_override_audit
      (id, override_id, phase, scope_json, reason, created_at, expires_at, recorded_at, decision_references_json, post_action_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of [authorization, completion]) insert.run(
    entry.id, entry.override.id, entry.phase, JSON.stringify(entry.override.scope), entry.override.reason,
    entry.override.createdAt, null, entry.recordedAt, JSON.stringify(entry.decisionReferences), entry.postActionOutcome ?? null
  );
  database.close();

  const migrated = new OverrideStore(databasePath);
  assert.deepEqual(migrated.list().map(({ useId, phase }) => [useId, phase]), [
    ['legacy', 'authorized'], ['legacy', 'completed']
  ]);
  migrated.close();
});

test('ExperienceStore safely recognizes a use migration first applied by OverrideStore', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite');
  new OverrideStore(databasePath).close();
  const experienceStore = new ExperienceStore(databasePath);
  experienceStore.close();
  const database = openExperienceDatabase(databasePath);
  assert.equal(database.prepare('SELECT version FROM schema_migrations WHERE version = 6').get() !== undefined, true);
  database.close();
});

test('rejects private or credential-bearing decision references atomically without echoing values', () => {
  const store = new OverrideStore(join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite'));
  const unsafeValues = [
    { field: 'ruleId', value: 'ghp_abcdefghijklmnopqrstuvwxyz123456' },
    { field: 'knowledgeId', value: '/Users/private/knowledge' },
    { field: 'evidenceId', value: 'session_id=private-session' },
    { field: 'source', value: 'https://user:password@example.com/repository' }
  ] as const;
  for (const { field, value } of unsafeValues) {
    const reference = { ...decision.references[0]!, evidenceIds: [...decision.references[0]!.evidenceIds] };
    if (field === 'evidenceId') reference.evidenceIds = [value];
    else Object.assign(reference, { [field]: value });
    let message = '';
    try {
      store.append({ ...audit(`unsafe-${field}`, `override-${field}`, 'authorized'), decisionReferences: [reference] });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.notEqual(message, '');
    assert.equal(message.includes(value), false);
  }
  assert.deepEqual(store.list(), []);
  store.close();
});

test('authorizes only inside the inclusive-created and exclusive-expiry window', () => {
  const expiring = createRuntimeOverride({
    id: 'expiring', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Timed exception.',
    createdAt: '2026-08-25T10:00:00.000Z', expiresAt: '2026-08-25T11:00:00.000Z'
  });
  const store = new OverrideStore(join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite'));
  store.append({ ...audit('at-created', 'expiring', 'authorized', undefined, 'use-created'), override: expiring, recordedAt: expiring.createdAt });
  assert.throws(() => store.append({ ...audit('before-created', 'expiring', 'authorized', undefined, 'use-before'), override: expiring, recordedAt: '2026-08-25T09:59:59.999Z' }), /authorization time/i);
  assert.throws(() => store.append({ ...audit('at-expiry', 'expiring', 'authorized', undefined, 'use-expiry'), override: expiring, recordedAt: expiring.expiresAt! }), /authorization time/i);
  assert.deepEqual(store.list().map(({ id }) => id), ['at-created']);
  store.close();
});

test('rejects malformed completion audit rows atomically', () => {
  const store = new OverrideStore(join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite'));
  assert.throws(() => store.append({ ...audit('bad', 'override-1', 'completed'), postActionOutcome: undefined }), /outcome/i);
  assert.deepEqual(store.list(), []);
  store.close();
});
