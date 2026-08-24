import type { EvidencePolarity, ExperienceImport, KnowledgeState, LessonKind } from './types.js';

export type ValidationCode =
  | 'INVALID_SHAPE'
  | 'MISSING_REFERENCE'
  | 'INVALID_RELATIONSHIP'
  | 'FORBIDDEN_FIELD'
  | 'SENSITIVE_TEXT';

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationCode; message: string };

const forbiddenText = [
  /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY(?: BLOCK)?-----/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bbearer(?:[_-]?token)?\s*(?:=|:)\s*\S+/i
];

const states: readonly KnowledgeState[] = ['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired'];
const lessonKinds: readonly LessonKind[] = ['failure', 'successful-workflow', 'project-fact', 'convention', 'tool-capability', 'environment-quirk', 'heuristic', 'preference'];
const evidencePolarities: readonly EvidencePolarity[] = ['confirms', 'contradicts', 'contextualizes'];
const eventOutcomes = ['passed', 'failed', 'unknown'] as const;
const collectionKeys = ['sessions', 'events', 'observations', 'clusters', 'candidates', 'evidence', 'knowledge'] as const;
const allowedEntityKeys: Record<typeof collectionKeys[number], readonly string[]> = {
  sessions: ['id', 'source', 'startedAt', 'repositoryId', 'workspaceId', 'userId'],
  events: ['id', 'sessionId', 'kind', 'occurredAt', 'tool', 'path', 'outcome', 'exitStatus'],
  observations: ['id', 'eventIds', 'statement'],
  clusters: ['id', 'observationIds'],
  candidates: ['id', 'clusterId', 'kind', 'statement'],
  evidence: ['id', 'candidateId', 'polarity', 'summary', 'revalidatesTo'],
  knowledge: ['id', 'candidateId', 'evidenceIds', 'state', 'statement']
};

function invalid(code: ValidationCode, message: string): ValidationResult {
  return { ok: false, code, message };
}

function hasForbiddenContent(value: unknown): ValidationResult | undefined {
  if (typeof value === 'string' && forbiddenText.some((pattern) => pattern.test(value))) {
    return invalid('SENSITIVE_TEXT', 'Persisted text contains credential-like material.');
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = hasForbiddenContent(item);
      if (result) return result;
    }
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'rawTranscript' || key === 'payload') return invalid('FORBIDDEN_FIELD', `Unsupported persisted field: ${key}.`);
      const result = hasForbiddenContent(item);
      if (result) return result;
    }
  }
  return undefined;
}

function identifiers(items: readonly { id: string }[]): Set<string> {
  return new Set(items.map(({ id }) => id));
}

function hasEmptyOrDuplicateIdentifiers(items: readonly { id: string }[]): boolean {
  return items.some((item) => item.id.trim().length === 0) || identifiers(items).size !== items.length;
}

function hasOnlyAllowedKeys(value: unknown, allowedKeys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function hasStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

function hasOptionalStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => value[field] === undefined || typeof value[field] === 'string');
}

function hasValidEntityShape(collection: typeof collectionKeys[number], value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entity = value as Record<string, unknown>;

  switch (collection) {
    case 'sessions':
      return hasStringFields(entity, ['id', 'source', 'startedAt'])
        && hasOptionalStringFields(entity, ['repositoryId', 'workspaceId', 'userId']);
    case 'events':
      return hasStringFields(entity, ['id', 'sessionId', 'kind', 'occurredAt'])
        && hasOptionalStringFields(entity, ['tool', 'path', 'outcome'])
        && (entity.exitStatus === undefined || typeof entity.exitStatus === 'number');
    case 'observations':
      return hasStringFields(entity, ['id', 'statement']) && isStringArray(entity.eventIds);
    case 'clusters':
      return typeof entity.id === 'string' && isStringArray(entity.observationIds);
    case 'candidates':
      return hasStringFields(entity, ['id', 'clusterId', 'kind', 'statement']);
    case 'evidence':
      return hasStringFields(entity, ['id', 'candidateId', 'polarity', 'summary'])
        && (entity.revalidatesTo === undefined || typeof entity.revalidatesTo === 'string');
    case 'knowledge':
      return hasStringFields(entity, ['id', 'candidateId', 'state', 'statement']) && isStringArray(entity.evidenceIds);
  }
}

