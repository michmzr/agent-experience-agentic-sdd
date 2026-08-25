import type {
  AgentSource,
  EvidencePolarity,
  KnowledgeState,
  LessonKind,
  Session,
  SessionId
} from '../domain/types.js';
import type { RuntimeSignature } from '../runtime/contracts.js';

export const MAX_CAPTURE_IDENTIFIER_LENGTH = 512;
export const MAX_CAPTURE_TEXT_LENGTH = 2_048;
export const MAX_CAPTURE_ARGUMENTS = 64;

export type CapturePhase = 'pre-intent' | 'pre-action' | 'post-result';
export type CaptureOutcome = 'succeeded' | 'failed' | 'unknown';

export interface NormalizedCaptureEvent {
  readonly id: string;
  readonly source: AgentSource;
  readonly sourceEventId: string;
  readonly sessionId: SessionId;
  readonly phase: CapturePhase;
  readonly occurredAt: string;
  readonly signature: RuntimeSignature;
  readonly summary: string;
  readonly outcome?: CaptureOutcome;
  readonly exitStatus?: number;
  readonly relatedEventId?: string;
}

export interface MappedCaptureRecord {
  readonly source: AgentSource;
  readonly sourceEventId: unknown;
  readonly sessionId: unknown;
  readonly phase: unknown;
  readonly occurredAt: unknown;
  readonly tool?: unknown;
  readonly action?: unknown;
  readonly arguments?: unknown;
  readonly path?: unknown;
  readonly verb?: unknown;
  readonly target?: unknown;
  readonly summary: unknown;
  readonly outcome?: unknown;
  readonly exitStatus?: unknown;
  readonly relatedEventId?: unknown;
}

export interface CaptureDiagnostic {
  readonly code: 'CAPTURE_PERSISTENCE_FAILED';
  readonly phase: CapturePhase;
  readonly retryable: true;
}

export interface IncrementalCandidateCapture {
  readonly observation: { readonly id: string; readonly statement: string };
  readonly cluster: { readonly id: string };
  readonly candidate: { readonly id: string; readonly kind: LessonKind; readonly statement: string };
  readonly evidence: {
    readonly id: string;
    readonly candidateId?: string;
    readonly polarity: EvidencePolarity;
    readonly summary: string;
  };
}

export interface IncrementalEvidenceCapture {
  readonly id: string;
  readonly candidateId?: string;
  readonly polarity: EvidencePolarity;
  readonly summary: string;
  readonly revalidatesTo?: 'observed' | 'confirmed' | 'verified';
}

export interface IncrementalCaptureAppend {
  readonly session?: Session;
  readonly event?: NormalizedCaptureEvent;
  readonly candidate?: IncrementalCandidateCapture;
  readonly evidence?: IncrementalEvidenceCapture;
  readonly transition?: {
    readonly knowledgeId: string;
    readonly occurredAt: string;
    readonly target?: KnowledgeState;
  };
  readonly evidenceUpdates?: readonly {
    readonly evidence: IncrementalEvidenceCapture;
    readonly transition: NonNullable<IncrementalCaptureAppend['transition']>;
  }[];
}

export interface IncrementalAppendResult {
  readonly inserted: boolean;
}

export interface CapturedEventRecord extends NormalizedCaptureEvent {}

export interface RevalidationProposal {
  readonly id: string;
  readonly knowledgeId: string;
  readonly createdAt: string;
  readonly contradictionCount: number;
  readonly status: 'proposed';
}
