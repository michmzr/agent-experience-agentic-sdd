import type { AgentSource } from '../domain/types.js';

export type SessionArtifactFormat = 'observed-jsonl' | 'jsonl' | 'markdown-export';

export const MAX_SESSION_ARTIFACT_BYTES = 1024 * 1024;
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
  readonly updatedAt?: string;
}

export interface LocalSessionRecord {
  readonly kind: string;
  readonly occurredAt: string;
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
}

export interface NormalizeSessionInput {
  readonly source: AgentSource;
  readonly artifact: SessionArtifact;
  readonly records: readonly LocalSessionRecord[];
}

export function normalizeSession(input: NormalizeSessionInput): NormalizedSession {
  if (input.records.length === 0) throw new Error('A session must contain at least one supported record.');
  if (input.records.length > MAX_NORMALIZED_SESSION_EVENTS) throw new Error('Session resource limit exceeded.');
  let textLength = 0;
  for (const record of input.records) {
    if (typeof record.text === 'string') textLength += record.text.length;
    if (textLength > MAX_SESSION_REVIEW_TEXT_LENGTH) throw new Error('Session resource limit exceeded.');
  }
  const events = input.records.map((record, index) => normalizeRecord(input.artifact.id, record, index));
  return {
    source: input.source,
    sessionId: input.artifact.id,
    ...(input.artifact.repositoryHint ? { repositoryHint: input.artifact.repositoryHint } : {}),
    startedAt: events[0].occurredAt,
    endedAt: events[events.length - 1].occurredAt,
    events
  };
}

function normalizeRecord(sessionId: string, record: LocalSessionRecord, index: number): NormalizedSessionEvent {
  if (!['tool', 'message', 'metadata'].includes(record.kind)) throw new Error('Unsupported session record.');
  if (!Number.isFinite(Date.parse(record.occurredAt))) throw new Error('Session record timestamp is invalid.');
  if (record.text !== undefined && typeof record.text !== 'string') throw new Error('Session record text is invalid.');
  const outcome = record.exitStatus === undefined ? 'unknown' : record.exitStatus === 0 ? 'passed' : 'failed';
  const text = record.text?.trim();
  return {
    id: `${sessionId}:${index}`,
    kind: record.kind as NormalizedSessionEvent['kind'],
    occurredAt: record.occurredAt,
    ...(record.tool ? { tool: record.tool } : {}),
    ...(record.exitStatus === undefined ? {} : { exitStatus: record.exitStatus }),
    ...(text ? { text } : {}),
    outcome
  };
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
