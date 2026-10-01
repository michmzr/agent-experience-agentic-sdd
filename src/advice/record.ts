import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveCliContext } from '../cli/context.js';
import { operationSignatureFromStoredJson, SqliteCandidateEvidenceResolver } from '../knowledge/evidence-resolver.js';
import { AdvisoryConfigurationStore } from './configuration.js';
import { AdvisoryUsageStore, type AdviceScope, type StoredAdviceBundle, type UsageKind, type UsageOrigin } from './usage.js';

export interface AdviceUsageRequest extends AdviceScope {
  readonly bundleId: string;
  readonly kind: Exclude<UsageKind, 'retrieved'>;
  readonly origin: UsageOrigin;
  readonly witnessRef: string;
}

export function recordLocalAdviceUsage(dataDir: string, workingDirectory: string, input: AdviceUsageRequest) {
  if (resolveCliContext(workingDirectory)?.id !== input.repositoryId) throw new Error('Advice usage repository scope is invalid.');
  const path = join(dataDir, 'advice.sqlite');
  if (!existsSync(path)) throw new Error('Advice usage bundle was not found.');
  const usage = new AdvisoryUsageStore(path);
  const bundle = usage.bundle(input.bundleId);
  if (!bundle || bundle.repositoryId !== input.repositoryId || bundle.lessonId !== input.lessonId
    || bundle.lessonRevision !== input.lessonRevision || bundle.sessionId !== input.sessionId
    || bundle.contextRevision !== input.contextRevision) throw new Error('Advice usage bundle scope is invalid.');
  if (input.kind === 'delivered') {
    if (input.origin !== 'agent-claim') throw new Error('Public delivery input is an agent claim only.');
    if (!new AdvisoryConfigurationStore(path).status(input.repositoryId).enabled) {
      throw new Error('Advice delivery is disabled.');
    }
  }
  if (input.kind === 'applied' || input.kind === 'outcome-observed') {
    const progress = usage.qualifiedProgress(input.bundleId);
    const experiencePath = join(dataDir, 'experience.sqlite');
    if (!existsSync(experiencePath)) throw new Error('Operation evidence is unavailable.');
    const database = new DatabaseSync(experiencePath, { readOnly: true, timeout: 125 });
    try {
      if (input.kind === 'applied') verifyApplied(database, bundle.operationSignature,
        bundle.retrievedAt, progress.selectedAt, input);
      else verifyOutcome(database, experiencePath, progress.appliedRefs, bundle, input);
    } finally { database.close(); }
  }
  usage.record(input);
  return Object.freeze({ status: 'recorded' as const, kind: input.kind, origin: input.origin });
}

function verifyApplied(database: DatabaseSync, expectedSignature: string, retrievedAt: string | null,
  selectedAt: string | null, input: AdviceUsageRequest): void {
  const row = database.prepare(`SELECT COALESCE(ce.signature_json, re.signature_json) AS signature_json,
      COALESCE(e.occurred_at, re.occurred_at) AS occurred_at
    FROM logical_evidence l JOIN sessions s ON s.id = l.session_id
    LEFT JOIN capture_events ce ON l.path = 'legacy' AND ce.event_id = l.event_id
    LEFT JOIN events e ON e.id = ce.event_id
    LEFT JOIN capture_run_events re ON l.path = 'run' AND re.event_id = l.event_id
    WHERE l.event_id = ? AND l.session_id = ? AND s.repository_id = ?
      AND COALESCE(ce.phase, re.phase) = 'pre-action'`)
    .get(input.witnessRef, input.sessionId, input.repositoryId) as { signature_json: string; occurred_at: string } | undefined;
  if (!row || !retrievedAt || !selectedAt || !Number.isFinite(Date.parse(retrievedAt))
    || !Number.isFinite(Date.parse(selectedAt)) || !Number.isFinite(Date.parse(row.occurred_at))
    || Date.parse(row.occurred_at) <= Math.max(Date.parse(retrievedAt), Date.parse(selectedAt))
    || operationSignatureFromStoredJson(row.signature_json) !== expectedSignature) {
    throw new Error('Applied operation witness does not match the retrieved advice scope.');
  }
}

function verifyOutcome(database: DatabaseSync, experiencePath: string, applied: readonly string[],
  bundle: StoredAdviceBundle, input: AdviceUsageRequest): void {
  if (applied.length === 0) throw new Error('Outcome requires an applied operation witness.');
  const resolver = new SqliteCandidateEvidenceResolver(experiencePath, input.sessionId);
  let witness;
  try { witness = resolver.resolve(input.repositoryId, input.witnessRef); }
  finally { resolver.close(); }
  if (witness?.kind !== 'task-verification' || !witness.taskId || !applied.includes(witness.taskId)
    || witness.operationSignature !== bundle.operationSignature
    || !/^instruction:v1:[a-f0-9]{64}$/.test(witness.contextRevision ?? '')) {
    throw new Error('Outcome verification does not match the applied operation and context.');
  }
  if (bundle.contextRevision.startsWith('package-json:v1:')) {
    const rows = database.prepare(`SELECT r.verification_evidence_id AS evidence_id, r.evidence_origin_id AS origin_id
      FROM acl_candidate_reviews r JOIN acl_candidates c ON c.id = r.candidate_id
      WHERE c.repository_id = ? AND c.id = ? AND c.kind = 'project-fact'
        AND r.revision = ? AND r.to_state = 'verified' AND r.context_revision = ? LIMIT 2`)
      .all(bundle.repositoryId, bundle.lessonId, Number(bundle.lessonRevision), bundle.contextRevision) as Array<{
        evidence_id: string; origin_id: string }>;
    if (rows.length !== 1) throw new Error('Advice project fact has no qualifying verification.');
    const source = new SqliteCandidateEvidenceResolver(experiencePath, rows[0]!.origin_id);
    let fact;
    try { fact = source.resolve(bundle.repositoryId, rows[0]!.evidence_id); }
    finally { source.close(); }
    if (fact?.kind !== 'deterministic-fact' || fact.contextRevision !== bundle.contextRevision) {
      throw new Error('Advice project fact has changed since retrieval.');
    }
  } else if (witness.contextRevision !== bundle.contextRevision) {
    throw new Error('Outcome instruction context differs from retrieved advice.');
  }
}
