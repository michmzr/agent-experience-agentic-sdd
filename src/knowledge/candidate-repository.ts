import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LessonKind } from '../domain/types.js';
import { canTransition } from '../domain/transitions.js';
import { assertDurableTextSafe } from '../review/sanitizer.js';
import { openExperienceDatabase } from '../storage/database.js';
import { canonicalCandidateIdentity, type CandidateIdentityInput } from './candidate-identity.js';

const kinds = new Set<LessonKind>(['failure', 'successful-workflow', 'project-fact', 'convention', 'tool-capability', 'environment-quirk', 'heuristic', 'preference']);
const MAX_TEXT = 2_048;
const BACKFILL_BATCH = 1_024;
const pendingOperationalWhere = `FROM operational_candidates c JOIN operational_episodes e ON e.id = c.episode_id
  WHERE e.repository_id = ? AND c.state = 'candidate' AND c.kind IN ('convention', 'successful-workflow')
  AND NOT EXISTS (SELECT 1 FROM acl_candidate_origins o JOIN acl_candidates a ON a.id = o.candidate_id
    WHERE o.source = 'operational' AND o.origin_id = c.id AND a.repository_id = e.repository_id)`;

export interface CandidateRegistration extends CandidateIdentityInput {
  readonly source: 'operational' | 'manual-review';
  readonly statement: string;
  readonly sessionId?: string;
  readonly evidenceEventIds?: readonly string[];
}
export interface CandidateRecord {
  readonly id: string;
  readonly repositoryId: string;
  readonly state: 'candidate' | 'observed' | 'confirmed' | 'verified' | 'disputed' | 'superseded' | 'rejected' | 'expired';
  readonly kind: LessonKind;
  readonly statement: string;
  readonly applicability: CandidateIdentityInput['applicability'];
  readonly revision: number;
  readonly contradictionState: 'clear' | 'disputed';
  readonly supersedesId?: string;
  readonly supersededById?: string;
  readonly origins: readonly { readonly source: CandidateRegistration['source']; readonly originId: string;
    readonly sessionId?: string; readonly evidenceEventIds: readonly string[] }[];
}
export interface VerifiedLocalEntry {
  readonly candidateId: string;
  readonly repositoryId: string;
  readonly revision: number;
  readonly kind: LessonKind;
  readonly statement: string;
  readonly applicability: CandidateIdentityInput['applicability'];
  readonly state: 'verified';
  readonly verifiedAt: string;
  readonly contradictionState: 'clear';
  readonly contextRevision: string;
  readonly verificationEvidenceId: string;
  readonly supportingEvidenceIds: readonly string[];
  readonly operationSignature: string | null;
}
export interface ReviewRequiredRegistration {
  readonly repositoryId: string;
  readonly sessionId: string;
  readonly rootCauseId: string;
  readonly findingIds: readonly string[];
  readonly recommendation: string;
}
export interface ReviewRequiredRecord extends ReviewRequiredRegistration { readonly id: string; readonly state: 'review-required'; }
export interface CandidateReviewRequest {
  readonly repositoryId: string;
  readonly candidateId: string;
  readonly target: CandidateRecord['state'];
  readonly actorId: string;
  readonly evidenceId: string;
  readonly reviewedAt: string;
}
export interface CandidateReviewWitness {
  readonly id: string;
  readonly repositoryId: string;
  readonly originId: string;
  readonly kind: 'observation' | 'task-verification' | 'deterministic-fact' | 'user-confirmed-fact' | 'instruction-context' | 'contradiction';
  readonly taskId?: string;
  readonly procedureKey?: string;
  readonly factKey?: string;
  readonly contextRevision?: string;
  readonly operationSignature?: string;
  readonly revalidatesCandidateId?: string;
}
export interface CandidateReviewHistoryEntry {
  readonly from: CandidateRecord['state'];
  readonly to: CandidateRecord['state'];
  readonly evidenceId: string;
  readonly actorId: string;
  readonly reviewedAt: string;
}
export interface CandidateSupersessionRequest {
  readonly repositoryId: string;
  readonly priorCandidateId: string;
  readonly replacement: CandidateRegistration;
  readonly actorId: string;
  readonly evidenceId: string;
  readonly reviewedAt: string;
}