export function validateImport(record: ExperienceImport): ValidationResult {
  if (!record || typeof record !== 'object') return invalid('INVALID_SHAPE', 'Import must be an object.');

  const sensitive = hasForbiddenContent(record);
  if (sensitive) return sensitive;

  if (Object.keys(record).some((key) => !collectionKeys.includes(key as typeof collectionKeys[number]))) return invalid('FORBIDDEN_FIELD', 'Import contains an unsupported field.');
  if (collectionKeys.some((name) => !Array.isArray(record[name]))) return invalid('INVALID_SHAPE', 'Import collections must be arrays.');
  if (collectionKeys.some((name) => record[name].some((item) => !hasOnlyAllowedKeys(item, allowedEntityKeys[name])))) return invalid('FORBIDDEN_FIELD', 'Import entity contains an unsupported field.');
  if (collectionKeys.some((name) => record[name].some((item) => !hasValidEntityShape(name, item)))) return invalid('INVALID_SHAPE', 'Import entity has an invalid shape.');
  if (collectionKeys.some((name) => hasEmptyOrDuplicateIdentifiers(record[name]))) return invalid('INVALID_SHAPE', 'Entity identifiers must be unique and non-empty.');
  if (record.sessions.some((session) => !['codex', 'claude-code', 'cursor'].includes(session.source))) return invalid('INVALID_SHAPE', 'Session source is unsupported.');
  if (record.events.some((event) => event.outcome !== undefined && !eventOutcomes.includes(event.outcome))) return invalid('INVALID_SHAPE', 'Event outcome is unsupported.');
  if (record.candidates.some((candidate) => !lessonKinds.includes(candidate.kind))) return invalid('INVALID_SHAPE', 'Lesson kind is unsupported.');
  if (record.evidence.some((item) => !evidencePolarities.includes(item.polarity))) return invalid('INVALID_SHAPE', 'Evidence polarity is unsupported.');
  if (record.evidence.some((item) => item.revalidatesTo !== undefined && !['observed', 'confirmed', 'verified'].includes(item.revalidatesTo))) return invalid('INVALID_SHAPE', 'Evidence revalidation target is unsupported.');
  if (record.evidence.some((item) => item.polarity === 'contradicts' && item.revalidatesTo !== undefined)) return invalid('INVALID_SHAPE', 'Contradictory evidence cannot revalidate knowledge.');
  if (record.knowledge.some((entry) => !states.includes(entry.state))) return invalid('INVALID_SHAPE', 'Knowledge state is unsupported.');

  const sessionIds = identifiers(record.sessions);
  const eventIds = identifiers(record.events);
  const observationIds = identifiers(record.observations);
  const clusterIds = identifiers(record.clusters);
  const candidateIds = identifiers(record.candidates);
  const evidenceIds = identifiers(record.evidence);

  if (record.events.some((event) => !sessionIds.has(event.sessionId))) return invalid('MISSING_REFERENCE', 'Event references a missing session.');
  if (record.observations.some((observation) => observation.eventIds.length === 0)) return invalid('INVALID_RELATIONSHIP', 'Observation requires at least one event.');
  if (record.observations.some((observation) => observation.eventIds.some((id) => !eventIds.has(id)))) return invalid('MISSING_REFERENCE', 'Observation references a missing event.');
  if (record.clusters.some((cluster) => cluster.observationIds.length === 0)) return invalid('INVALID_RELATIONSHIP', 'Cluster requires at least one observation.');
  if (record.clusters.some((cluster) => cluster.observationIds.some((id) => !observationIds.has(id)))) return invalid('MISSING_REFERENCE', 'Cluster references a missing observation.');
  if (record.candidates.some((candidate) => !clusterIds.has(candidate.clusterId))) return invalid('MISSING_REFERENCE', 'Candidate references a missing cluster.');
  if (record.evidence.some((item) => !candidateIds.has(item.candidateId))) return invalid('MISSING_REFERENCE', 'Evidence references a missing candidate.');
  if (record.knowledge.some((entry) => !candidateIds.has(entry.candidateId))) return invalid('MISSING_REFERENCE', 'Knowledge references a missing candidate.');
  if (record.knowledge.some((entry) => entry.evidenceIds.length === 0)) return invalid('INVALID_RELATIONSHIP', 'Knowledge requires at least one evidence item.');
  if (record.knowledge.some((entry) => entry.evidenceIds.some((id) => !evidenceIds.has(id)))) return invalid('MISSING_REFERENCE', 'Knowledge references missing evidence.');
  if (record.knowledge.some((entry) => entry.evidenceIds.some((id) => record.evidence.find((item) => item.id === id)?.candidateId !== entry.candidateId))) {
    return invalid('INVALID_RELATIONSHIP', 'Knowledge evidence must support its candidate.');
  }

  return { ok: true };
}
