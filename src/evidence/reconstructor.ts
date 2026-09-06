import { createHash } from 'node:crypto';

import {
  MAX_SESSION_EVIDENCE_OBSERVATIONS,
  SESSION_EVIDENCE_SCHEMA_VERSION,
  type EvidenceObservation,
  type SessionEvidenceInput,
  type SessionEvidenceMetrics,
  type SessionEvidenceReport,
  type SessionLifecycleState,
  type SessionOperation
} from './contracts.js';

const identifierPattern = /^[A-Za-z0-9._:/-]{1,512}$/;
const observationKeys = new Set(['id', 'sourceEventId', 'kind', 'occurredAt', 'relatedEventId', 'tool', 'outcome', 'exitStatus', 'endedAt']);

export function reconstructSessionEvidence(input: SessionEvidenceInput): SessionEvidenceReport {
  validateInput(input);
  const { observations, duplicateCount } = uniqueObservations(input.observations);
  const requests = observations.filter((item) => item.kind === 'request').sort(compareObservation);
  const results = observations.filter((item) => item.kind === 'result').sort(compareObservation);
  const verifications = observations.filter((item) => item.kind === 'task-verification').sort(compareObservation);
  const usedEvidence = new Set<string>();
  const operations = requests.map((request) => operationFrom(request, results, verifications, usedEvidence, input));
  const unmatchedEvidenceIds = observations
    .filter((item) => (item.kind === 'result' || item.kind === 'task-verification') && !usedEvidence.has(item.id))
    .map(({ id }) => id)
    .sort();
  const lifecycleState = lifecycle(input);
  const matchedResults = operations.filter(({ resultEvidenceId }) => resultEvidenceId !== undefined).length;

  return Object.freeze({
    schemaVersion: SESSION_EVIDENCE_SCHEMA_VERSION,
    source: input.source,
    sessionId: input.sessionId,
    lifecycle: Object.freeze({
      state: lifecycleState,
      ...(input.sourceEndedAt === undefined ? {} : { sourceEndedAt: input.sourceEndedAt }),
      ...(input.observedThrough === undefined ? {} : { observedThrough: input.observedThrough }),
      ...(input.reconciliation === undefined ? {} : { reconciliation: Object.freeze({ ...input.reconciliation }) })
    }),
    operations: Object.freeze(operations),
    unmatchedEvidenceIds: Object.freeze(unmatchedEvidenceIds),
    metrics: metrics(input, operations, observations),
    coverage: Object.freeze({
      retainedObservations: observations.length,
      duplicateObservations: duplicateCount,
      matchedResults,
      unmatchedResults: results.length - matchedResults,
      missingResults: operations.length - matchedResults,
      supportedClasses: Object.freeze(sortedUnique(input.coverage?.supportedClasses ?? [])),
      skippedClasses: Object.freeze(sortedUnique(input.coverage?.skippedClasses ?? [])),
      unsupportedClasses: Object.freeze(sortedUnique(input.coverage?.unsupportedClasses ?? [])),
      truncatedObservations: input.coverage?.truncatedObservations ?? 0,
      synthetic: input.coverage?.synthetic ?? false
    })
  });
}

