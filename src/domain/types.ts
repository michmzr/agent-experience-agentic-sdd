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
  id: EvidenceId;
  candidateId: CandidateLessonId;
  polarity: EvidencePolarity;
  summary: string;
  revalidatesTo?: 'candidate' | 'observed' | 'confirmed' | 'verified';
}

export interface KnowledgeEntry {
  id: KnowledgeId;
  candidateId: CandidateLessonId;
  evidenceIds: EvidenceId[];
  state: KnowledgeState;
  statement: string;
}

export interface ExperienceImport {
  sessions: Session[];
  events: Event[];
  observations: Observation[];
  clusters: ObservationCluster[];
  candidates: CandidateLesson[];
  evidence: Evidence[];
  knowledge: KnowledgeEntry[];
}

export interface TransitionHistoryEntry {
  from: KnowledgeState;
  to: KnowledgeState;
  evidenceId: EvidenceId;
}

export interface TransitionResult {
  entry: KnowledgeEntry;
  history: TransitionHistoryEntry[];
}
