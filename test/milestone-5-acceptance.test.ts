import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import type { SessionId } from '../src/domain/types.js';
import { projectCapturedSessionEvidence } from '../src/evidence/capture-projection.js';
import type { EvidenceObservation, SessionEvidenceInput } from '../src/evidence/contracts.js';
import { reconstructSessionEvidence } from '../src/evidence/reconstructor.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const startedAt = '2026-09-06T08:00:00.000Z';
const endedAt = '2026-09-06T08:10:00.000Z';

test('projects a stored capture session without retaining summaries or importing artifacts', () => {
  const session = { id: 'session-projection' as SessionId, source: 'codex' as const, startedAt, endedAt };
  const secretMarker = 'must-not-cross-projection';
  const events = [
    adaptCodexCapture({
      event_id: 'request-1', session_id: session.id, event_kind: 'pre_action', occurred_at: '2026-09-06T08:00:01.000Z',
      tool: 'shell', action: 'exec', arguments: ['status'], cwd: '/repo', summary: `summary ${secretMarker}`
    }),
    adaptCodexCapture({
      event_id: 'result-1', session_id: session.id, event_kind: 'post_result', occurred_at: '2026-09-06T08:00:02.000Z',
      tool: 'shell', action: 'exec', arguments: ['status'], cwd: '/repo', summary: `result ${secretMarker}`,
      related_event_id: 'request-1', outcome: 'succeeded', exit_status: 0
    })
  ];

  const projected = projectCapturedSessionEvidence({ session, events });
  assert.equal(projected.observations.length, 2);
  assert.equal(JSON.stringify(projected).includes(secretMarker), false);
  assert.deepEqual(reconstructSessionEvidence(projected).operations.map(({ outcome }) => outcome), ['process-succeeded']);
});

test('reports one selected stored session through the read-only CLI and preserves raw counters', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m5-cli-'));
  const path = join(dataDir, 'experience.sqlite');
  const session = { id: 'session-cli' as SessionId, source: 'codex' as const, startedAt };
  const store = new ExperienceStore(path);
  store.appendIncremental({
    session,
    event: adaptCodexCapture({
      event_id: 'request-cli', session_id: session.id, event_kind: 'pre_action', occurred_at: '2026-09-06T08:00:01.000Z',
      tool: 'git', action: 'status', cwd: '/repo', summary: 'Run status.'
    })
  });
  store.appendIncremental({
    event: adaptCodexCapture({
      event_id: 'result-cli', session_id: session.id, event_kind: 'post_result', occurred_at: '2026-09-06T08:00:02.000Z',
      tool: 'git', action: 'status', cwd: '/repo', summary: 'Status completed.',
      related_event_id: 'request-cli', outcome: 'succeeded', exit_status: 0
    })
  });
  store.endSession('codex', session.id, endedAt);
  const before = store.listCapturedEventsPage().entries.length;
  store.close();

  const first = runCli(['evidence', 'session', session.id, '--data-dir', dataDir, '--json']);
  assert.equal(first.exitCode, 0, first.stderr);
  const value = JSON.parse(first.stdout);
  assert.equal(value.version, 1);
  assert.equal(value.report.lifecycle.state, 'source-ended');
  assert.equal(value.report.operations[0].outcome, 'process-succeeded');
  assert.equal(value.report.metrics.tokenUsage, undefined);
  assert.equal(value.capabilities.correlation, 'explicit-reference');

  const repeated = JSON.parse(runCli(['evidence', 'session', session.id, '--data-dir', dataDir, '--json']).stdout);
  assert.equal(repeated.version, 1);
  const reopened = new ExperienceStore(path);
  assert.equal(reopened.listCapturedEventsPage().entries.length, before);
  reopened.close();
});