function operationFrom(
  request: EvidenceObservation,
  results: readonly EvidenceObservation[],
  verifications: readonly EvidenceObservation[],
  usedEvidence: Set<string>,
  input: SessionEvidenceInput
): SessionOperation {
  const result = results.find((candidate) => candidate.relatedEventId === request.sourceEventId && !usedEvidence.has(candidate.id));
  if (result !== undefined) usedEvidence.add(result.id);
  const relatedVerifications = verifications.filter((candidate) => candidate.relatedEventId === request.sourceEventId);
  for (const verification of relatedVerifications) usedEvidence.add(verification.id);
  const processOutcome: SessionOperation['processOutcome'] = result === undefined || result.outcome === undefined || result.outcome === 'unknown'
    ? 'unknown'
    : result.exitStatus !== undefined ? (result.exitStatus === 0 ? 'succeeded' : 'failed') : result.outcome;
  const taskOutcome = relatedVerifications.some(({ outcome }) => outcome === 'failed')
    ? 'failed'
    : relatedVerifications.length > 0 && relatedVerifications.every(({ outcome }) => outcome === 'succeeded') ? 'succeeded' : 'unknown';
  const outcome = processOutcome === 'failed'
    ? 'command-failed'
    : taskOutcome === 'failed' ? 'task-verification-failed'
    : processOutcome === 'succeeded' ? 'process-succeeded' : 'unknown';
  const durationMs = result === undefined ? undefined : Date.parse(result.occurredAt) - Date.parse(request.occurredAt);
  return Object.freeze({
    id: operationId(input.source, input.sessionId, request.sourceEventId),
    requestEvidenceId: request.id,
    requestSourceEventId: request.sourceEventId,
    ...(result === undefined ? {} : { resultEvidenceId: result.id }),
    ...(relatedVerifications.length === 0 ? {} : { verificationEvidenceIds: Object.freeze(relatedVerifications.map(({ id }) => id)) }),
    ...(request.tool === undefined ? {} : { tool: request.tool }),
    startedAt: request.occurredAt,
    ...(result === undefined ? {} : { endedAt: result.occurredAt, durationMs }),
    processOutcome,
    taskOutcome,
    outcome
  });
}

function lifecycle(input: SessionEvidenceInput): SessionLifecycleState {
  if (input.sourceEndedAt !== undefined) {
    const { reconciliation } = input;
    if (reconciliation?.attempted === true
      && reconciliation.expectedThrough !== undefined
      && reconciliation.committedThrough === reconciliation.expectedThrough) return 'reconciled-complete';
    return 'source-ended';
  }
  return input.reconciliation?.attempted === true ? 'incomplete' : 'open';
}

function metrics(input: SessionEvidenceInput, operations: readonly SessionOperation[], observations: readonly EvidenceObservation[]): SessionEvidenceMetrics {
  const waits = observations.filter((item) => item.kind === 'human-wait' && item.endedAt !== undefined);
  const elapsedMs = input.sourceEndedAt === undefined ? undefined : Date.parse(input.sourceEndedAt) - Date.parse(input.startedAt);
  return Object.freeze({
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(operations.some(({ durationMs }) => durationMs !== undefined)
      ? { activeOperationMs: unionDuration(operations.flatMap((item) => item.endedAt === undefined ? [] : [[Date.parse(item.startedAt), Date.parse(item.endedAt)] as const])) }
      : {}),
    ...(waits.length === 0 ? {} : { observedWaitingMs: unionDuration(waits.map((item) => [Date.parse(item.occurredAt), Date.parse(item.endedAt!)] as const)) }),
    attribution: 'observed-boundaries-only'
  });
}

function uniqueObservations(observations: readonly EvidenceObservation[]): { observations: EvidenceObservation[]; duplicateCount: number } {
  const byId = new Map<string, EvidenceObservation>();
  let duplicateCount = 0;
  for (const observation of observations) {
    validateObservation(observation);
    const existing = byId.get(observation.id);
    if (existing === undefined) byId.set(observation.id, Object.freeze({ ...observation }));
    else if (JSON.stringify(existing) === JSON.stringify(observation)) duplicateCount += 1;
    else throw new TypeError('Conflicting duplicate evidence identity.');
  }
  return { observations: [...byId.values()], duplicateCount };
}

