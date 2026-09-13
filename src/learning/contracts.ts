import type { LessonKind } from '../domain/types.js';
import { containsCredentialMaterial } from '../privacy/structured-arguments.js';

const identifierPattern = /^[A-Za-z0-9._:@/-]{1,512}$/;
const evidenceIdentifierPattern = /^[a-z][a-z0-9-]{0,127}$/;
const textLimit = 2_048;

export type AnalysisJobState = 'pending' | 'running' | 'completed' | 'retryable-failure' | 'quarantined-input';
export type EpisodeState = 'unresolved' | 'outcome-observed' | 'solution-supported';
export type FindingKind = 'repository-tool-convention' | 'command-repair' | 'ambiguous-repair';
export type EpisodeEvidenceKind = 'tool-request' | 'tool-result' | 'task-verification' | 'agent-claim' | 'user-instruction' | 'task-transition' | 'instruction-context' | 'analyzer-inference';
export type EpisodeEvidenceState = 'observed' | 'succeeded' | 'failed' | 'closed';
export type EpisodeEvidenceReasonClass = 'failure' | 'instruction' | 'superseded' | 'verification';

export interface EpisodeEvidence {
  readonly id: string;
  readonly kind: EpisodeEvidenceKind;
  readonly state: EpisodeEvidenceState;
  readonly decisionKey?: string;
  readonly scopeKey?: string;
  readonly reasonClass?: EpisodeEvidenceReasonClass;
  readonly detectorVersion?: string;
  readonly evidenceIds: readonly string[];
}

export interface AnalysisCoverage {
  readonly detector: string;
  readonly status: 'completed' | 'incomplete' | 'failed';
  readonly examinedEvents: number;
  readonly findings: number;
}

export interface OperationalEpisode {
  readonly id: string;
  readonly repositoryId?: string;
  readonly sessionId: string;
  readonly detector: string;
  readonly state: EpisodeState;
  readonly evidenceEventIds: readonly string[];
  readonly attemptedOperation?: string;
  readonly changedOperation?: string;
  readonly confirmingEventId?: string;
  readonly hypothesis?: string;
}

export interface OperationalFinding {
  readonly id: string;
  readonly episodeId: string;
  readonly kind: FindingKind;
  readonly evidenceEventIds: readonly string[];
  readonly statement: string;
}

export interface LearningCandidate {
  readonly id: string;
  readonly episodeId: string;
  readonly kind: Extract<LessonKind, 'convention' | 'successful-workflow'>;
  readonly state: 'candidate';
  readonly statement: string;
  readonly conditions: readonly string[];
  readonly procedure: readonly string[];
  readonly evidenceEventIds: readonly string[];
  readonly invalidationConditions: readonly string[];
}

export function createEpisodeEvidence(value: EpisodeEvidence): EpisodeEvidence {
  assertEpisodeEvidenceFields(value);
  assertEvidenceIdentifier(value.id, 'Evidence identity');
  if (!episodeEvidenceKinds.has(value.kind)) throw new TypeError('Evidence kind is invalid.');
  if (!episodeEvidenceStates.has(value.state)) throw new TypeError('Evidence state is invalid.');
  optionalEvidenceIdentifier(value.decisionKey, 'Evidence decision key');
  optionalEvidenceIdentifier(value.scopeKey, 'Evidence scope key');
  if (value.reasonClass !== undefined && !episodeEvidenceReasonClasses.has(value.reasonClass)) throw new TypeError('Evidence reason class is invalid.');
  if (value.kind === 'analyzer-inference') assertIdentifier(value.detectorVersion ?? '', 'Evidence detector version');
  else if (value.detectorVersion !== undefined) throw new TypeError('Evidence detector version is invalid.');
  const evidenceIds = freezeEvidenceIdentifiers(value.evidenceIds, 'Episode evidence');
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    state: value.state,
    ...(value.decisionKey === undefined ? {} : { decisionKey: value.decisionKey }),
    ...(value.scopeKey === undefined ? {} : { scopeKey: value.scopeKey }),
    ...(value.reasonClass === undefined ? {} : { reasonClass: value.reasonClass }),
    ...(value.detectorVersion === undefined ? {} : { detectorVersion: value.detectorVersion }),
    evidenceIds
  });
}

