import type { AgentSource } from '../domain/types.js';

export type SessionArtifactFormat = 'observed-jsonl' | 'jsonl' | 'markdown-export';

export interface SessionArtifact {
  readonly id: string;
  readonly location: string;
  readonly format: SessionArtifactFormat;
  readonly repositoryHint?: string;
}

export interface LocalSessionRecord {
  readonly kind: string;
  readonly occurredAt: string;
  readonly tool?: string;
  readonly exitStatus?: number;
  readonly payload?: unknown;
}

export interface NormalizedSessionEvent {
  readonly id: string;
  readonly kind: 'tool' | 'message' | 'metadata';
  readonly occurredAt: string;
  readonly tool?: string;
  readonly exitStatus?: number;
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
  const outcome = record.exitStatus === undefined ? 'unknown' : record.exitStatus === 0 ? 'passed' : 'failed';
  return {
    id: `${sessionId}:${index}`,
    kind: record.kind as NormalizedSessionEvent['kind'],
    occurredAt: record.occurredAt,
    ...(record.tool ? { tool: record.tool } : {}),
    ...(record.exitStatus === undefined ? {} : { exitStatus: record.exitStatus }),
    outcome
  };
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
