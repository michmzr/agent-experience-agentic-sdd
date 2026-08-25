import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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
  MAX_OVERRIDE_EVIDENCE_ENTRIES,
  type OverrideAuditEntry
} from '../src/runtime/override.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { compileRuntimeSnapshot } from '../src/runtime/snapshot.js';
import { openExperienceDatabase } from '../src/storage/database.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import {
  ensureOverrideAuditUseMigration,
  MAX_OVERRIDE_AUDIT_PAGE_SIZE,
  OVERRIDE_AUDIT_MIGRATION_BATCH_SIZE,
  overrideAuditMigration,
  OverrideStore
} from '../src/storage/override-store.js';

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

test('cannot apply a harmless-action override to a blocking decision created for another input', () => {
  const harmless: RuntimeInput = {
    ...action,
    tags: ['inspection'],
    signature: { kind: 'action', tool: 'git', action: 'status', path: '/workspace/repo' }
  };
  const harmlessOverride = createRuntimeOverride({
    id: 'harmless', scope: { kind: 'action', signature: harmless.signature }, reason: 'Status is read-only.', createdAt: now
  });
  const result = applyRuntimeOverride({ decision, input: harmless, override: harmlessOverride, now });
  assert.equal(result.rejection, 'INPUT_MISMATCH');
  assert.equal(result.decision.outcome, 'BLOCK');
});

