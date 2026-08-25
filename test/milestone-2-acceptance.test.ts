import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createLocalGitContentAdapter, runtimeTargetSnapshotDirectory, RuntimeService
} from '../src/application/runtime-service.js';
import { adaptClaudeCodeCapture } from '../src/capture/adapters/claude-code.js';
import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import { adaptCursorCapture } from '../src/capture/adapters/cursor.js';
import { createCaptureService } from '../src/capture/capture-service.js';
import { NORMAL_PROFILE } from '../src/config/runtime-profile.js';
import type { CandidateLessonId, Evidence, KnowledgeEntry, SessionId } from '../src/domain/types.js';
import type { RuntimeInput, RuntimeRule, RuntimeSignature } from '../src/runtime/contracts.js';
import { createRuntimeGate, type GateDecision } from '../src/runtime/gate.js';
import { applyRuntimeOverride, createRuntimeOverride, type OverrideAuditEntry } from '../src/runtime/override.js';
import { ResilientRuntime, RuntimeSnapshotUnavailableError } from '../src/runtime/resilience.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { compileRuntimeSnapshot, serializeRuntimeSnapshot } from '../src/runtime/snapshot.js';
import { evaluatePromotion } from '../src/shared-knowledge/promotion-policy.js';
import { writeSharedKnowledge, type SharedKnowledgeDocument } from '../src/shared-knowledge/repository.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { OverrideStore } from '../src/storage/override-store.js';
import { RuntimeSnapshotStore } from '../src/storage/runtime-snapshot-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';

const now = '2026-08-25T10:00:00.000Z';

interface RuntimeFixture {
  readonly input: RuntimeInput;
  readonly rule: RuntimeRule;
}

function fixture(name: string): RuntimeFixture {
  return JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/runtime', name), 'utf8')) as RuntimeFixture;
}

function gateDecision(input: RuntimeInput, rules: readonly RuntimeRule[], profile = NORMAL_PROFILE): GateDecision {
  const snapshot = compileRuntimeSnapshot({
    repositoryId: input.repositoryId ?? 'global',
    generatedAt: now,
    repositoryRules: rules.filter(({ applicability, authoritative, state, effect }) => applicability.scope === 'repository' && authoritative && state !== 'disputed' && effect === 'conflict'),
    globalRules: rules.filter(({ applicability, authoritative, state, effect }) => applicability.scope === 'global' && authoritative && state !== 'disputed' && effect === 'conflict'),
    contextRules: rules.filter(({ authoritative, state, effect }) => !authoritative || state === 'disputed' || effect === 'context')
  });
  const index = createRuleIndex(snapshot);
  return createRuntimeGate({
    index,
    profile,
    status: {
      health: 'healthy', profileId: profile.id, hardBlocking: profile.hardBlocking,
      retrievalMode: 'deterministic', fallbackSource: 'memory', circuitState: 'closed'
    }
  }).evaluate(input);
}

function writeInput(root: string, name: string, input: RuntimeInput): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
  return path;
}

function seedStaleKnowledge(databasePath: string): ExperienceStore {
  const target = new ExperienceStore(databasePath);
  target.import({
    sessions: [{ id: 'seed-session' as SessionId, source: 'codex', startedAt: now }],
    events: [{ id: 'seed-event' as never, sessionId: 'seed-session' as SessionId, kind: 'test-result', occurredAt: now, outcome: 'passed' }],
    observations: [{ id: 'seed-observation' as never, eventIds: ['seed-event' as never], statement: 'The command was once considered invalid.' }],
    clusters: [{ id: 'seed-cluster' as never, observationIds: ['seed-observation' as never] }],
    candidates: [{ id: 'stale-candidate' as CandidateLessonId, clusterId: 'seed-cluster' as never, kind: 'failure', statement: 'Do not run the command.' }],
    evidence: [{ id: 'seed-evidence' as Evidence['id'], candidateId: 'stale-candidate' as CandidateLessonId, polarity: 'confirms', summary: 'Prior failure.' }],
    knowledge: [{ id: 'stale-knowledge' as KnowledgeEntry['id'], candidateId: 'stale-candidate' as CandidateLessonId, evidenceIds: ['seed-evidence' as Evidence['id']], state: 'verified', statement: 'Do not run the command.' }]
  });
  return target;
}

