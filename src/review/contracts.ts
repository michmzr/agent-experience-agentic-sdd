import type { AgentSource } from '../domain/types.js';
import { freezeIngestionCoverage, type SessionIngestionCoverage } from './ingestion.js';

export type SessionArtifactFormat = 'observed-jsonl' | 'jsonl' | 'markdown-export';

export const MAX_SESSION_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_ARTIFACT_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_NORMALIZED_SESSION_EVENTS = 1024;
export const MAX_SESSION_REVIEW_TEXT_LENGTH = 256 * 1024;
export const MAX_SESSION_EVENT_TEXT_LENGTH = 4096;

export interface SessionArtifact {
  readonly source: AgentSource;
  readonly id: string;
  readonly location: string;
  readonly format: SessionArtifactFormat;
  readonly repositoryHint?: string;
  readonly repositoryHintVerified?: boolean;
  readonly repositoryIdentity?: string;
  readonly updatedAt?: string;
}

export interface LocalSessionRecord {
  readonly kind: string;
  readonly occurredAt: string;
  readonly sourceOrdinal?: number;
  readonly tool?: string;
  readonly exitStatus?: number;
  readonly text?: string;
  readonly payload?: unknown;
}

export interface NormalizedSessionEvent {
  readonly id: string;
  readonly kind: 'tool' | 'message' | 'metadata';
  readonly occurredAt: string;
  readonly tool?: string;
  readonly exitStatus?: number;
  readonly text?: string;
  readonly outcome: 'passed' | 'failed' | 'unknown';
}

export interface NormalizedSession {
  readonly source: AgentSource;
  readonly sessionId: string;
  readonly repositoryHint?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly events: readonly NormalizedSessionEvent[];
  readonly ingestionCoverage: SessionIngestionCoverage;
}

export interface NormalizeSessionInput {
  readonly source: AgentSource;
  readonly artifact: SessionArtifact;
  readonly records: readonly LocalSessionRecord[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly ingestionCoverage?: SessionIngestionCoverage;
}

export function normalizeSession(input: NormalizeSessionInput): NormalizedSession {
  if (input.records.length === 0) throw new Error('A session must contain at least one supported record.');
  if (input.records.length > MAX_NORMALIZED_SESSION_EVENTS) throw new Error('Session resource limit exceeded.');
  let textBytes = 0;
  for (const record of input.records) {
    if (typeof record.text === 'string') textBytes += Buffer.byteLength(record.text, 'utf8');
    if (textBytes > MAX_SESSION_REVIEW_TEXT_LENGTH) throw new Error('Session resource limit exceeded.');
  }
  const hasStartedAt = input.startedAt !== undefined;
  const hasEndedAt = input.endedAt !== undefined;
  if (hasStartedAt !== hasEndedAt) throw new Error('Session bounds must include both timestamps.');
  const events = input.records.map((record, index) => normalizeRecord(input.artifact.id, record, index));
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.id)) throw new Error('Session record ordinal is duplicated.');
    eventIds.add(event.id);
  }
  const suppliedBounds = hasStartedAt && hasEndedAt
    ? validateSessionBounds(input.startedAt!, input.endedAt!, events)
    : undefined;
  const ingestionCoverage = freezeIngestionCoverage(input.ingestionCoverage ?? completeIngestionCoverage(input.records.length));
  return {
    source: input.source,
    sessionId: input.artifact.id,
    ...(input.artifact.repositoryHint ? { repositoryHint: input.artifact.repositoryHint } : {}),
    startedAt: suppliedBounds?.startedAt ?? events[0].occurredAt,
    endedAt: suppliedBounds?.endedAt ?? events[events.length - 1].occurredAt,
    events,
    ingestionCoverage
  };
}

function completeIngestionCoverage(recordCount: number): SessionIngestionCoverage {
  return {
    totalRecords: recordCount,
    normalizedRecords: recordCount,
    skippedTechnicalRecords: 0,
    unsupportedRecords: 0,
    truncatedTextFields: 0,
    omittedStructuredOutputs: 0,
    usedStreamingProjection: false
  };
}

function normalizeRecord(sessionId: string, record: LocalSessionRecord, index: number): NormalizedSessionEvent {
  if (!['tool', 'message', 'metadata'].includes(record.kind)) throw new Error('Unsupported session record.');
  assertCanonicalTimestamp(record.occurredAt, 'Session record timestamp is invalid.');
  if (record.sourceOrdinal !== undefined && (!Number.isSafeInteger(record.sourceOrdinal) || record.sourceOrdinal < 0)) {
    throw new Error('Session record ordinal is invalid.');
  }
  if (record.text !== undefined && typeof record.text !== 'string') throw new Error('Session record text is invalid.');
  const outcome = record.exitStatus === undefined ? 'unknown' : record.exitStatus === 0 ? 'passed' : 'failed';
  const text = record.text?.trim();
  return {
    id: `${sessionId}:${record.sourceOrdinal ?? index}`,
    kind: record.kind as NormalizedSessionEvent['kind'],
    occurredAt: record.occurredAt,
    ...(record.tool ? { tool: record.tool } : {}),
    ...(record.exitStatus === undefined ? {} : { exitStatus: record.exitStatus }),
    ...(text ? { text } : {}),
    outcome
  };
}

function validateSessionBounds(startedAt: string, endedAt: string, events: readonly NormalizedSessionEvent[]): { readonly startedAt: string; readonly endedAt: string } {
  const startedAtMillis = assertCanonicalTimestamp(startedAt, 'Session bounds are invalid.');
  const endedAtMillis = assertCanonicalTimestamp(endedAt, 'Session bounds are invalid.');
  if (endedAtMillis < startedAtMillis) throw new Error('Session bounds are invalid.');
  for (const event of events) {
    const occurredAtMillis = Date.parse(event.occurredAt);
    if (occurredAtMillis < startedAtMillis || occurredAtMillis > endedAtMillis) throw new Error('Session bounds do not contain all retained events.');
  }
  return { startedAt, endedAt };
}

function assertCanonicalTimestamp(value: string, message: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(message);
  return milliseconds;
}

export function assertSessionArtifactSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_SESSION_ARTIFACT_BYTES) {
    throw new Error('Session artifact resource limit exceeded.');
  }
}

export function selectSessionArtifact(artifacts: readonly SessionArtifact[], options: { readonly interactive: boolean; readonly artifactId?: string }): SessionArtifact {
  if (options.artifactId) {
    const selected = artifacts.find((artifact) => artifact.id === options.artifactId);
    if (!selected) throw new Error('Selected session artifact was not found.');
    return selected;
  }
  if (!options.interactive) throw new Error('An explicit session artifact is required in non-interactive mode.');
  if (artifacts.length !== 1) throw new Error('Interactive session selection requires exactly one artifact.');
  return artifacts[0];
}