test('decision input binding covers repository, tags, and operation class', () => {
  const grant = createRuntimeOverride({
    id: 'binding', scope: { kind: 'action', signature: action.signature }, reason: 'Bound exception.', createdAt: now
  });
  for (const changed of [
    { ...action, repositoryId: 'repo-2' },
    { ...action, tags: ['different'] },
    { ...action, signature: { ...action.signature, path: '/workspace/other' } },
    { ...action, operationClass: 'normal' as const }
  ]) {
    assert.equal(applyRuntimeOverride({ decision, input: changed, override: grant, now }).rejection, 'INPUT_MISMATCH');
  }
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

function allAudit(store: OverrideStore, overrideId?: string): readonly OverrideAuditEntry[] {
  const entries: OverrideAuditEntry[] = [];
  let afterSequence: number | undefined;
  do {
    const page = store.listPage({ ...(overrideId === undefined ? {} : { overrideId }), ...(afterSequence === undefined ? {} : { afterSequence }) });
    entries.push(...page.entries);
    afterSequence = page.nextCursor;
  } while (afterSequence !== undefined);
  return entries;
}

test('persists deterministic append-only authorization and post-action audit rows', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite');
  const store = new OverrideStore(databasePath);
  store.append(audit('audit-1', 'override-1', 'authorized'));
  store.append(audit('audit-2', 'override-1', 'completed', 'succeeded'));

  assert.deepEqual(allAudit(store).map(({ id, phase, postActionOutcome }) => [id, phase, postActionOutcome]), [
    ['audit-1', 'authorized', undefined], ['audit-2', 'completed', 'succeeded']
  ]);
  assert.throws(() => store.append(audit('audit-1', 'override-1', 'authorized')), /UNIQUE|unique/i);
  assert.equal(allAudit(store).length, 2);
  store.close();

  const reopened = new OverrideStore(databasePath);
  assert.deepEqual(allAudit(reopened, 'override-1').map(({ id }) => id), ['audit-1', 'audit-2']);
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
  assert.deepEqual(allAudit(store).map(({ id }) => id), ['authorized']);
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
  const rows = allAudit(store, 'override-reused');
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
  assert.deepEqual(allAudit(migrated).map(({ useId, phase }) => [useId, phase]), [
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

function insertLegacyAudit(database: ReturnType<typeof openExperienceDatabase>, entry: OverrideAuditEntry): void {
  database.prepare(`
    INSERT INTO runtime_override_audit
      (id, override_id, phase, scope_json, reason, created_at, expires_at, recorded_at, decision_references_json, post_action_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id, entry.override.id, entry.phase, JSON.stringify(entry.override.scope), entry.override.reason,
    entry.override.createdAt, entry.override.expiresAt ?? null, entry.recordedAt,
    JSON.stringify(entry.decisionReferences), entry.postActionOutcome ?? null
  );
}

function legacyState(database: ReturnType<typeof openExperienceDatabase>): unknown {
  return {
    schema: database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'runtime_override_audit%' ORDER BY type, name").all(),
    rows: database.prepare('SELECT * FROM runtime_override_audit ORDER BY sequence').all(),
    versions: database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
  };
}

function createVersion5Database(entry: OverrideAuditEntry): { databasePath: string; before: unknown; bytes: Buffer } {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-override-v5-')), 'experience.sqlite');
  const database = openExperienceDatabase(databasePath);
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(5, now);
  database.exec(overrideAuditMigration);
  insertLegacyAudit(database, entry);
  const before = legacyState(database);
  database.close();
  return { databasePath, before, bytes: readFileSync(databasePath) };
}

function attemptVersion6(databasePath: string): Error | undefined {
  const database = openExperienceDatabase(databasePath);
  database.exec('BEGIN IMMEDIATE');
  try {
    ensureOverrideAuditUseMigration(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(6, now);
    database.exec('COMMIT');
    database.close();
    return undefined;
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    return error as Error;
  }
}

test('unsafe legacy source and identifier references fail migration without rewriting audit history', () => {
  for (const [label, reference, secret] of [
    ['source', { ...decision.references[0]!, source: 'https://user:password@example.com/repository' }, 'https://user:password@example.com/repository'],
    ['id', { ...decision.references[0]!, ruleId: '/Users/private/rule' }, '/Users/private/rule']
  ] as const) {
    const unsafe = {
      ...audit(`legacy-unsafe-${label}`, `legacy-override-${label}`, 'authorized'),
      decisionReferences: [reference]
    };
    const fixture = createVersion5Database(unsafe);
    const error = attemptVersion6(fixture.databasePath);
    assert.notEqual(error, undefined);
    assert.equal(error!.message.includes(secret), false);

    const database = openExperienceDatabase(fixture.databasePath);
    assert.deepEqual(legacyState(database), fixture.before);
    database.close();
    assert.deepEqual(readFileSync(fixture.databasePath), fixture.bytes);
  }
});

test('out-of-window legacy authorization fails migration with version 5 intact', () => {
  const grant = createRuntimeOverride({
    id: 'legacy-expired', scope: { kind: 'rule', ruleId: 'rule-a' }, reason: 'Legacy exception.',
    createdAt: '2026-08-25T08:00:00.000Z', expiresAt: '2026-08-25T09:00:00.000Z'
  });
  const fixture = createVersion5Database({
    ...audit('legacy-expired-auth', 'legacy-expired', 'authorized'), override: grant, recordedAt: '2026-08-25T09:00:00.000Z'
  });
  assert.match(attemptVersion6(fixture.databasePath)?.message ?? '', /authorization time/i);
  const database = openExperienceDatabase(fixture.databasePath);
  assert.deepEqual(legacyState(database), fixture.before);
  assert.deepEqual((database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(({ version }) => version), [5]);
  database.close();
  assert.deepEqual(readFileSync(fixture.databasePath), fixture.bytes);
});

test('version 6 schema rejects null, empty, and duplicate use-phase identities directly', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite');
  new OverrideStore(databasePath).close();
  const database = openExperienceDatabase(databasePath);
  const entry = audit('direct', 'direct-override', 'authorized', undefined, 'direct-use');
  const insert = database.prepare(`
    INSERT INTO runtime_override_audit
      (id, override_id, use_id, phase, scope_json, reason, created_at, expires_at, recorded_at, decision_references_json, post_action_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const values = (id: string, useId: string | null) => [
    id, entry.override.id, useId, entry.phase, JSON.stringify(entry.override.scope), entry.override.reason,
    entry.override.createdAt, null, entry.recordedAt, JSON.stringify(entry.decisionReferences), null
  ] as const;
  assert.throws(() => insert.run(...values('null-use', null)), /NOT NULL|constraint/i);
  assert.throws(() => insert.run(...values('empty-use', '')), /CHECK|constraint/i);
  assert.throws(() => insert.run(...values('noncanonical-use', 'bad/use')), /CHECK|constraint/i);
  insert.run(...values('valid-use', 'direct-use'));
  assert.throws(() => insert.run(...values('duplicate-use', 'direct-use')), /UNIQUE|constraint/i);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM runtime_override_audit').get() as { count: number }).count, 1);
  database.close();
});

test('paginates audit history with a stable cursor, hard cap, and no duplicates', () => {
  const store = new OverrideStore(join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite'));
  for (let index = 0; index < 7; index += 1) {
    const useId = `page-use-${index}`;
    store.append(audit(`page-auth-${index}`, 'page-override', 'authorized', undefined, useId));
    store.append(audit(`page-done-${index}`, 'page-override', 'completed', 'succeeded', useId));
  }
  const first = store.listPage({ overrideId: 'page-override', limit: 5 });
  const second = store.listPage({ overrideId: 'page-override', limit: 5, afterSequence: first.nextCursor });
  const third = store.listPage({ overrideId: 'page-override', limit: 5, afterSequence: second.nextCursor });
  const ids = [...first.entries, ...second.entries, ...third.entries].map(({ id }) => id);
  assert.deepEqual(ids, Array.from({ length: 7 }, (_, index) => [`page-auth-${index}`, `page-done-${index}`]).flat());
  assert.equal(new Set(ids).size, 14);
  assert.equal(third.nextCursor, undefined);
  assert.throws(() => store.listPage({ limit: MAX_OVERRIDE_AUDIT_PAGE_SIZE + 1 }), /page size/i);
  store.close();
});

test('validates and migrates legacy audit history spanning more than one batch', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-override-v5-')), 'experience.sqlite');
  const database = openExperienceDatabase(databasePath);
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(5, now);
  database.exec(overrideAuditMigration);
  const count = OVERRIDE_AUDIT_MIGRATION_BATCH_SIZE + 3;
  for (let index = 0; index < count; index += 1) insertLegacyAudit(database, audit(`batch-${index}`, `batch-override-${index}`, 'authorized'));
  database.close();
  assert.equal(attemptVersion6(databasePath), undefined);
  const migrated = new OverrideStore(databasePath);
  assert.equal(allAudit(migrated).length, count);
  migrated.close();
});

test('rejects unbounded evidence derivation input', () => {
  const entry = audit('bounded', 'bounded-override', 'authorized');
  assert.throws(() => deriveOverrideLearningEvidence(Array.from({ length: MAX_OVERRIDE_EVIDENCE_ENTRIES + 1 }, () => entry)), /resource limit/i);
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
  assert.deepEqual(allAudit(store), []);
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
  assert.deepEqual(allAudit(store).map(({ id }) => id), ['at-created']);
  store.close();
});

test('rejects malformed completion audit rows atomically', () => {
  const store = new OverrideStore(join(mkdtempSync(join(tmpdir(), 'ael-override-')), 'experience.sqlite'));
  assert.throws(() => store.append({ ...audit('bad', 'override-1', 'completed'), postActionOutcome: undefined }), /outcome/i);
  assert.deepEqual(allAudit(store), []);
  store.close();
});
