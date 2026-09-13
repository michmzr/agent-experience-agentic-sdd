import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { CapturedEventRecord } from '../src/capture/contracts.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { emptyDetectorCheckpoint, validateDetectorCheckpoint } from '../src/learning/contracts.js';
import { detectOperationalEpisodes } from '../src/learning/detectors.js';
import { readProjectToolConventions } from '../src/learning/project-conventions.js';

const at = (second: number) => `2026-09-08T10:00:${String(second).padStart(2, '0')}.000Z`;

function event(input: {
  readonly id: string;
  readonly phase: 'pre-action' | 'post-result';
  readonly action: string;
  readonly arguments?: readonly string[];
  readonly outcome?: 'succeeded' | 'failed' | 'unknown';
  readonly relatedEventId?: string;
  readonly second: number;
  readonly sessionId?: string;
}): CapturedEventRecord {
  return normalizeMappedCapture({
    source: 'codex',
    sourceEventId: input.id,
    sessionId: input.sessionId ?? 'session-1',
    phase: input.phase,
    occurredAt: at(input.second),
    tool: 'shell',
    action: input.action,
    ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
    summary: 'Sanitized capture.',
    ...(input.phase === 'post-result' ? { outcome: input.outcome!, relatedEventId: input.relatedEventId!, exitStatus: input.outcome === 'succeeded' ? 0 : 1 } : {})
  });
}

test('reads only explicit root-scoped pnpm and uv conventions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-learning-conventions-'));
  writeFileSync(join(root, 'AGENTS.md'), 'Use pnpm instead of npm.\nUse uv instead of pip.\n');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'AGENTS.md'), 'Use npm instead of pnpm.\n');

  assert.deepEqual(readProjectToolConventions(root).map(({ tool, replaces, source }) => ({ tool, replaces, source })), [
    { tool: 'pnpm', replaces: 'npm', source: 'AGENTS.md:1' },
    { tool: 'uv', replaces: 'pip', source: 'AGENTS.md:2' }
  ]);
});

test('creates a repository-scoped convention candidate from explicit project evidence', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', events: [],
    conventions: [{ tool: 'pnpm', replaces: 'npm', source: 'AGENTS.md:1', digest: 'a'.repeat(64) }]
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.kind, 'convention');
  assert.deepEqual(result.candidates[0]?.conditions, ['repository:repo-1', 'when a Node package command is required']);
  assert.equal(result.episodes[0]?.repositoryId, 'repo-1');
});

test('records a repaired command as outcome-observed without source-declared task verification', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [
      event({ id: 'npm-request', phase: 'pre-action', action: 'npm', arguments: ['install'], second: 1 }),
      event({ id: 'npm-result', phase: 'post-result', action: 'npm', outcome: 'failed', relatedEventId: 'npm-request', second: 2 }),
      event({ id: 'pnpm-request', phase: 'pre-action', action: 'pnpm', arguments: ['install'], second: 3 }),
      event({ id: 'pnpm-result', phase: 'post-result', action: 'pnpm', outcome: 'succeeded', relatedEventId: 'pnpm-request', second: 4 }),
      event({ id: 'test-request', phase: 'pre-action', action: 'pnpm', arguments: ['test'], second: 5 }),
      event({ id: 'test-result', phase: 'post-result', action: 'pnpm', outcome: 'succeeded', relatedEventId: 'test-request', second: 6 })
    ]
  });

  assert.equal(result.episodes[0]?.state, 'outcome-observed');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.findings.some(({ kind }) => kind === 'ambiguous-repair'), true);
});

test('records ambiguity rather than a repair for unknown, unrelated or privilege-changing commands', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [
      event({ id: 'failed-request', phase: 'pre-action', action: 'npm', arguments: ['install'], second: 1 }),
      event({ id: 'failed-result', phase: 'post-result', action: 'npm', outcome: 'failed', relatedEventId: 'failed-request', second: 2 }),
      event({ id: 'unsafe-request', phase: 'pre-action', action: 'sudo', arguments: ['install'], second: 3 }),
      event({ id: 'unsafe-result', phase: 'post-result', action: 'sudo', outcome: 'succeeded', relatedEventId: 'unsafe-request', second: 4 }),
      event({ id: 'unrelated-request', phase: 'pre-action', action: 'git', arguments: ['status'], second: 5 }),
      event({ id: 'unrelated-result', phase: 'post-result', action: 'git', outcome: 'succeeded', relatedEventId: 'unrelated-request', second: 6 })
    ]
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.findings.some(({ kind }) => kind === 'ambiguous-repair'), true);
});

test('produces the same repair from two pages as from the complete input', () => {
  const events = [
    event({ id: 'failed-request', phase: 'pre-action', action: 'npm', arguments: ['install'], second: 1 }),
    event({ id: 'failed-result', phase: 'post-result', action: 'npm', outcome: 'failed', relatedEventId: 'failed-request', second: 2 }),
    event({ id: 'changed-request', phase: 'pre-action', action: 'pnpm', arguments: ['install'], second: 3 }),
    event({ id: 'changed-result', phase: 'post-result', action: 'pnpm', outcome: 'succeeded', relatedEventId: 'changed-request', second: 4 })
  ];
  const common = { repositoryId: 'repo-1', sessionId: 'session-1', conventions: [] };

  const complete = detectOperationalEpisodes({ ...common, events });
  const firstPage = detectOperationalEpisodes({ ...common, events: events.slice(0, 2) });
  const secondPage = detectOperationalEpisodes({ ...common, events: events.slice(2), checkpoint: firstPage.checkpoint });

  assert.deepEqual(firstPage.episodes, []);
  assert.deepEqual(firstPage.checkpoint.pendingEvents.map(({ sourceEventId }) => sourceEventId), ['failed-request', 'failed-result']);
  assert.deepEqual(secondPage, complete);
});