interface CandidateRow {
  id: string; repository_id: string; kind: LessonKind; state: CandidateRecord['state']; statement: string;
  applicability_json: string; revision: number; contradiction_state: CandidateRecord['contradictionState']; verified_at: string | null;
  proposition_key: string | null; procedure_key: string | null;
  supersedes_id: string | null; superseded_by_id: string | null;
}
interface OperationalRow { id: string; session_id: string; kind: LessonKind; statement: string; }

export class CandidateRepository {
  private readonly database: DatabaseSync;
  constructor(databasePath: string) {
    this.database = openExperienceDatabase(databasePath);
    try { this.initialize(); } catch (error) { this.database.close(); throw error; }
  }
  close(): void { this.database.close(); }

  register(input: CandidateRegistration): CandidateRecord {
    const id = this.transaction(() => this.insertCandidate(input));
    return this.inspect(input.repositoryId, id)!;
  }
  registerBatch(candidates: readonly CandidateRegistration[], reviewRequired: readonly ReviewRequiredRegistration[]): void {
    this.transaction(() => {
      for (const candidate of candidates) this.insertCandidate(candidate);
      for (const finding of reviewRequired) this.insertReviewRequired(finding);
    });
  }
  review(request: CandidateReviewRequest, witness: CandidateReviewWitness): CandidateRecord {
    assertIdentifier(request.repositoryId); assertIdentifier(request.candidateId);
    assertIdentifier(request.actorId); assertIdentifier(request.evidenceId);
    assertTimestamp(request.reviewedAt);
    if (witness.id !== request.evidenceId || witness.repositoryId !== request.repositoryId) throw new TypeError('Review evidence scope is invalid.');
    assertIdentifier(witness.originId);
    this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM acl_candidates WHERE repository_id = ? AND id = ?')
        .get(request.repositoryId, request.candidateId) as unknown as CandidateRow | undefined;
      if (!row) throw new Error('Candidate was not found in repository scope.');
      const prior = this.database.prepare('SELECT to_state FROM acl_candidate_reviews WHERE candidate_id = ? AND evidence_id = ?')
        .get(row.id, request.evidenceId) as { to_state: string } | undefined;
      if (prior) {
        if (prior.to_state !== request.target) throw new Error('Review evidence was already used for another transition.');
        return;
      }
      if (!canTransition(row.state, request.target)) throw new Error('Candidate lifecycle transition is not allowed.');
      this.validateReviewEvidence(row, request, witness);
      const verifiedAt = request.target === 'verified' ? request.reviewedAt : null;
      const contradictionState = request.target === 'disputed' ? 'disputed' : 'clear';
      const reviewId = `acl-review:v1:${createHash('sha256').update(JSON.stringify([row.id, request.evidenceId])).digest('hex')}`;
      this.database.prepare(`INSERT INTO acl_candidate_reviews
        (id, candidate_id, revision, from_state, to_state, actor_id, evidence_id, evidence_origin_id,
         evidence_kind, verification_evidence_id, context_revision, operation_signature, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(reviewId, row.id, row.revision, row.state, request.target, request.actorId, request.evidenceId,
          witness.originId, witness.kind, request.target === 'verified' ? witness.id : null,
          request.target === 'verified' ? witness.contextRevision! : null,
          request.target === 'verified' ? witness.operationSignature ?? null : null, request.reviewedAt);
      this.database.prepare(`UPDATE acl_candidates SET state = ?, contradiction_state = ?, verified_at = ? WHERE id = ?`)
        .run(request.target, contradictionState, verifiedAt, row.id);
    });
    return this.inspect(request.repositoryId, request.candidateId)!;
  }
  history(repositoryId: string, candidateId: string): readonly CandidateReviewHistoryEntry[] {
    if (!this.inspect(repositoryId, candidateId)) return [];
    const rows = this.database.prepare(`SELECT from_state, to_state, evidence_id, actor_id, reviewed_at
      FROM acl_candidate_reviews WHERE candidate_id = ? ORDER BY rowid`).all(candidateId) as Array<{
        from_state: CandidateRecord['state']; to_state: CandidateRecord['state']; evidence_id: string;
        actor_id: string; reviewed_at: string }>;
    return Object.freeze(rows.map((row) => Object.freeze({ from: row.from_state, to: row.to_state,
      evidenceId: row.evidence_id, actorId: row.actor_id, reviewedAt: row.reviewed_at })));
  }
  supersede(request: CandidateSupersessionRequest, witness: CandidateReviewWitness): CandidateRecord {
    assertIdentifier(request.repositoryId); assertIdentifier(request.priorCandidateId);
    assertIdentifier(request.actorId); assertIdentifier(request.evidenceId); assertTimestamp(request.reviewedAt);
    if (witness.id !== request.evidenceId || witness.repositoryId !== request.repositoryId ||
      (witness.kind !== 'observation' && witness.kind !== 'task-verification')) {
      throw new Error('Supersession requires scoped change evidence.');
    }
    let replacementId = '';
    this.transaction(() => {
      const prior = this.database.prepare('SELECT * FROM acl_candidates WHERE repository_id = ? AND id = ?')
        .get(request.repositoryId, request.priorCandidateId) as unknown as CandidateRow | undefined;
      if (!prior || !canTransition(prior.state, 'superseded')) throw new Error('Prior candidate cannot be superseded.');
      if (request.replacement.repositoryId !== request.repositoryId || request.replacement.kind !== prior.kind ||
        (request.replacement.propositionKey ?? null) !== prior.proposition_key) {
        throw new Error('Successor candidate scope or proposition is incompatible.');
      }
      replacementId = canonicalCandidateIdentity({ ...request.replacement,
        originId: `${request.replacement.source}:${request.replacement.originId}` });
      if (replacementId === prior.id || this.database.prepare('SELECT 1 FROM acl_candidates WHERE id = ?').get(replacementId)) {
        throw new Error('Successor candidate must have a new identity.');
      }
      this.insertCandidate(request.replacement);
      this.database.prepare('UPDATE acl_candidates SET revision = ?, supersedes_id = ? WHERE id = ?')
        .run(prior.revision + 1, prior.id, replacementId);
      this.database.prepare(`UPDATE acl_candidates SET state = 'superseded', superseded_by_id = ?, verified_at = NULL WHERE id = ?`)
        .run(replacementId, prior.id);
      const reviewId = `acl-review:v1:${createHash('sha256').update(JSON.stringify([prior.id, request.evidenceId])).digest('hex')}`;
      this.database.prepare(`INSERT INTO acl_candidate_reviews
        (id, candidate_id, revision, from_state, to_state, actor_id, evidence_id, evidence_origin_id,
         evidence_kind, verification_evidence_id, context_revision, operation_signature, reviewed_at)
        VALUES (?, ?, ?, ?, 'superseded', ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
        .run(reviewId, prior.id, prior.revision, prior.state, request.actorId, request.evidenceId,
          witness.originId, witness.kind, request.reviewedAt);
    });
    return this.inspect(request.repositoryId, replacementId)!;
  }
  list(repositoryId: string): readonly CandidateRecord[] {
    assertIdentifier(repositoryId);
    const rows = this.database.prepare('SELECT * FROM acl_candidates WHERE repository_id = ? ORDER BY id').all(repositoryId) as unknown as CandidateRow[];
    return Object.freeze(rows.map((row) => this.toRecord(row)));
  }
  listAcceptedLocalEntries(repositoryId: string, applicability: CandidateIdentityInput['applicability']): readonly CandidateRecord[] {
    assertIdentifier(repositoryId);
    const rows = this.database.prepare(`SELECT * FROM acl_candidates WHERE repository_id = ?
      AND state IN ('observed', 'confirmed', 'verified') AND contradiction_state = 'clear' ORDER BY id`)
      .all(repositoryId) as unknown as CandidateRow[];
    const contextConditions = new Set(applicability.conditions ?? []);
    const qualifiedVerified = new Set(this.listVerifiedLocalEntries(repositoryId).map((entry) => entry.candidateId));
    return Object.freeze(rows.filter((row) => {
      if (row.state === 'verified' && !qualifiedVerified.has(row.id)) return false;
      const scope = JSON.parse(row.applicability_json) as CandidateIdentityInput['applicability'];
      if (scope.scope === 'subproject' && (applicability.scope !== 'subproject' || scope.path !== applicability.path)) return false;
      return (scope.conditions ?? []).every((condition) => contextConditions.has(condition));
    }).map((row) => this.toRecord(row)));
  }
  inspect(repositoryId: string, id: string): CandidateRecord | undefined {
    assertIdentifier(repositoryId); assertIdentifier(id);
    const row = this.database.prepare('SELECT * FROM acl_candidates WHERE repository_id = ? AND id = ?')
      .get(repositoryId, id) as unknown as CandidateRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }
  // ACL-A3 must write the verified review and transition together. A1/A2 has no verified writer.
  listVerifiedLocalEntries(repositoryId: string): readonly VerifiedLocalEntry[] {
    assertIdentifier(repositoryId);
    const rows = this.database.prepare(`SELECT c.*, r.context_revision, r.verification_evidence_id, r.operation_signature
      FROM acl_candidates c JOIN acl_candidate_reviews r ON r.candidate_id = c.id AND r.revision = c.revision
      AND r.to_state = 'verified' AND r.reviewed_at = c.verified_at WHERE c.repository_id = ?
      AND c.state = 'verified' AND c.contradiction_state = 'clear' AND c.verified_at IS NOT NULL
      AND r.verification_evidence_id IS NOT NULL AND r.context_revision IS NOT NULL
      ORDER BY c.id`).all(repositoryId) as unknown as Array<CandidateRow & {
        context_revision: string; verification_evidence_id: string; operation_signature: string | null }>;
    return Object.freeze(rows.map((row) => Object.freeze({ candidateId: row.id, repositoryId: row.repository_id,
      revision: row.revision, kind: row.kind, statement: row.statement,
      applicability: JSON.parse(row.applicability_json) as CandidateIdentityInput['applicability'],
      state: 'verified' as const, verifiedAt: row.verified_at!, contradictionState: 'clear' as const,
      contextRevision: row.context_revision, verificationEvidenceId: row.verification_evidence_id,
      supportingEvidenceIds: Object.freeze((this.database.prepare(`SELECT evidence_id FROM acl_candidate_reviews
        WHERE candidate_id = ? AND revision = ? AND to_state IN ('observed', 'confirmed') ORDER BY rowid`)
        .all(row.id, row.revision) as Array<{ evidence_id: string }>).map(({ evidence_id }) => evidence_id)),
      operationSignature: row.operation_signature })));
  }
  registerReviewRequired(input: ReviewRequiredRegistration): ReviewRequiredRecord {
    const id = this.transaction(() => this.insertReviewRequired(input));
    return this.listReviewRequired(input.repositoryId).find((item) => item.id === id)!;
  }
  listReviewRequired(repositoryId: string): readonly ReviewRequiredRecord[] {
    assertIdentifier(repositoryId);
    const rows = this.database.prepare('SELECT * FROM acl_review_required WHERE repository_id = ? ORDER BY id')
      .all(repositoryId) as Array<{ id: string; repository_id: string; session_id: string; root_cause_id: string;
        finding_ids_json: string; recommendation: string }>;
    return Object.freeze(rows.map((row) => Object.freeze({ id: row.id, repositoryId: row.repository_id,
      sessionId: row.session_id, rootCauseId: row.root_cause_id,
      findingIds: Object.freeze(JSON.parse(row.finding_ids_json) as string[]),
      recommendation: row.recommendation, state: 'review-required' as const })));
  }
  backfillOperational(repositoryId: string): number {
    assertIdentifier(repositoryId);
    if (!this.tableExists('operational_candidates') || !this.tableExists('operational_episodes')) return 0;
    return this.transaction(() => {
      const rows = this.database.prepare(`SELECT c.id, e.session_id, c.kind, c.statement ${pendingOperationalWhere}
        ORDER BY c.id LIMIT ?`).all(repositoryId, BACKFILL_BATCH) as unknown as OperationalRow[];
      for (const row of rows) {
        if (!kinds.has(row.kind)) continue;
        const evidenceEventIds = this.tableExists('operational_candidate_evidence')
          ? (this.database.prepare('SELECT event_id FROM operational_candidate_evidence WHERE candidate_id = ? ORDER BY event_id')
              .all(row.id) as Array<{ event_id: string }>).map(({ event_id }) => event_id)
          : [];
        this.insertCandidate({ repositoryId, kind: row.kind, applicability: { scope: 'repository' },
          originId: row.id, sessionId: row.session_id, source: 'operational',
          statement: safeBackfillStatement(row.statement), evidenceEventIds });
      }
      return rows.length;
    });
  }
  previewOperationalBackfill(repositoryId: string): { readonly pendingCount: number; readonly nextCursor: string | null } {
    assertIdentifier(repositoryId);
    if (!this.tableExists('operational_candidates') || !this.tableExists('operational_episodes')) {
      return { pendingCount: 0, nextCursor: null };
    }
    const row = this.database.prepare(`SELECT COUNT(*) AS pending_count, MIN(c.id) AS next_cursor ${pendingOperationalWhere}`)
      .get(repositoryId) as { pending_count: number; next_cursor: string | null };
    return Object.freeze({ pendingCount: row.pending_count, nextCursor: row.next_cursor });
  }

