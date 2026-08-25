declare const identifierBrand: unique symbol;

export type OpaqueId<Name extends string> = string & { readonly [identifierBrand]: Name };

export type SessionId = OpaqueId<'SessionId'>;
export type EventId = OpaqueId<'EventId'>;
export type ObservationId = OpaqueId<'ObservationId'>;
export type ClusterId = OpaqueId<'ClusterId'>;
export type CandidateLessonId = OpaqueId<'CandidateLessonId'>;
export type EvidenceId = OpaqueId<'EvidenceId'>;
export type KnowledgeId = OpaqueId<'KnowledgeId'>;
export type RepositoryId = OpaqueId<'RepositoryId'>;
export type WorkspaceId = OpaqueId<'WorkspaceId'>;
export type UserId = OpaqueId<'UserId'>;

export type AgentSource = 'codex' | 'claude-code' | 'cursor';
export type LessonKind =
  | 'failure'
  | 'successful-workflow'
  | 'project-fact'
  | 'convention'
  | 'tool-capability'
  | 'environment-quirk'
  | 'heuristic'
  | 'preference';
export type KnowledgeState =
  | 'candidate'
  | 'observed'
  | 'confirmed'
  | 'verified'
  | 'disputed'
  | 'superseded'
  | 'rejected'
  | 'expired';
export type EvidencePolarity = 'confirms' | 'contradicts' | 'contextualizes';

export interface Session {
  id: SessionId;
  source: AgentSource;
  startedAt: string;
  repositoryId?: RepositoryId;
  workspaceId?: WorkspaceId;
  userId?: UserId;
}

export interface Event {
  id: EventId;
  sessionId: SessionId;
  kind: string;
  occurredAt: string;
  tool?: string;
  path?: string;
  tags?: readonly string[];
  outcome?: 'passed' | 'failed' | 'unknown';
  exitStatus?: number;
}

export interface Observation {
  id: ObservationId;
  eventIds: EventId[];
  statement: string;
}

export interface ObservationCluster {
  id: ClusterId;
  observationIds: ObservationId[];
}

export interface CandidateLesson {
  id: CandidateLessonId;
  clusterId: ClusterId;
  kind: LessonKind;
  statement: string;
}

export interface Evidence {
  readonly id: EvidenceId;
  readonly candidateId: CandidateLessonId;
  readonly polarity: EvidencePolarity;
  readonly summary: string;
  readonly revalidatesTo?: 'observed' | 'confirmed' | 'verified';
}

export interface KnowledgeEntry {
  id: KnowledgeId;
  candidateId: CandidateLessonId;
  readonly evidenceIds: readonly EvidenceId[];
  state: KnowledgeState;
  statement: string;
}

export interface KnowledgeMetadata {
  readonly scope?: 'global' | 'repository';
  readonly repositoryId?: RepositoryId;
  readonly path?: string;
  readonly tool?: string;
  readonly tags?: readonly string[];
  readonly createdAt: string;
  readonly approvalKind?: 'user' | 'system';
  readonly approvedAt?: string;
  readonly activation?: 'merged-team-active' | 'local';
  readonly mergedProvenance?: string;
}

export interface ExperienceImport {
  sessions: Session[];
  events: Event[];
  observations: Observation[];
  clusters: ObservationCluster[];
  candidates: CandidateLesson[];
  evidence: readonly Evidence[];
  knowledge: KnowledgeEntry[];
  knowledgeMetadata?: Record<string, KnowledgeMetadata>;
}

export interface TransitionHistoryEntry {
  readonly from: KnowledgeState;
  readonly to: KnowledgeState;
  readonly evidenceId: EvidenceId;
  readonly occurredAt?: string;
}

export interface TransitionResult {
  readonly entry: Readonly<KnowledgeEntry>;
  readonly history: readonly Readonly<TransitionHistoryEntry>[];
}