test('executes five labeled synthetic scenarios and changed-environment, missing-data and secret variants', () => {
  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'session-evidence', 'scenarios.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    synthetic: boolean;
    scenarios: Array<{ label: string; expectedOutcome?: string; expectedWaitingMs?: number; expectedInputTokens?: number }>;
    variants: Array<{ label: string; unsupportedClass?: string; usageAvailable?: boolean; rawOutput?: string }>;
  };
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.scenarios.length, 5);
  assert.deepEqual(fixture.scenarios.map(({ label }) => label), [
    'command-failure', 'process-success-task-failure', 'missing-result', 'explicit-human-wait', 'cumulative-usage'
  ]);

  const commandFailure = reconstructSessionEvidence(scenarioInput([
    request('request-1'), result('result-1', 'request-1', 'failed', 1)
  ]));
  assert.equal(commandFailure.operations[0]?.outcome, fixture.scenarios[0]?.expectedOutcome);
  const taskFailure = reconstructSessionEvidence(scenarioInput([
    request('request-1'), result('result-1', 'request-1', 'succeeded', 0),
    { id: 'verify-t', sourceEventId: 'verify-1', kind: 'task-verification', occurredAt: '2026-09-06T08:00:03.000Z', relatedEventId: 'request-1', outcome: 'failed' }
  ]));
  assert.equal(taskFailure.operations[0]?.outcome, fixture.scenarios[1]?.expectedOutcome);
  assert.equal(reconstructSessionEvidence(scenarioInput([request('request-1')])).operations[0]?.outcome, fixture.scenarios[2]?.expectedOutcome);
  const waiting = reconstructSessionEvidence(scenarioInput([
    { id: 'wait-t', sourceEventId: 'wait-1', kind: 'human-wait', occurredAt: '2026-09-06T08:00:10.000Z', endedAt: '2026-09-06T08:00:20.000Z' }
  ]));
  assert.equal(waiting.metrics.observedWaitingMs, fixture.scenarios[3]?.expectedWaitingMs);
  const usage = reconstructSessionEvidence({
    ...scenarioInput([]),
    usageSnapshots: [
      { id: 'u1', occurredAt: '2026-09-06T08:00:10.000Z', mode: 'cumulative', scope: 'session', lineageId: 'root', inputTokens: 100 },
      { id: 'u2', occurredAt: '2026-09-06T08:00:20.000Z', mode: 'cumulative', scope: 'session', lineageId: 'root', inputTokens: 150 }
    ]
  });
  assert.equal(usage.metrics.tokenUsage?.inputTokens, fixture.scenarios[4]?.expectedInputTokens);

  const changed = reconstructSessionEvidence({ ...scenarioInput([]), coverage: { unsupportedClasses: [fixture.variants[0]!.unsupportedClass!], synthetic: true } });
  assert.deepEqual(changed.coverage.unsupportedClasses, ['environment-snapshot']);
  assert.equal(reconstructSessionEvidence(scenarioInput([])).metrics.tokenUsage, undefined);
  const secretVariant = fixture.variants[2]!.rawOutput!;
  assert.throws(() => reconstructSessionEvidence(scenarioInput([{
    ...request('request-secret'), rawOutput: secretVariant
  } as never])), (error: unknown) => error instanceof Error && !error.message.includes(secretVariant));
});

function scenarioInput(observations: readonly EvidenceObservation[]): SessionEvidenceInput {
  return {
    schemaVersion: 1 as const, source: 'codex' as const, sessionId: 'scenario-session', startedAt,
    sourceEndedAt: endedAt, observations, coverage: { synthetic: true }
  };
}

function request(sourceEventId: string): EvidenceObservation {
  return { id: `${sourceEventId}-transport`, sourceEventId, kind: 'request', occurredAt: '2026-09-06T08:00:01.000Z' };
}

function result(sourceEventId: string, relatedEventId: string, outcome: 'succeeded' | 'failed', exitStatus: number): EvidenceObservation {
  return { id: `${sourceEventId}-transport`, sourceEventId, kind: 'result', occurredAt: '2026-09-06T08:00:02.000Z', relatedEventId, outcome, exitStatus };
}