  private validateReviewEvidence(row: CandidateRow, request: CandidateReviewRequest, witness: CandidateReviewWitness): void {
    if (row.state === 'disputed' && witness.revalidatesCandidateId !== row.id) {
      throw new Error('Disputed candidate requires explicit revalidation evidence.');
    }
    if (request.target === 'disputed') {
      if (witness.kind !== 'contradiction') throw new Error('Dispute requires contradiction evidence.');
      return;
    }
    if (request.target === 'observed' || request.target === 'confirmed') {
      if (witness.kind !== 'observation' && witness.kind !== 'instruction-context' &&
        witness.kind !== 'deterministic-fact' && witness.kind !== 'user-confirmed-fact') {
        throw new Error('Observation requires source evidence.');
      }
      if (request.target === 'confirmed') {
        const existing = this.database.prepare(`SELECT 1 FROM acl_candidate_reviews
          WHERE candidate_id = ? AND evidence_origin_id = ? AND to_state IN ('observed', 'confirmed') LIMIT 1`)
          .get(row.id, witness.originId);
        if (existing) throw new Error('Confirmation requires independent evidence origin.');
      }
      return;
    }
    if (request.target !== 'verified') throw new Error('Review target requires separate lifecycle handling.');
    if (!witness.contextRevision || !witness.contextRevision.trim()) {
      throw new Error('Verification requires witnessed context revision.');
    }
    assertIdentifier(witness.contextRevision);
    if (witness.operationSignature !== undefined) {
      assertIdentifier(witness.operationSignature);
      if (!witness.operationSignature.startsWith('operation:v1:')) throw new Error('Operation signature is not versioned.');
    }
    if (row.kind === 'project-fact') {
      if (witness.kind !== 'deterministic-fact' && witness.kind !== 'user-confirmed-fact') {
        throw new Error('Project fact requires a qualifying fact witness.');
      }
      if (!row.proposition_key || witness.factKey !== row.proposition_key) {
        throw new Error('Project fact witness does not match the proposition.');
      }
      return;
    }
    if (row.kind === 'convention') {
      if (witness.kind !== 'instruction-context') throw new Error('Convention requires instruction context evidence.');
      return;
    }
    if (witness.kind !== 'task-verification' || !witness.taskId ||
      (row.procedure_key !== null && witness.procedureKey !== row.procedure_key)) {
      throw new Error('Repair verification requires task-relevant verification evidence.');
    }
    assertIdentifier(witness.taskId);
  }