function validateInput(input: SessionEvidenceInput): void {
  if (!input || typeof input !== 'object' || input.schemaVersion !== SESSION_EVIDENCE_SCHEMA_VERSION) throw new TypeError('Unsupported session evidence schema version.');
  if (!['codex', 'claude-code', 'cursor'].includes(input.source)) throw new TypeError('Session evidence source is invalid.');
  assertIdentifier(input.sessionId, 'Session identity');
  const startedAt = canonicalTimestamp(input.startedAt, 'Session start timestamp');
  const sourceEndedAt = input.sourceEndedAt === undefined ? undefined : canonicalTimestamp(input.sourceEndedAt, 'Source end timestamp');
  if (sourceEndedAt !== undefined && sourceEndedAt < startedAt) throw new TypeError('Source end cannot precede session start.');
  if (!Array.isArray(input.observations) || input.observations.length > MAX_SESSION_EVIDENCE_OBSERVATIONS) throw new TypeError('Session evidence observation limit exceeded.');
  const reconciliation = input.reconciliation;
  if (reconciliation !== undefined) {
    if (typeof reconciliation.attempted !== 'boolean') throw new TypeError('Reconciliation evidence is invalid.');
    for (const value of [reconciliation.expectedThrough, reconciliation.committedThrough]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError('Reconciliation bound is invalid.');
    }
    if (reconciliation.committedThrough !== undefined && reconciliation.expectedThrough !== undefined && reconciliation.committedThrough > reconciliation.expectedThrough) {
      throw new TypeError('Committed reconciliation bound exceeds expected bound.');
    }
  }
}

function validateObservation(value: EvidenceObservation): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Evidence observation must be an object.');
  const unexpected = Object.keys(value).find((key) => !observationKeys.has(key));
  if (unexpected !== undefined) throw new TypeError(`Unsupported evidence observation field: ${unexpected}.`);
  assertIdentifier(value.id, 'Evidence identity');
  assertIdentifier(value.sourceEventId, 'Source event identity');
  if (!['request', 'result', 'task-verification', 'human-wait'].includes(value.kind)) throw new TypeError('Evidence observation kind is invalid.');
  const occurredAt = canonicalTimestamp(value.occurredAt, 'Evidence timestamp');
  if (value.relatedEventId !== undefined) assertIdentifier(value.relatedEventId, 'Related request identity');
  if (value.relatedEventId === value.sourceEventId) throw new TypeError('Related request identity cannot reference the evidence itself.');
  if ((value.kind === 'result' || value.kind === 'task-verification') && value.relatedEventId === undefined) throw new TypeError('Result evidence requires a related request identity.');
  if (value.kind === 'request' && value.relatedEventId !== undefined) throw new TypeError('Request evidence cannot relate to another request.');
  if (value.outcome !== undefined && !['succeeded', 'failed', 'unknown'].includes(value.outcome)) throw new TypeError('Evidence outcome is invalid.');
  if (value.exitStatus !== undefined && (!Number.isSafeInteger(value.exitStatus) || value.kind !== 'result')) throw new TypeError('Evidence exit status is invalid.');
  if (value.endedAt !== undefined) {
    const endedAt = canonicalTimestamp(value.endedAt, 'Evidence end timestamp');
    if (value.kind !== 'human-wait' || endedAt < occurredAt) throw new TypeError('Observed waiting interval is invalid.');
  }
}

function canonicalTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'string') throw new TypeError(`${label} is invalid.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new TypeError(`${label} is invalid.`);
  return milliseconds;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) throw new TypeError(`${label} is invalid.`);
}

function operationId(source: string, sessionId: string, requestId: string): string {
  return `op_${createHash('sha256').update(`${source}\0${sessionId}\0${requestId}`).digest('hex').slice(0, 24)}`;
}

function compareObservation(left: EvidenceObservation, right: EvidenceObservation): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.sourceEventId.localeCompare(right.sourceEventId) || left.id.localeCompare(right.id);
}

function sortedUnique(values: readonly string[]): string[] {
  for (const value of values) assertIdentifier(value, 'Coverage class');
  return [...new Set(values)].sort();
}

function unionDuration(intervals: readonly (readonly [number, number])[]): number {
  const ordered = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const [nextStart, nextEnd] of ordered) {
    if (start === undefined || end === undefined) { start = nextStart; end = nextEnd; continue; }
    if (nextStart > end) { total += end - start; start = nextStart; end = nextEnd; }
    else end = Math.max(end, nextEnd);
  }
  return total + (start === undefined || end === undefined ? 0 : end - start);
}