test('prevents repeated invalid actions while retaining successful workflow context', () => {
  const invalid = fixture('repeated-invalid-command.json');
  assert.deepEqual([
    gateDecision(invalid.input, [invalid.rule]).outcome,
    gateDecision(invalid.input, [invalid.rule]).outcome
  ], ['BLOCK', 'BLOCK']);
  const stableSnapshot = compileRuntimeSnapshot({
    repositoryId: invalid.input.repositoryId!, generatedAt: now, repositoryRules: [invalid.rule]
  });
  assert.equal(serializeRuntimeSnapshot(stableSnapshot), serializeRuntimeSnapshot(stableSnapshot));

  const workflowRule: RuntimeRule = {
    ...invalid.rule,
    id: 'workflow-context',
    state: 'verified',
    authoritative: true,
    effect: 'context',
    signature: { kind: 'intent', verb: 'prepare', target: 'release', tool: 'pnpm' },
    reference: { knowledgeId: 'workflow-knowledge', evidenceIds: ['workflow-evidence'] }
  };
  const workflowInput: RuntimeInput = {
    repositoryId: invalid.input.repositoryId,
    operationClass: 'normal',
    signature: { kind: 'intent', verb: 'prepare', target: 'release', tool: 'pnpm' }
  };
  const workflow = gateDecision(workflowInput, [workflowRule]);
  assert.equal(workflow.outcome, 'ALLOW');
  assert.deepEqual(workflow.references.map(({ knowledgeId }) => knowledgeId), ['workflow-knowledge']);
  assert.equal(workflow.retrievalEnabled, true);
});

test('learning mode captures causal success and moves a stale verified rule to disputed', () => {
  const stale = fixture('stale-verified-rule.json');
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'ael-m2-public-runtime-'));
  const inputPath = writeInput(runtimeRoot, 'stale-input.json', stale.input);
  const runtime = new RuntimeService({
    dataDir: join(runtimeRoot, 'data'), clock: () => new Date(now),
    refreshSnapshot: (input) => compileRuntimeSnapshot({ repositoryId: input.repositoryId!, generatedAt: now, repositoryRules: [stale.rule] })
  });
  const decision = runtime.evaluate({ inputPath, profileId: 'learning', refresh: true });
  assert.equal(decision.outcome, 'WARN');
  assert.equal(decision.captureEnabled, true);

  const target = seedStaleKnowledge(join(mkdtempSync(join(tmpdir(), 'ael-m2-capture-')), 'experience.sqlite'));
  const capture = createCaptureService({
    store: target,
    session: { id: 'runtime-session' as SessionId, source: 'codex', startedAt: now }
  });
  const pre = adaptCodexCapture({
    event_id: 'stale-pre', session_id: 'runtime-session', event_kind: 'pre_action', occurred_at: now,
    tool: 'git', action: 'push', arguments: ['--force-with-lease'], cwd: '/workspace/repo', summary: 'Run reviewed push.'
  });
  const post = adaptCodexCapture({
    event_id: 'stale-post', session_id: 'runtime-session', event_kind: 'post_result', occurred_at: now,
    tool: 'git', action: 'push', arguments: ['--force-with-lease'], cwd: '/workspace/repo', summary: 'Reviewed push succeeded.',
    outcome: 'succeeded', exit_status: 0, related_event_id: 'stale-pre'
  });
  assert.equal(capture.capture(pre, decision).status, 'captured');
  assert.equal(capture.capture(post, decision).status, 'captured');
  assert.equal(target.inspect('stale-knowledge' as KnowledgeEntry['id'])?.state, 'disputed');
  assert.deepEqual(target.loadCaptureEnforcementSnapshot('codex', 'stale-pre')?.inputBinding, decision.inputBinding);
  assert.equal(target.listEvidencePage().entries.some(({ polarity }) => polarity === 'contradicts'), true);
  target.close();

  const disputed = gateDecision(stale.input, [{ ...stale.rule, state: 'disputed', effect: 'context' }]);
  assert.equal(disputed.outcome, 'ALLOW');
});