  private initialize(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS acl_candidates (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('candidate','observed','confirmed','verified','disputed','superseded','rejected','expired')),
      statement TEXT NOT NULL, applicability_json TEXT NOT NULL, proposition_key TEXT, procedure_key TEXT,
      supersedes_id TEXT REFERENCES acl_candidates(id), superseded_by_id TEXT REFERENCES acl_candidates(id),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      contradiction_state TEXT NOT NULL DEFAULT 'clear' CHECK(contradiction_state IN ('clear','disputed')),
      verified_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS acl_candidates_repository ON acl_candidates(repository_id, id);
    CREATE TABLE IF NOT EXISTS acl_candidate_origins (
      candidate_id TEXT NOT NULL REFERENCES acl_candidates(id), source TEXT NOT NULL,
      origin_id TEXT NOT NULL, session_id TEXT, evidence_json TEXT NOT NULL,
      PRIMARY KEY(candidate_id, source, origin_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS acl_review_required (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL,
      root_cause_id TEXT NOT NULL, finding_ids_json TEXT NOT NULL, recommendation TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS acl_review_required_repository ON acl_review_required(repository_id, id);
    CREATE TABLE IF NOT EXISTS acl_candidate_reviews (
      id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES acl_candidates(id), revision INTEGER NOT NULL,
      from_state TEXT NOT NULL, to_state TEXT NOT NULL, actor_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL, evidence_origin_id TEXT NOT NULL, evidence_kind TEXT NOT NULL,
      verification_evidence_id TEXT, context_revision TEXT, operation_signature TEXT,
      reviewed_at TEXT NOT NULL, UNIQUE(candidate_id, evidence_id)
    ) STRICT;`);
  }
  private insertCandidate(input: CandidateRegistration): string {
    const id = canonicalCandidateIdentity({ ...input, originId: `${input.source}:${input.originId}` });
    if (!kinds.has(input.kind)) throw new TypeError('Candidate kind is invalid.');
    assertDurableText(input.statement);
    if (input.sessionId !== undefined) assertIdentifier(input.sessionId);
    if (input.source !== 'operational' && input.source !== 'manual-review') throw new TypeError('Candidate source is invalid.');
    const evidenceEventIds = [...new Set(input.evidenceEventIds ?? [])].sort();
    for (const evidenceId of evidenceEventIds) assertIdentifier(evidenceId);
    this.database.prepare(`INSERT INTO acl_candidates
      (id, repository_id, kind, state, statement, applicability_json, proposition_key, procedure_key)
      VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(id, input.repositoryId, input.kind, input.statement,
        JSON.stringify(input.applicability), input.propositionKey ?? null, input.procedureKey ?? null);
    this.database.prepare(`INSERT INTO acl_candidate_origins
      (candidate_id, source, origin_id, session_id, evidence_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id, source, origin_id) DO NOTHING`)
      .run(id, input.source, input.originId, input.sessionId ?? null, JSON.stringify(evidenceEventIds));
    return id;
  }
  private insertReviewRequired(input: ReviewRequiredRegistration): string {
    assertIdentifier(input.repositoryId); assertIdentifier(input.sessionId); assertIdentifier(input.rootCauseId);
    if (!input.findingIds.length) throw new TypeError('Review-required finding IDs are invalid.');
    for (const findingId of input.findingIds) assertIdentifier(findingId);
    assertDurableText(input.recommendation);
    const id = `acl-review-required:v1:${createHash('sha256')
      .update(JSON.stringify([input.repositoryId, input.sessionId, input.rootCauseId])).digest('hex')}`;
    this.database.prepare(`INSERT INTO acl_review_required
      (id, repository_id, session_id, root_cause_id, finding_ids_json, recommendation) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`)
      .run(id, input.repositoryId, input.sessionId, input.rootCauseId, JSON.stringify([...new Set(input.findingIds)].sort()), input.recommendation);
    return id;
  }
  private toRecord(row: CandidateRow): CandidateRecord {
    const origins = this.database.prepare('SELECT * FROM acl_candidate_origins WHERE candidate_id = ? ORDER BY source, origin_id')
      .all(row.id) as Array<{ source: CandidateRegistration['source']; origin_id: string; session_id: string | null; evidence_json: string }>;
    return Object.freeze({ id: row.id, repositoryId: row.repository_id, state: row.state, kind: row.kind,
      statement: row.statement, applicability: JSON.parse(row.applicability_json) as CandidateIdentityInput['applicability'],
      revision: row.revision, contradictionState: row.contradiction_state,
      ...(row.supersedes_id === null ? {} : { supersedesId: row.supersedes_id }),
      ...(row.superseded_by_id === null ? {} : { supersededById: row.superseded_by_id }),
      origins: Object.freeze(origins.map((origin) => Object.freeze({ source: origin.source, originId: origin.origin_id,
        ...(origin.session_id === null ? {} : { sessionId: origin.session_id }),
        evidenceEventIds: Object.freeze(JSON.parse(origin.evidence_json) as string[]) }))) });
  }
  private tableExists(name: string): boolean {
    return this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }
  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}

function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 512 || value !== value.trim()) throw new TypeError('Candidate identifier is invalid.');
}
function assertTimestamp(value: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('Review timestamp is invalid.');
  }
}
function assertDurableText(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) throw new TypeError('Candidate text is invalid.');
  assertDurableTextSafe(value);
}
function safeBackfillStatement(value: string): string {
  try { assertDurableText(value); return value; } catch { return 'Operational candidate'; }
}
