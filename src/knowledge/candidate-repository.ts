import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LessonKind } from '../domain/types.js';
import { assertDurableTextSafe } from '../review/sanitizer.js';
import { openExperienceDatabase } from '../storage/database.js';
import { canonicalCandidateIdentity, type CandidateIdentityInput } from './candidate-identity.js';

const kinds = new Set<LessonKind>(['failure', 'successful-workflow', 'project-fact', 'convention', 'tool-capability', 'environment-quirk', 'heuristic', 'preference']);
const MAX_TEXT = 2_048;
const BACKFILL_BATCH = 1_024;

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
}
export interface ReviewRequiredRegistration {
  readonly repositoryId: string;
  readonly sessionId: string;
  readonly rootCauseId: string;
  readonly findingIds: readonly string[];
  readonly recommendation: string;
}
export interface ReviewRequiredRecord extends ReviewRequiredRegistration { readonly id: string; readonly state: 'review-required'; }

interface CandidateRow {
  id: string; repository_id: string; kind: LessonKind; state: CandidateRecord['state']; statement: string;
  applicability_json: string; revision: number; contradiction_state: CandidateRecord['contradictionState']; verified_at: string | null;
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
  list(repositoryId: string): readonly CandidateRecord[] {
    assertIdentifier(repositoryId);
    const rows = this.database.prepare('SELECT * FROM acl_candidates WHERE repository_id = ? ORDER BY id').all(repositoryId) as unknown as CandidateRow[];
    return Object.freeze(rows.map((row) => this.toRecord(row)));
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
    const rows = this.database.prepare(`SELECT c.* FROM acl_candidates c WHERE c.repository_id = ?
      AND c.state = 'verified' AND c.contradiction_state = 'clear' AND c.verified_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM acl_candidate_reviews r WHERE r.candidate_id = c.id
        AND r.outcome = 'verified' AND r.verification_evidence_id IS NOT NULL)
      ORDER BY c.id`).all(repositoryId) as unknown as CandidateRow[];
    return Object.freeze(rows.map((row) => Object.freeze({ candidateId: row.id, repositoryId: row.repository_id,
      revision: row.revision, kind: row.kind, statement: row.statement,
      applicability: JSON.parse(row.applicability_json) as CandidateIdentityInput['applicability'],
      state: 'verified' as const, verifiedAt: row.verified_at!, contradictionState: 'clear' as const })));
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
      const rows = this.database.prepare(`SELECT c.id, e.session_id, c.kind, c.statement
        FROM operational_candidates c JOIN operational_episodes e ON e.id = c.episode_id
        WHERE e.repository_id = ? AND c.state = 'candidate' AND c.kind IN ('convention', 'successful-workflow')
        AND NOT EXISTS (SELECT 1 FROM acl_candidate_origins o JOIN acl_candidates a ON a.id = o.candidate_id
          WHERE o.source = 'operational' AND o.origin_id = c.id AND a.repository_id = e.repository_id)
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

  private initialize(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS acl_candidates (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('candidate','observed','confirmed','verified','disputed','superseded','rejected','expired')),
      statement TEXT NOT NULL, applicability_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
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
      id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES acl_candidates(id),
      outcome TEXT NOT NULL, verification_evidence_id TEXT, reviewed_at TEXT NOT NULL
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
      (id, repository_id, kind, state, statement, applicability_json) VALUES (?, ?, ?, 'candidate', ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(id, input.repositoryId, input.kind, input.statement, JSON.stringify(input.applicability));
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
function assertDurableText(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) throw new TypeError('Candidate text is invalid.');
  assertDurableTextSafe(value);
}
function safeBackfillStatement(value: string): string {
  try { assertDurableText(value); return value; } catch { return 'Operational candidate'; }
}