test('rejects task-specific promotion and reuses trusted merged knowledge through all adapters', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-m2-repository-'));
  const privateState = mkdtempSync(join(tmpdir(), 'ael-m2-knowledge-state-'));
  initializeGitRepository(repository);
  const document: SharedKnowledgeDocument = {
    identity: 'merged-invalid-command', repositoryScope: 'repository:repo-acceptance', kind: 'failure', state: 'verified',
    applicability: { paths: [], tags: [], tools: ['git'] },
    instructionOrigin: 'code-tool-confirmed', supersedes: [], title: 'Avoid destructive reset', context: 'Repository command execution.',
    lesson: 'A destructive reset removed required work.', recommendedBehavior: 'Use a non-destructive inspection first.', evidenceSummary: 'Confirmed by local Git state.',
    evidence: [{ kind: 'code-or-tool', summary: 'Local Git confirmed the loss.', deterministic: true }],
    runtimeDirective: {
      effect: 'conflict',
      signature: { kind: 'action', tool: 'git', action: 'reset', arguments: ['--hard'] }
    }
  };
  const taskSpecific = { ...document, identity: 'task-only', instructionOrigin: 'task-specific-constraint' as const };
  assert.equal(evaluatePromotion(taskSpecific).eligible, false);

  writeSharedKnowledge(repository, [document], { stateRoot: join(privateState, 'publication') });
  execFileSync('git', ['-C', repository, 'add', 'agent-experience']);
  execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', 'merge knowledge']);

  const records = [
    adaptCodexCapture({ event_id: 'codex-merged', session_id: 'session-merged', event_kind: 'pre_action', occurred_at: now, tool: 'git', action: 'reset', arguments: ['--hard'], summary: 'Run reset.' }),
    adaptClaudeCodeCapture({ eventId: 'claude-merged', sessionId: 'session-merged', kind: 'PreToolUse', timestamp: now, toolName: 'git', actionName: 'reset', args: ['--hard'], summary: 'Run reset.' }),
    adaptCursorCapture({ id: 'cursor-merged', session: 'session-merged', event: 'before-action', timestamp: now, tool: 'git', action: 'reset', arguments: ['--hard'], summary: 'Run reset.' })
  ];
  const dataDir = join(privateState, 'runtime');
  const service = new RuntimeService({ dataDir, clock: () => new Date(now) });
  const refreshed = service.refreshKnowledgeRuntime(repository, 'repo-acceptance', 'HEAD');
  assert.equal(refreshed.rules, 1);

  const localOnly: SharedKnowledgeDocument = {
    ...document,
    identity: 'untrusted-local-rule',
    runtimeDirective: { effect: 'conflict', signature: { kind: 'action', tool: 'git', action: 'clean', arguments: ['-fd'] } }
  };
  writeSharedKnowledge(repository, [document, localOnly], { stateRoot: join(privateState, 'local-change') });
  assert.equal(service.refreshKnowledgeRuntime(repository, 'repo-acceptance', 'HEAD').rules, 1);

  for (const [index, record] of records.entries()) {
    const inputPath = writeInput(privateState, `adapter-${index}.json`, inputForSignature(record.signature));
    const decision = new RuntimeService({ dataDir, clock: () => new Date(now) }).evaluate({ inputPath });
    assert.equal(decision.outcome, 'BLOCK');
    assert.deepEqual(decision.references.map(({ knowledgeId }) => knowledgeId), ['merged-invalid-command']);
  }
  const otherRepositoryInput = writeInput(privateState, 'other-repository.json', {
    ...inputForSignature(records[0]!.signature), repositoryId: 'other-repository'
  });
  assert.equal(new RuntimeService({ dataDir, clock: () => new Date(now) }).evaluate({ inputPath: otherRepositoryInput }).outcome, 'ALLOW');
});

