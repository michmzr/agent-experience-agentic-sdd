import type { ExperienceImport, KnowledgeState } from './types.js';

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
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bbearer(?:[_-]?token)?\s*(?:=|:)\s*\S+/i
];

const states: readonly KnowledgeState[] = ['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired'];

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

export function validateImport(record: ExperienceImport): ValidationResult {
  if (!record || typeof record !== 'object') return invalid('INVALID_SHAPE', 'Import must be an object.');

  const sensitive = hasForbiddenContent(record);
  if (sensitive) return sensitive;

  const collections = ['sessions', 'events', 'observations', 'clusters', 'candidates', 'evidence', 'knowledge'] as const;
  if (collections.some((name) => !Array.isArray(record[name]))) return invalid('INVALID_SHAPE', 'Import collections must be arrays.');
  if (record.sessions.some((session) => !['codex', 'claude-code', 'cursor'].includes(session.source))) return invalid('INVALID_SHAPE', 'Session source is unsupported.');
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
  if (record.knowledge.some((entry) => 'eventId' in entry)) return invalid('INVALID_RELATIONSHIP', 'Knowledge cannot reference an event directly.');
  if (record.knowledge.some((entry) => !candidateIds.has(entry.candidateId))) return invalid('MISSING_REFERENCE', 'Knowledge references a missing candidate.');
  if (record.knowledge.some((entry) => entry.evidenceIds.length === 0)) return invalid('INVALID_RELATIONSHIP', 'Knowledge requires at least one evidence item.');
  if (record.knowledge.some((entry) => entry.evidenceIds.some((id) => !evidenceIds.has(id)))) return invalid('MISSING_REFERENCE', 'Knowledge references missing evidence.');
  if (record.knowledge.some((entry) => entry.evidenceIds.some((id) => record.evidence.find((item) => item.id === id)?.candidateId !== entry.candidateId))) {
    return invalid('INVALID_RELATIONSHIP', 'Knowledge evidence must support its candidate.');
  }

  return { ok: true };
}
