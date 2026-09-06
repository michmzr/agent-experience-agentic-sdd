import { createHash } from 'node:crypto';

import {
  MAX_SESSION_EVIDENCE_OBSERVATIONS,
  SESSION_EVIDENCE_SCHEMA_VERSION,
  type EvidenceObservation,
  type SessionEvidenceInput,
  type SessionEvidenceMetrics,
  type SessionEvidenceReport,
  type SessionLifecycleState,
  type SessionOperation,
  type TransportMeasurement,
  type UsageSnapshot
} from './contracts.js';

const identifierPattern = /^[A-Za-z0-9._:/-]{1,512}$/;
const observationKeys = new Set(['id', 'sourceEventId', 'kind', 'occurredAt', 'relatedEventId', 'tool', 'outcome', 'exitStatus', 'endedAt']);
const usageKeys = new Set(['id', 'occurredAt', 'mode', 'scope', 'lineageId', 'parentLineageId', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'analysisTokens']);
const transportKeys = new Set(['id', 'capturedAt', 'admittedAt', 'committedAt', 'hookDurationMs']);
const inputKeys = new Set(['schemaVersion', 'source', 'sessionId', 'startedAt', 'sourceEndedAt', 'observedThrough', 'reconciliation', 'observations', 'usageSnapshots', 'transportMeasurements', 'coverage']);
const reconciliationKeys = new Set(['attempted', 'expectedThrough', 'committedThrough']);
const coverageKeys = new Set(['supportedClasses', 'skippedClasses', 'unsupportedClasses', 'truncatedObservations', 'synthetic']);

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
  if (durationMs !== undefined && durationMs < 0) throw new TypeError('Result timestamp cannot precede its related request.');
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
  const hookDurations = (input.transportMeasurements ?? []).flatMap(({ hookDurationMs }) => hookDurationMs === undefined ? [] : [hookDurationMs]);
  const spoolLags = (input.transportMeasurements ?? []).flatMap((item) => item.committedAt === undefined ? [] : [Date.parse(item.committedAt) - Date.parse(item.capturedAt)]);
  const tokenUsage = aggregateUsage(input.usageSnapshots ?? []);
  return Object.freeze({
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(operations.some(({ durationMs }) => durationMs !== undefined)
      ? { activeOperationMs: unionDuration(operations.flatMap((item) => item.endedAt === undefined ? [] : [[Date.parse(item.startedAt), Date.parse(item.endedAt)] as const])) }
      : {}),
    ...(waits.length === 0 ? {} : { observedWaitingMs: unionDuration(waits.map((item) => [Date.parse(item.occurredAt), Date.parse(item.endedAt!)] as const)) }),
    ...(hookDurations.length === 0 ? {} : { hookDurationMs: distribution(hookDurations) }),
    ...(spoolLags.length === 0 ? {} : { spoolLagMs: distribution(spoolLags) }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
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
  const bySourceEvent = new Map<string, EvidenceObservation>();
  for (const observation of [...byId.values()].sort(compareObservation)) {
    const key = `${observation.kind}\0${observation.sourceEventId}`;
    const existing = bySourceEvent.get(key);
    if (existing === undefined) {
      bySourceEvent.set(key, observation);
      continue;
    }
    const { id: _existingId, ...existingEvidence } = existing;
    const { id: _observationId, ...observationEvidence } = observation;
    if (JSON.stringify(existingEvidence) !== JSON.stringify(observationEvidence)) throw new TypeError('Conflicting duplicate source-event identity.');
    duplicateCount += 1;
  }
  return { observations: [...bySourceEvent.values()], duplicateCount };
}

function validateInput(input: SessionEvidenceInput): void {
  if (!input || typeof input !== 'object' || input.schemaVersion !== SESSION_EVIDENCE_SCHEMA_VERSION) throw new TypeError('Unsupported session evidence schema version.');
  const unexpected = Object.keys(input).find((key) => !inputKeys.has(key));
  if (unexpected !== undefined) throw new TypeError(`Unsupported session evidence field: ${unexpected}.`);
  if (!['codex', 'claude-code', 'cursor'].includes(input.source)) throw new TypeError('Session evidence source is invalid.');
  assertIdentifier(input.sessionId, 'Session identity');
  const startedAt = canonicalTimestamp(input.startedAt, 'Session start timestamp');
  const sourceEndedAt = input.sourceEndedAt === undefined ? undefined : canonicalTimestamp(input.sourceEndedAt, 'Source end timestamp');
  if (sourceEndedAt !== undefined && sourceEndedAt < startedAt) throw new TypeError('Source end cannot precede session start.');
  if (!Array.isArray(input.observations) || input.observations.length > MAX_SESSION_EVIDENCE_OBSERVATIONS) throw new TypeError('Session evidence observation limit exceeded.');
  if (input.observedThrough !== undefined) canonicalTimestamp(input.observedThrough, 'Observed-through timestamp');
  if (input.usageSnapshots !== undefined) {
    if (!Array.isArray(input.usageSnapshots) || input.usageSnapshots.length > MAX_SESSION_EVIDENCE_OBSERVATIONS) throw new TypeError('Usage snapshot limit exceeded.');
    validateUniqueRecords(input.usageSnapshots, validateUsage, 'usage snapshot');
  }
  if (input.transportMeasurements !== undefined) {
    if (!Array.isArray(input.transportMeasurements) || input.transportMeasurements.length > MAX_SESSION_EVIDENCE_OBSERVATIONS) throw new TypeError('Transport measurement limit exceeded.');
    validateUniqueRecords(input.transportMeasurements, validateTransport, 'transport measurement');
  }
  if (input.coverage?.truncatedObservations !== undefined && (!Number.isSafeInteger(input.coverage.truncatedObservations) || input.coverage.truncatedObservations < 0)) {
    throw new TypeError('Truncated observation count is invalid.');
  }
  const reconciliation = input.reconciliation;
  if (reconciliation !== undefined) {
    assertAllowedObject(reconciliation, reconciliationKeys, 'reconciliation evidence');
    if (typeof reconciliation.attempted !== 'boolean') throw new TypeError('Reconciliation evidence is invalid.');
    for (const value of [reconciliation.expectedThrough, reconciliation.committedThrough]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError('Reconciliation bound is invalid.');
    }
    if (reconciliation.committedThrough !== undefined && reconciliation.expectedThrough !== undefined && reconciliation.committedThrough > reconciliation.expectedThrough) {
      throw new TypeError('Committed reconciliation bound exceeds expected bound.');
    }
  }
  if (input.coverage !== undefined) {
    assertAllowedObject(input.coverage, coverageKeys, 'coverage evidence');
    if (input.coverage.synthetic !== undefined && typeof input.coverage.synthetic !== 'boolean') throw new TypeError('Coverage synthetic label is invalid.');
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
  if (value.tool !== undefined) assertIdentifier(value.tool, 'Evidence tool');
  if (value.relatedEventId === value.sourceEventId) throw new TypeError('Related request identity cannot reference the evidence itself.');
  if ((value.kind === 'result' || value.kind === 'task-verification') && value.relatedEventId === undefined) throw new TypeError('Result evidence requires a related request identity.');
  if (value.kind === 'request' && value.relatedEventId !== undefined) throw new TypeError('Request evidence cannot relate to another request.');
  if (value.outcome !== undefined && !['succeeded', 'failed', 'unknown'].includes(value.outcome)) throw new TypeError('Evidence outcome is invalid.');
  if (value.exitStatus !== undefined && (!Number.isSafeInteger(value.exitStatus) || value.kind !== 'result')) throw new TypeError('Evidence exit status is invalid.');
  if (value.kind === 'result' && value.exitStatus !== undefined && value.outcome !== undefined && value.outcome !== 'unknown') {
    const exitOutcome = value.exitStatus === 0 ? 'succeeded' : 'failed';
    if (value.outcome !== exitOutcome) throw new TypeError('Evidence exit status conflicts with its outcome.');
  }
  if (value.endedAt !== undefined) {
    const endedAt = canonicalTimestamp(value.endedAt, 'Evidence end timestamp');
    if (value.kind !== 'human-wait' || endedAt < occurredAt) throw new TypeError('Observed waiting interval is invalid.');
  }
}

function validateUsage(value: UsageSnapshot): void {
  assertAllowedObject(value, usageKeys, 'usage snapshot');
  assertIdentifier(value.id, 'Usage snapshot identity');
  assertIdentifier(value.lineageId, 'Usage lineage identity');
  if (value.parentLineageId !== undefined) assertIdentifier(value.parentLineageId, 'Parent usage lineage identity');
  canonicalTimestamp(value.occurredAt, 'Usage snapshot timestamp');
  if (!['delta', 'cumulative'].includes(value.mode) || !['session', 'subagent'].includes(value.scope)) throw new TypeError('Usage snapshot mode or scope is invalid.');
  for (const amount of [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.analysisTokens]) {
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) throw new TypeError('Usage token count is invalid.');
  }
  if (value.cacheReadTokens !== undefined && value.inputTokens !== undefined && value.cacheReadTokens > value.inputTokens) {
    throw new TypeError('Cache-read tokens cannot exceed input tokens.');
  }
}

function validateTransport(value: TransportMeasurement): void {
  assertAllowedObject(value, transportKeys, 'transport measurement');
  assertIdentifier(value.id, 'Transport measurement identity');
  const capturedAt = canonicalTimestamp(value.capturedAt, 'Capture timestamp');
  const admittedAt = value.admittedAt === undefined ? undefined : canonicalTimestamp(value.admittedAt, 'Admission timestamp');
  const committedAt = value.committedAt === undefined ? undefined : canonicalTimestamp(value.committedAt, 'Commit timestamp');
  if (admittedAt !== undefined && admittedAt < capturedAt) throw new TypeError('Admission timestamp cannot precede capture.');
  if (committedAt !== undefined && committedAt < (admittedAt ?? capturedAt)) throw new TypeError('Commit timestamp cannot precede admission.');
  if (value.hookDurationMs !== undefined && (!Number.isFinite(value.hookDurationMs) || value.hookDurationMs < 0)) throw new TypeError('Hook duration is invalid.');
}

function validateUniqueRecords<T extends { readonly id: string }>(values: readonly T[], validate: (value: T) => void, label: string): void {
  const records = new Map<string, string>();
  for (const value of values) {
    validate(value);
    const serialized = JSON.stringify(value);
    const existing = records.get(value.id);
    if (existing !== undefined && existing !== serialized) throw new TypeError(`Conflicting duplicate ${label} identity.`);
    records.set(value.id, serialized);
  }
}

function assertAllowedObject(value: unknown, keys: ReadonlySet<string>, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const unexpected = Object.keys(value).find((key) => !keys.has(key));
  if (unexpected !== undefined) throw new TypeError(`Unsupported ${label} field: ${unexpected}.`);
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

function distribution(values: readonly number[]): { readonly count: number; readonly total: number; readonly max: number } {
  return Object.freeze({ count: values.length, total: values.reduce((sum, value) => sum + value, 0), max: Math.max(...values) });
}

function aggregateUsage(snapshots: readonly UsageSnapshot[]): SessionEvidenceMetrics['tokenUsage'] {
  if (snapshots.length === 0) return undefined;
  const selectedScope = snapshots.some(({ scope }) => scope === 'session') ? 'session' : 'subagent';
  const selected = snapshots.filter(({ scope }) => scope === selectedScope);
  const byLineage = new Map<string, UsageSnapshot[]>();
  for (const snapshot of selected) {
    const values = byLineage.get(snapshot.lineageId) ?? [];
    values.push(snapshot);
    byLineage.set(snapshot.lineageId, values);
  }
  const totals: Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'analysisTokens', number | undefined> = {
    inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, analysisTokens: undefined
  };
  for (const lineage of byLineage.values()) {
    const modes = new Set(lineage.map(({ mode }) => mode));
    if (modes.size !== 1) throw new TypeError('Usage lineage mixes cumulative and delta snapshots.');
    const ordered = [...lineage].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    if (lineage[0]!.mode === 'cumulative') assertMonotonicCumulativeUsage(ordered);
    const values = lineage[0]!.mode === 'cumulative'
      ? [ordered.at(-1)!]
      : lineage;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'analysisTokens'] as const) {
      const supplied = values.flatMap((value) => value[field] === undefined ? [] : [value[field]]);
      if (supplied.length > 0) totals[field] = (totals[field] ?? 0) + supplied.reduce((sum, value) => sum + value, 0);
    }
  }
  if (Object.values(totals).every((value) => value === undefined)) return undefined;
  return Object.freeze({
    ...(totals.inputTokens === undefined ? {} : { inputTokens: totals.inputTokens }),
    ...(totals.outputTokens === undefined ? {} : { outputTokens: totals.outputTokens }),
    ...(totals.cacheReadTokens === undefined ? {} : { cacheReadTokens: totals.cacheReadTokens }),
    ...(totals.analysisTokens === undefined ? {} : { analysisTokens: totals.analysisTokens }),
    source: 'source-provided'
  });
}

function assertMonotonicCumulativeUsage(values: readonly UsageSnapshot[]): void {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'analysisTokens'] as const) {
    let previous: number | undefined;
    for (const value of values) {
      const current = value[field];
      if (current === undefined) continue;
      if (previous !== undefined && current < previous) throw new TypeError('Cumulative usage counters cannot decrease.');
      previous = current;
    }
  }
}