test('retained services use memory while process restarts fall back to the last-known-good generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-m2-service-'));
  const input = fixture('repeated-invalid-command.json');
  const inputPath = writeInput(root, 'input.json', input.input);
  let generation = 0;
  const service = new RuntimeService({
    dataDir: join(root, 'data'),
    clock: () => new Date(Date.parse(now) + generation++ * 1_000),
    refreshSnapshot: (runtimeInput) => compileRuntimeSnapshot({
      repositoryId: runtimeInput.repositoryId!, generatedAt: new Date(Date.parse(now) + generation * 1_000).toISOString(), repositoryRules: [input.rule]
    })
  });
  assert.equal(service.evaluate({ inputPath, refresh: true }).outcome, 'BLOCK');
  assert.equal(service.evaluate({ inputPath, refresh: true }).outcome, 'BLOCK');
  const state = new RuntimeSnapshotStore(runtimeTargetSnapshotDirectory(join(root, 'data'), input.input.repositoryId), { clock: () => Date.parse(now) });
  writeFileSync(state.generationPath(state.loadCurrent().checksum), '{broken', { mode: 0o600 });
  assert.equal(service.evaluate({ inputPath }).status.fallbackSource, 'memory');

  const restarted = new RuntimeService({ dataDir: join(root, 'data'), clock: () => new Date(now) });
  const restartedDecision = restarted.evaluate({ inputPath });
  assert.equal(restartedDecision.outcome, 'BLOCK');
  assert.equal(restartedDecision.status.fallbackSource, 'last-known-good');
});