export function createOperationalEpisode(value: OperationalEpisode): OperationalEpisode {
  assertIdentifier(value.id, 'Episode identity');
  optionalIdentifier(value.repositoryId, 'Repository identity');
  assertIdentifier(value.sessionId, 'Session identity');
  assertIdentifier(value.detector, 'Detector identity');
  if (!['unresolved', 'outcome-observed', 'solution-supported'].includes(value.state)) throw new TypeError('Episode state is invalid.');
  const evidenceEventIds = freezeIdentifiers(value.evidenceEventIds, 'Episode evidence');
  optionalText(value.attemptedOperation, 'Attempted operation');
  optionalText(value.changedOperation, 'Changed operation');
  optionalIdentifier(value.confirmingEventId, 'Confirming event identity');
  optionalText(value.hypothesis, 'Episode hypothesis');
  return Object.freeze({
    id: value.id,
    ...(value.repositoryId === undefined ? {} : { repositoryId: value.repositoryId }),
    sessionId: value.sessionId,
    detector: value.detector,
    state: value.state,
    evidenceEventIds,
    ...(value.attemptedOperation === undefined ? {} : { attemptedOperation: value.attemptedOperation }),
    ...(value.changedOperation === undefined ? {} : { changedOperation: value.changedOperation }),
    ...(value.confirmingEventId === undefined ? {} : { confirmingEventId: value.confirmingEventId }),
    ...(value.hypothesis === undefined ? {} : { hypothesis: value.hypothesis })
  });
}

export function createLearningCandidate(value: LearningCandidate): LearningCandidate {
  assertIdentifier(value.id, 'Candidate identity');
  assertIdentifier(value.episodeId, 'Episode identity');
  if (value.kind !== 'convention' && value.kind !== 'successful-workflow') throw new TypeError('Candidate kind is invalid.');
  if (value.state !== 'candidate') throw new TypeError('Candidate state is invalid.');
  assertText(value.statement, 'Candidate statement');
  const conditions = freezeText(value.conditions, 'Candidate condition');
  const procedure = freezeText(value.procedure, 'Candidate procedure');
  const evidenceEventIds = freezeIdentifiers(value.evidenceEventIds, 'Candidate evidence');
  const invalidationConditions = freezeText(value.invalidationConditions, 'Candidate invalidation condition');
  return Object.freeze({
    id: value.id,
    episodeId: value.episodeId,
    kind: value.kind,
    state: value.state,
    statement: value.statement,
    conditions,
    procedure,
    evidenceEventIds,
    invalidationConditions
  });
}

function freezeIdentifiers(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) throw new TypeError(`${field} is invalid.`);
  const identities = new Set<string>();
  for (const value of values) {
    assertIdentifier(value, `${field} identity`);
    if (identities.has(value)) throw new TypeError(`${field} contains duplicate identity.`);
    identities.add(value);
  }
  return Object.freeze([...values]);
}

function freezeText(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) throw new TypeError(`${field} is invalid.`);
  for (const value of values) assertText(value, field);
  return Object.freeze([...values]);
}

function optionalIdentifier(value: string | undefined, field: string): void {
  if (value !== undefined) assertIdentifier(value, field);
}

function optionalEvidenceIdentifier(value: string | undefined, field: string): void {
  if (value !== undefined) assertEvidenceIdentifier(value, field);
}

function freezeEvidenceIdentifiers(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) throw new TypeError(`${field} is invalid.`);
  const identities = new Set<string>();
  for (const value of values) {
    assertEvidenceIdentifier(value, `${field} identity`);
    if (identities.has(value)) throw new TypeError(`${field} contains duplicate identity.`);
    identities.add(value);
  }
  return Object.freeze([...values]);
}

const episodeEvidenceKinds = new Set<EpisodeEvidenceKind>([
  'tool-request', 'tool-result', 'task-verification', 'agent-claim',
  'user-instruction', 'task-transition', 'instruction-context', 'analyzer-inference'
]);

const episodeEvidenceStates = new Set<EpisodeEvidenceState>(['observed', 'succeeded', 'failed', 'closed']);

const episodeEvidenceReasonClasses = new Set<EpisodeEvidenceReasonClass>(['failure', 'instruction', 'superseded', 'verification']);

const episodeEvidenceFields = new Set<keyof EpisodeEvidence>(['id', 'kind', 'state', 'decisionKey', 'scopeKey', 'reasonClass', 'detectorVersion', 'evidenceIds']);

function assertEpisodeEvidenceFields(value: EpisodeEvidence): void {
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== 'string' || !episodeEvidenceFields.has(field as keyof EpisodeEvidence)) {
      throw new TypeError('Episode evidence contains an unsupported field.');
    }
  }
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !identifierPattern.test(value)) throw new TypeError(`${field} is invalid.`);
}

function assertEvidenceIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !evidenceIdentifierPattern.test(value) || containsCredentialMaterial(value)) throw new TypeError(`${field} is invalid.`);
}

function optionalText(value: string | undefined, field: string): void {
  if (value !== undefined) assertText(value, field);
}

function assertText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > textLimit) throw new TypeError(`${field} is invalid.`);
}
