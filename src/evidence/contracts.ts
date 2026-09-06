import type { AgentSource } from '../domain/types.js';

export const SESSION_EVIDENCE_SCHEMA_VERSION = 1;
export const MAX_SESSION_EVIDENCE_OBSERVATIONS = 10_000;

export type SessionLifecycleState = 'open' | 'source-ended' | 'reconciled-complete' | 'incomplete';
export type OperationOutcome = 'process-succeeded' | 'command-failed' | 'task-verification-failed' | 'unknown';
export type EvidenceObservationKind = 'request' | 'result' | 'task-verification' | 'human-wait';

export interface EvidenceObservation {
  readonly id: string;
  readonly sourceEventId: string;
  readonly kind: EvidenceObservationKind;
  readonly occurredAt: string;
  readonly relatedEventId?: string;
  readonly tool?: string;
  readonly outcome?: 'succeeded' | 'failed' | 'unknown';
  readonly exitStatus?: number;
  readonly endedAt?: string;
}

export interface ReconciliationEvidence {
  readonly attempted: boolean;
  readonly expectedThrough?: number;
  readonly committedThrough?: number;
}

export interface UsageSnapshot {
  readonly id: string;
  readonly occurredAt: string;
  readonly mode: 'delta' | 'cumulative';
  readonly scope: 'session' | 'subagent';
  readonly lineageId: string;
  readonly parentLineageId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly analysisTokens?: number;
}

export interface TransportMeasurement {
  readonly id: string;
  readonly capturedAt: string;
  readonly admittedAt?: string;
  readonly committedAt?: string;
  readonly hookDurationMs?: number;
}

export interface CoverageEvidence {
  readonly supportedClasses?: readonly string[];
  readonly skippedClasses?: readonly string[];
  readonly unsupportedClasses?: readonly string[];
  readonly truncatedObservations?: number;
  readonly synthetic?: boolean;
}

export interface SessionEvidenceInput {
  readonly schemaVersion: 1;
  readonly source: AgentSource;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly sourceEndedAt?: string;
  readonly observedThrough?: string;
  readonly reconciliation?: ReconciliationEvidence;
  readonly observations: readonly EvidenceObservation[];
  readonly usageSnapshots?: readonly UsageSnapshot[];
  readonly transportMeasurements?: readonly TransportMeasurement[];
  readonly coverage?: CoverageEvidence;
}

export interface SessionOperation {
  readonly id: string;
  readonly requestEvidenceId: string;
  readonly requestSourceEventId: string;
  readonly resultEvidenceId?: string;
  readonly verificationEvidenceIds?: readonly string[];
  readonly tool?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly processOutcome: 'succeeded' | 'failed' | 'unknown';
  readonly taskOutcome: 'succeeded' | 'failed' | 'unknown';
  readonly outcome: OperationOutcome;
}

export interface SessionTokenMetrics {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly analysisTokens?: number;
  readonly source: 'source-provided';
}

export interface SessionEvidenceMetrics {
  readonly elapsedMs?: number;
  readonly activeOperationMs?: number;
  readonly observedWaitingMs?: number;
  readonly hookDurationMs?: { readonly count: number; readonly total: number; readonly max: number };
  readonly spoolLagMs?: { readonly count: number; readonly total: number; readonly max: number };
  readonly tokenUsage?: SessionTokenMetrics;
  readonly attribution: 'observed-boundaries-only';
}

export interface SessionEvidenceReport {
  readonly schemaVersion: 1;
  readonly source: AgentSource;
  readonly sessionId: string;
  readonly lifecycle: {
    readonly state: SessionLifecycleState;
    readonly sourceEndedAt?: string;
    readonly observedThrough?: string;
    readonly reconciliation?: ReconciliationEvidence;
  };
  readonly operations: readonly SessionOperation[];
  readonly unmatchedEvidenceIds: readonly string[];
  readonly metrics: SessionEvidenceMetrics;
  readonly coverage: {
    readonly retainedObservations: number;
    readonly duplicateObservations: number;
    readonly matchedResults: number;
    readonly unmatchedResults: number;
    readonly missingResults: number;
    readonly supportedClasses: readonly string[];
    readonly skippedClasses: readonly string[];
    readonly unsupportedClasses: readonly string[];
    readonly truncatedObservations: number;
    readonly synthetic: boolean;
  };
}