test('keeps repository targets isolated and reloads an evicted target from durable state', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-m2-lru-'));
  const paths = new Map([
    ['repo-a', writeInput(root, 'repo-a.json', { repositoryId: 'repo-a', operationClass: 'protected', signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--force'] } })],
    ['repo-b', writeInput(root, 'repo-b.json', { repositoryId: 'repo-b', operationClass: 'protected', signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--force'] } })]
  ]);
  let refreshCalls = 0;
  const service = new RuntimeService({
    dataDir: join(root, 'data'), runtimeTargetCapacity: 1, clock: () => new Date(now),
    refreshSnapshot: (input) => {
      refreshCalls += 1;
      const id = input.repositoryId!;
      return compileRuntimeSnapshot({ repositoryId: id, generatedAt: now, repositoryRules: [{
        id: `rule-${id}`, state: 'verified', authoritative: true, effect: 'conflict', signature: input.signature,
        applicability: { scope: 'repository', repositoryId: id }, reference: { knowledgeId: `knowledge-${id}`, evidenceIds: [`evidence-${id}`] }
      }] });
    }
  });
  assert.deepEqual([
    service.evaluate({ inputPath: paths.get('repo-a')!, refresh: true }).references[0]?.ruleId,
    service.evaluate({ inputPath: paths.get('repo-b')!, refresh: true }).references[0]?.ruleId,
    service.evaluate({ inputPath: paths.get('repo-a')! }).references[0]?.ruleId
  ], ['rule-repo-a', 'rule-repo-b', 'rule-repo-a']);
  assert.equal(refreshCalls, 2);
  assert.notEqual(runtimeTargetSnapshotDirectory(join(root, 'data'), 'repo-a'), runtimeTargetSnapshotDirectory(join(root, 'data'), 'repo-b'));
});

test('requires explicit refresh for corrupt state without an LKG and preserves bounded safe recovery artifacts', () => {
  const degradedFixture = fixture('degraded-runtime.json');
  const applicationRoot = mkdtempSync(join(tmpdir(), 'ael-m2-explicit-refresh-'));
  const inputPath = writeInput(applicationRoot, 'input.json', degradedFixture.input);
  let refreshGeneration = 0;
  const makeApplication = () => new RuntimeService({
    dataDir: join(applicationRoot, 'data'), clock: () => new Date(now),
    refreshSnapshot: (input) => compileRuntimeSnapshot({
      repositoryId: input.repositoryId!,
      generatedAt: new Date(Date.parse(now) + refreshGeneration++ * 1_000).toISOString(),
      repositoryRules: [degradedFixture.rule]
    })
  });
  const initialService = makeApplication();
  assert.equal(initialService.evaluate({ inputPath, refresh: true }).outcome, 'BLOCK');
  const applicationStore = new RuntimeSnapshotStore(runtimeTargetSnapshotDirectory(join(applicationRoot, 'data'), degradedFixture.input.repositoryId), { clock: () => Date.parse(now) });
  writeFileSync(applicationStore.generationPath(applicationStore.loadCurrent().checksum), '{broken', { mode: 0o600 });
  const restartedService = makeApplication();
  assert.deepEqual(
    [restartedService.evaluate({ inputPath }).outcome, restartedService.status().health],
    ['ALLOW', 'degraded']
  );
  assert.equal(restartedService.evaluate({ inputPath, refresh: true }).outcome, 'BLOCK');

  const root = mkdtempSync(join(tmpdir(), 'ael-m2-recovery-'));
  const snapshotStore = new RuntimeSnapshotStore(root, { clock: () => Date.parse(now) });
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-acceptance', generatedAt: now, repositoryRules: [degradedFixture.rule] });
  snapshotStore.publish(first);
  writeFileSync(snapshotStore.generationPath(first.checksum), '{broken', { mode: 0o600 });
  assert.throws(() => snapshotStore.loadCurrent());
  assert.throws(() => snapshotStore.loadLastKnownGood());

  const unsafeTarget = join(root, 'outside-target');
  writeFileSync(unsafeTarget, 'do-not-delete', { mode: 0o600 });
  const unsafeChecksum = 'f'.repeat(64);
  const unsafeSymlink = join(root, `generation-${unsafeChecksum}.json`);
  const unsafeDirectory = join(root, `generation-${'e'.repeat(64)}.json`);
  symlinkSync(unsafeTarget, unsafeSymlink);
  mkdirSync(unsafeDirectory, { mode: 0o700 });

  const recovered = compileRuntimeSnapshot({ repositoryId: 'repo-acceptance', generatedAt: '2026-08-25T10:01:00.000Z', repositoryRules: [degradedFixture.rule] });
  snapshotStore.recover(recovered, 'repo-acceptance');
  assert.equal(snapshotStore.loadCurrent().checksum, recovered.checksum);
  assert.equal(existsSync(unsafeSymlink), true);
  assert.equal(existsSync(unsafeDirectory), true);
  assert.equal(readFileSync(unsafeTarget, 'utf8'), 'do-not-delete');

  const manifest = JSON.parse(readFileSync(snapshotStore.paths.manifest, 'utf8')) as { current: { file: string }; lastKnownGood?: { file: string } };
  const referenced = new Set([manifest.current.file, manifest.lastKnownGood?.file].filter(Boolean));
  const regularGenerations = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^generation-[a-f0-9]{64}\.json$/.test(entry.name))
    .map(({ name }) => name);
  assert.deepEqual(regularGenerations.sort(), [...referenced].sort());
});

test('applies explicit degraded policy without network or LLM dependencies', () => {
  const degraded = fixture('degraded-runtime.json');
  const runtime = new ResilientRuntime({
    profile: NORMAL_PROFILE,
    clock: () => Date.parse(now),
    loadCurrent: () => { throw new RuntimeSnapshotUnavailableError('missing'); },
    loadLastKnownGood: () => { throw new RuntimeSnapshotUnavailableError('missing'); }
  });
  assert.equal(runtime.resolve('normal').outcome, 'ALLOW');
  assert.equal(runtime.resolve('protected').outcome, 'BLOCK');
  assert.equal(gateDecision(degraded.input, [{ ...degraded.rule, state: 'disputed', effect: 'context' }]).outcome, 'ALLOW');

  const roots = ['src/runtime', 'src/capture', 'src/config'];
  const source = roots.flatMap((root) => sourceFiles(root)).map((path) => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(source, /fetch\(|https?:\/\/|node:https|node:http|child_process/);
});

test('classifies credential variants consistently across adapters while retaining benign controls', () => {
  const marker = 'acceptance-private-value';
  const sensitive = [
    () => adaptCodexCapture({ event_id: 'secret-codex', session_id: 'session', event_kind: 'pre_action', occurred_at: now, tool: 'curl', action: 'request', arguments: ['--header', `Authorization:Bearer ${marker}`], summary: 'Request.' }),
    () => adaptClaudeCodeCapture({ eventId: 'secret-claude', sessionId: 'session', kind: 'PreToolUse', timestamp: now, toolName: 'docker', actionName: 'login', args: ['--password', marker], summary: 'Login.' }),
    () => adaptCursorCapture({ id: 'secret-cursor', session: 'session', event: 'before-action', timestamp: now, tool: 'tool', action: 'run', arguments: [`--sessionToken=${marker}`], summary: 'Run.' })
  ];
  for (const adapt of sensitive) {
    assert.throws(adapt, (error: unknown) => error instanceof Error && /credential|private/i.test(error.message) && !error.message.includes(marker));
  }
  const benign = [
    adaptCodexCapture({ event_id: 'benign-codex', session_id: 'session', event_kind: 'pre_action', occurred_at: now, tool: 'sort', action: 'sort', arguments: ['--key=1'], summary: 'Sort.' }),
    adaptClaudeCodeCapture({ eventId: 'benign-claude', sessionId: 'session', kind: 'PreToolUse', timestamp: now, toolName: 'ssh', actionName: 'connect', args: ['-o', 'StrictHostKeyChecking=yes'], summary: 'Connect.' }),
    adaptCursorCapture({ id: 'benign-cursor', session: 'session', event: 'before-action', timestamp: now, tool: 'tool', action: 'run', arguments: ['--monkey=banana', '--author=alice'], summary: 'Run.' })
  ];
  assert.deepEqual(benign.map((event) => event.signature.kind === 'action' ? event.signature.arguments : undefined), [
    ['--key=1'], ['-o', 'StrictHostKeyChecking=yes'], ['--monkey=banana', '--author=alice']
  ]);
});

test('keeps override evidence bound to decisions, filters, and a stable cursor high-water', () => {
  const invalid = fixture('repeated-invalid-command.json');
  const decision = gateDecision(invalid.input, [invalid.rule]);
  const root = mkdtempSync(join(tmpdir(), 'ael-m2-override-'));
  const first = new OverrideStore(join(root, 'override.sqlite'));
  const second = new OverrideStore(join(root, 'override.sqlite'));
  const grant = createRuntimeOverride({
    id: 'acceptance-grant', scope: { kind: 'action', signature: invalid.input.signature as RuntimeRule['signature'] & { kind: 'action' } },
    reason: 'Reviewed exception.', createdAt: now
  });
  const applied = applyRuntimeOverride({ decision, input: invalid.input, override: grant, now });
  assert.equal(applied.accepted, true);
  assert.equal(applied.decision.outcome, 'ALLOW');
  assert.equal(applyRuntimeOverride({
    decision, input: { ...invalid.input, repositoryId: 'another-repository' }, override: grant, now
  }).rejection, 'INPUT_MISMATCH');
  const appendSuccess = (store: OverrideStore, ruleId: string, suffix: string) => {
    const references = [{ ruleId, knowledgeId: `knowledge-${ruleId}`, evidenceIds: [`evidence-${ruleId}`] }];
    const authorization: OverrideAuditEntry = {
      id: `auth-${ruleId}-${suffix}`, useId: `${ruleId}-${suffix}`, override: grant, phase: 'authorized', recordedAt: now, decisionReferences: references
    };
    store.append(authorization);
    store.append({ ...authorization, id: `done-${ruleId}-${suffix}`, phase: 'completed', recordedAt: '2026-08-25T10:01:00.000Z', postActionOutcome: 'succeeded' });
  };
  for (const ruleId of ['rule-b', 'rule-c']) for (const suffix of ['1', '2']) appendSuccess(first, ruleId, suffix);
  const firstPage = first.deriveLearningEvidencePage({ overrideId: grant.id, limit: 1 });
  assert.deepEqual(firstPage.entries.map(({ ruleId }) => ruleId), ['rule-b']);
  assert.notEqual(firstPage.nextCursor, undefined);
  for (const suffix of ['1', '2']) appendSuccess(second, 'rule-a', suffix);
  appendSuccess(second, 'rule-c', '3');
  const nextPage = first.deriveLearningEvidencePage({ overrideId: grant.id, cursor: firstPage.nextCursor, limit: 10 });
  assert.deepEqual(nextPage.entries.map(({ ruleId, successfulUseCount }) => [ruleId, successfulUseCount]), [['rule-c', 2]]);
  assert.throws(() => first.deriveLearningEvidencePage({ overrideId: 'different', cursor: firstPage.nextCursor }), /cursor/i);
  assert.equal(decision.inputBinding.length, 64);
  first.close();
  second.close();
});

test('preflights production Git path and blob limits before materializing knowledge', () => {
  const blobRepository = mkdtempSync(join(tmpdir(), 'ael-m2-git-blob-'));
  initializeGitRepository(blobRepository);
  mkdirSync(join(blobRepository, 'agent-experience'), { recursive: true });
  writeFileSync(join(blobRepository, 'agent-experience', 'index.json'), 'x'.repeat(1_048_577));
  execFileSync('git', ['-C', blobRepository, 'add', 'agent-experience/index.json']);
  execFileSync('git', ['-C', blobRepository, 'commit', '--quiet', '-m', 'oversized blob']);
  const blobAdapter = createLocalGitContentAdapter(blobRepository);
  const blobCommit = blobAdapter.resolveCommit('HEAD');
  assert.throws(() => blobAdapter.readFile(blobCommit, 'agent-experience/index.json', 1_048_576), /resource limit/i);

  const pathRepository = mkdtempSync(join(tmpdir(), 'ael-m2-git-paths-'));
  initializeGitRepository(pathRepository);
  const knowledge = join(pathRepository, 'agent-experience', 'knowledge');
  mkdirSync(knowledge, { recursive: true });
  for (let index = 0; index < 1_003; index += 1) writeFileSync(join(knowledge, `${String(index).padStart(4, '0')}.md`), 'x');
  execFileSync('git', ['-C', pathRepository, 'add', 'agent-experience']);
  execFileSync('git', ['-C', pathRepository, 'commit', '--quiet', '-m', 'too many paths']);
  const pathAdapter = createLocalGitContentAdapter(pathRepository);
  const pathCommit = pathAdapter.resolveCommit('HEAD');
  assert.throws(() => pathAdapter.listFiles(pathCommit, 'agent-experience/', 1_002), /path limit/i);
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

function inputForSignature(signature: RuntimeSignature): RuntimeInput {
  return signature.kind === 'action'
    ? { repositoryId: 'repo-acceptance', operationClass: 'protected', signature }
    : { repositoryId: 'repo-acceptance', operationClass: 'protected', signature };
}