test('keeps an unmatched pre-action until its result and changed operation arrive on later pages', () => {
  const failedRequest = event({ id: 'failed-request', phase: 'pre-action', action: 'npm', arguments: ['install'], second: 1 });
  const failedResult = event({ id: 'failed-result', phase: 'post-result', action: 'npm', outcome: 'failed', relatedEventId: 'failed-request', second: 2 });
  const changedRequest = event({ id: 'changed-request', phase: 'pre-action', action: 'pnpm', arguments: ['install'], second: 3 });
  const changedResult = event({ id: 'changed-result', phase: 'post-result', action: 'pnpm', outcome: 'succeeded', relatedEventId: 'changed-request', second: 4 });
  const common = { repositoryId: 'repo-1', sessionId: 'session-1', conventions: [] };

  const firstPage = detectOperationalEpisodes({ ...common, events: [failedRequest] });
  const secondPage = detectOperationalEpisodes({ ...common, events: [failedResult], checkpoint: firstPage.checkpoint });
  const thirdPage = detectOperationalEpisodes({ ...common, events: [changedRequest, changedResult], checkpoint: secondPage.checkpoint });

  assert.deepEqual(firstPage.checkpoint.pendingEvents.map(({ sourceEventId }) => sourceEventId), ['failed-request']);
  assert.deepEqual(secondPage.checkpoint.pendingEvents.map(({ sourceEventId }) => sourceEventId), ['failed-request', 'failed-result']);
  assert.deepEqual(thirdPage, detectOperationalEpisodes({ ...common, events: [failedRequest, failedResult, changedRequest, changedResult] }));
});

test('validates checkpoint version, shape, scope, identities, bounds and private content', () => {
  const pending = event({ id: 'pending-request', phase: 'pre-action', action: 'pnpm', arguments: ['test'], second: 1 });
  const otherSession = event({ id: 'other-request', phase: 'pre-action', action: 'pnpm', arguments: ['test'], second: 1, sessionId: 'session-2' });
  const tooMany = Array.from({ length: 129 }, (_, index) => event({
    id: `pending-${index}`, phase: 'pre-action', action: 'pnpm', arguments: ['test'], second: 1
  }));

  assert.throws(() => validateDetectorCheckpoint({ version: 2, pendingEvents: [] }, 'session-1'), /checkpoint/i);
  assert.throws(() => validateDetectorCheckpoint({ version: 1 } as never, 'session-1'), /checkpoint/i);
  assert.throws(() => validateDetectorCheckpoint({ version: 1, pendingEvents: [null] } as never, 'session-1'), /capture|checkpoint/i);
  assert.throws(() => validateDetectorCheckpoint({ version: 1, pendingEvents: [otherSession] }, 'session-1'), /scope|session/i);
  assert.throws(() => validateDetectorCheckpoint({ version: 1, pendingEvents: [pending, pending] }, 'session-1'), /duplicate|identity/i);
  assert.throws(() => validateDetectorCheckpoint({ version: 1, pendingEvents: tooMany }, 'session-1'), /checkpoint/i);
  assert.throws(() => validateDetectorCheckpoint({
    version: 1,
    pendingEvents: [{ ...pending, summary: 'password=secret-value' }]
  }, 'session-1'), /private|credential/i);
});

test('returns deeply frozen checkpoints without mutating the caller value', () => {
  const pending = event({ id: 'pending-request', phase: 'pre-action', action: 'pnpm', arguments: ['test'], second: 1 });
  const input = { version: 1 as const, pendingEvents: [pending] };
  const before = structuredClone(input);

  const checkpoint = validateDetectorCheckpoint(input, 'session-1');
  const empty = emptyDetectorCheckpoint();

  assert.deepEqual(input, before);
  assert.notEqual(checkpoint, input);
  assert.equal(Object.isFrozen(checkpoint), true);
  assert.equal(Object.isFrozen(checkpoint.pendingEvents), true);
  assert.equal(Object.isFrozen(checkpoint.pendingEvents[0]), true);
  assert.equal(Object.isFrozen(checkpoint.pendingEvents[0]?.signature), true);
  assert.equal(Object.isFrozen(checkpoint.pendingEvents[0]?.signature.kind === 'action' ? checkpoint.pendingEvents[0].signature.arguments : undefined), true);
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(Object.isFrozen(empty.pendingEvents), true);
});

test('sorts checkpoint events stably and retains only the newest 128', () => {
  const events = Array.from({ length: 130 }, (_, index) => event({
    id: `pending-${String(index).padStart(3, '0')}`,
    phase: 'pre-action',
    action: 'pnpm',
    arguments: ['test'],
    second: index % 60
  })).reverse();

  const result = detectOperationalEpisodes({ repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events });
  const retained = result.checkpoint.pendingEvents;
  const sorted = [...retained].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));

  assert.equal(retained.length, 128);
  assert.deepEqual(retained, sorted);
  assert.deepEqual(retained, [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)).slice(-128));
});

test('keeps the optional checkpoint API compatible with an explicit empty checkpoint', () => {
  const input = {
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [],
    events: [event({ id: 'request', phase: 'pre-action', action: 'pnpm', arguments: ['test'], second: 1 })]
  };

  assert.deepEqual(detectOperationalEpisodes(input), detectOperationalEpisodes({ ...input, checkpoint: emptyDetectorCheckpoint() }));
});
