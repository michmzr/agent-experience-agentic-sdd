import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { annotationEvidenceId, readIndexedAnnotation } from '../evidence/import.js';
import { validateProjectInstructionContext, type ProjectToolConvention, type ScopedToolConvention } from '../learning/project-conventions.js';
import type { CandidateIdentityInput } from './candidate-identity.js';
import type { CandidateReviewWitness } from './candidate-repository.js';
import { resolvePackageManagerFact } from './package-manager-fact.js';

const MAX_ANNOTATIONS_PER_SESSION = 10_000;
const MAX_CONTEXT_BYTES = 128 * 1024;
const identifier = /^[A-Za-z0-9._:@/-]{1,512}$/;

type Applicability = CandidateIdentityInput['applicability'];
export interface InstructionContextEvidence {
  readonly id: string;
  readonly propositionKey: string;
  readonly contextRevision: string;
  readonly applicability: Applicability;
  readonly source: string;
  readonly tool: 'pnpm' | 'uv';
  readonly replaces: 'npm' | 'pip';
}

export function conventionPropositionKey(tool: 'pnpm' | 'uv', replaces: 'npm' | 'pip'): string {
  if (!((tool === 'pnpm' && replaces === 'npm') || (tool === 'uv' && replaces === 'pip'))) {
    throw new TypeError('Unsupported tool convention.');
  }
  return `tool-convention:${tool}-instead-of-${replaces}`;
}

/** Hash the exact persisted JSON text. Do not parse or reserialize it. */
export function operationSignatureFromStoredJson(signatureJson: string): string {
  return `operation:v1:${sha256(signatureJson)}`;
}

interface CaptureRow {
  readonly event_id: string;
  readonly source: string;
  readonly source_event_id: string;
  readonly phase: string | null;
  readonly signature_json: string | null;
  readonly capture_outcome: string | null;
  readonly exit_status: number | null;
}

interface AnnotationIndexRow { readonly producer_namespace: string; readonly evidence_id: string; }
interface AnnotationRow {
  readonly producer_namespace: string; readonly evidence_id: string; readonly repository_id: string;
  readonly session_id: string; readonly origin: string; readonly kind: string; readonly resolution: string;
  readonly context_revision: string; readonly payload_json: string; readonly content_digest: string;
  readonly operation_source: string; readonly operation_source_event_id: string;
}

/** A read-only resolver bound to one captured session. Unknown or unqualified evidence has no witness. */
export class SqliteCandidateEvidenceResolver {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly sessionId: string) {
    if (!identifier.test(sessionId)) throw new TypeError('Evidence session identity is invalid.');
    this.database = new DatabaseSync(databasePath, { readOnly: true, enableForeignKeyConstraints: true });
  }

  close(): void { this.database.close(); }

  capabilities(): { readonly observation: 'supported'; readonly taskVerification: 'conditional'; readonly instructionContext: 'conditional'; readonly projectFact: 'conditional' } {
    return Object.freeze({ observation: 'supported', taskVerification: 'conditional', instructionContext: 'conditional', projectFact: 'conditional' });
  }

  listInstructionContextEvidence(repositoryId: string): readonly InstructionContextEvidence[] {
    if (!identifier.test(repositoryId) || !this.sessionBelongsTo(repositoryId) ||
      !this.tableExists('capture_instruction_contexts')) return [];
    const rows = this.database.prepare(`SELECT c.source, c.source_event_id, c.payload_json
      FROM capture_instruction_contexts c JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id = ? AND c.repository_id = ? AND s.repository_id = ?
      ORDER BY c.source, c.source_event_id LIMIT 10001`)
      .all(this.sessionId, repositoryId, repositoryId) as Array<{
        source: string; source_event_id: string; payload_json: string | null }>;
    if (rows.length > 10000) return [];
    const evidence: InstructionContextEvidence[] = [];
    for (const row of rows) {
      if (!row.payload_json || Buffer.byteLength(row.payload_json) > MAX_CONTEXT_BYTES) continue;
      if (this.captureBySource(repositoryId, row.source, row.source_event_id)?.phase !== 'pre-action') continue;
      let context: ReturnType<typeof validateProjectInstructionContext>;
      try { context = validateProjectInstructionContext(JSON.parse(row.payload_json) as unknown); }
      catch { continue; }
      const directives: Array<{ convention: ProjectToolConvention | ScopedToolConvention; applicability: Applicability }> = [
        ...context.conventions.map((convention) => ({ convention, applicability: { scope: 'repository' as const } })),
        ...context.scopedConventions.map((convention) => ({ convention,
          applicability: { scope: 'subproject' as const, path: convention.scopePath } })) ];
      for (const { convention, applicability } of directives) {
        const id = instructionEvidenceId(repositoryId, this.sessionId, row.source, row.source_event_id,
          row.payload_json, convention, applicability);
        evidence.push(Object.freeze({ id, propositionKey: conventionPropositionKey(convention.tool, convention.replaces),
          contextRevision: `instruction:v1:${sha256(row.payload_json)}`,
          applicability, source: convention.source, tool: convention.tool, replaces: convention.replaces }));
      }
    }
    return Object.freeze(evidence);
  }

  resolve(repositoryId: string, evidenceId: string): CandidateReviewWitness | undefined {
    if (!identifier.test(repositoryId) || !identifier.test(evidenceId)) return undefined;
    if (!this.sessionBelongsTo(repositoryId)) return undefined;
    const capture = this.captureByEventId(repositoryId, evidenceId);
    if (capture?.phase === 'pre-action') {
      return Object.freeze({ id: evidenceId, repositoryId, originId: this.sessionId, kind: 'observation' });
    }
    return this.instructionWitness(repositoryId, evidenceId)
      ?? resolvePackageManagerFact(this.database, repositoryId, this.sessionId, evidenceId)
      ?? this.annotationWitness(repositoryId, evidenceId);
  }

  private instructionWitness(repositoryId: string, evidenceId: string): CandidateReviewWitness | undefined {
    const matches = this.listInstructionContextEvidence(repositoryId).filter((entry) => entry.id === evidenceId);
    if (matches.length !== 1) return undefined;
    const match = matches[0]!;
    return Object.freeze({ id: evidenceId, repositoryId, originId: this.sessionId, kind: 'instruction-context',
      propositionKey: match.propositionKey, applicability: match.applicability, contextRevision: match.contextRevision });
  }

  private sessionBelongsTo(repositoryId: string): boolean {
    if (!this.tableExists('sessions')) return false;
    return this.database.prepare('SELECT 1 FROM sessions WHERE id = ? AND repository_id = ?')
      .get(this.sessionId, repositoryId) !== undefined;
  }

  private captureByEventId(repositoryId: string, eventId: string): CaptureRow | undefined {
    if (!this.tableExists('logical_evidence')) return undefined;
    const rows = this.database.prepare(`SELECT l.event_id, l.source, l.source_event_id,
      COALESCE(ce.phase, re.phase) AS phase, COALESCE(ce.signature_json, re.signature_json) AS signature_json,
      COALESCE(ce.capture_outcome, re.capture_outcome) AS capture_outcome,
      COALESCE(e.exit_status, re.exit_status) AS exit_status
      FROM logical_evidence l JOIN sessions s ON s.id = l.session_id
      LEFT JOIN events e ON l.path = 'legacy' AND e.id = l.event_id
      LEFT JOIN capture_events ce ON l.path = 'legacy' AND ce.event_id = l.event_id
      LEFT JOIN capture_run_events re ON l.path = 'run' AND re.event_id = l.event_id
      WHERE l.session_id = ? AND s.repository_id = ? AND l.event_id = ?`)
      .all(this.sessionId, repositoryId, eventId) as unknown as CaptureRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  private captureBySource(repositoryId: string, source: string, sourceEventId: string): CaptureRow | undefined {
    const row = this.database.prepare(`SELECT l.event_id FROM logical_evidence l JOIN sessions s ON s.id = l.session_id
      WHERE l.session_id = ? AND s.repository_id = ? AND l.source = ? AND l.source_event_id = ?`)
      .get(this.sessionId, repositoryId, source, sourceEventId) as { event_id: string } | undefined;
    return row === undefined ? undefined : this.captureByEventId(repositoryId, row.event_id);
  }

  private annotationWitness(repositoryId: string, evidenceId: string): CandidateReviewWitness | undefined {
    if (!this.tableExists('logical_annotation_evidence') || !this.tableExists('imported_typed_evidence') ||
      !this.tableExists('capture_instruction_contexts')) return undefined;
    const indexed = this.database.prepare(`SELECT a.producer_namespace, a.evidence_id
      FROM logical_annotation_evidence a JOIN sessions s ON s.id = a.session_id
      WHERE a.session_id = ? AND a.repository_id = ? AND s.repository_id = ?
      ORDER BY a.ordinal LIMIT ?`).all(this.sessionId, repositoryId, repositoryId, MAX_ANNOTATIONS_PER_SESSION + 1) as unknown as AnnotationIndexRow[];
    if (indexed.length > MAX_ANNOTATIONS_PER_SESSION) return undefined;
    const matches = indexed.filter((row) => annotationEvidenceId(row.producer_namespace, repositoryId, this.sessionId, row.evidence_id) === evidenceId);
    if (matches.length !== 1) return undefined;
    const match = matches[0]!;
    const row = this.database.prepare(`SELECT * FROM imported_typed_evidence WHERE producer_namespace = ?
      AND repository_id = ? AND session_id = ? AND evidence_id = ?`)
      .get(match.producer_namespace, repositoryId, this.sessionId, match.evidence_id) as unknown as AnnotationRow | undefined;
    if (!row || row.resolution !== 'resolved' || row.origin !== 'user-declared' || row.kind !== 'task-verification' ||
      sha256(row.payload_json) !== row.content_digest) return undefined;
    let parsed: ReturnType<typeof readIndexedAnnotation>;
    try {
      parsed = readIndexedAnnotation({ payloadJson: row.payload_json,
        producerNamespace: row.producer_namespace, repositoryId, sessionId: this.sessionId, evidenceId: row.evidence_id });
    } catch { return undefined; }
    const { record, contextRevision } = parsed;
    if (record.origin !== 'user-declared' || record.kind !== 'task-verification' || record.state !== 'succeeded' ||
      record.reasonClass !== 'verification' || contextRevision !== row.context_revision ||
      record.operation.source !== row.operation_source || record.operation.sourceEventId !== row.operation_source_event_id) {
      return undefined;
    }
    const request = this.captureBySource(repositoryId, record.operation.source, record.operation.sourceEventId);
    if (!request || request.phase !== 'pre-action' || !request.signature_json) return undefined;
    const result = this.succeededResult(repositoryId, request);
    if (!result) return undefined;
    const instruction = this.database.prepare(`SELECT payload_json FROM capture_instruction_contexts
      WHERE source = ? AND source_event_id = ? AND session_id = ? AND repository_id = ?`)
      .get(request.source, request.source_event_id, this.sessionId, repositoryId) as { payload_json: string | null } | undefined;
    if (!instruction?.payload_json || Buffer.byteLength(instruction.payload_json) > MAX_CONTEXT_BYTES) return undefined;
    try { validateProjectInstructionContext(JSON.parse(instruction.payload_json) as unknown); }
    catch { return undefined; }
    return Object.freeze({ id: evidenceId, repositoryId, originId: this.sessionId,
      kind: 'task-verification', taskId: request.event_id, procedureKey: record.decisionKey,
      contextRevision: `instruction:v1:${sha256(instruction.payload_json)}`,
      operationSignature: operationSignatureFromStoredJson(request.signature_json) });
  }

  private succeededResult(repositoryId: string, request: CaptureRow): boolean {
    const rows = this.database.prepare(`SELECT l.event_id FROM logical_evidence l JOIN sessions s ON s.id = l.session_id
      LEFT JOIN events e ON l.path = 'legacy' AND e.id = l.event_id
      LEFT JOIN capture_events ce ON l.path = 'legacy' AND ce.event_id = l.event_id
      LEFT JOIN capture_run_events re ON l.path = 'run' AND re.event_id = l.event_id
      WHERE l.session_id = ? AND s.repository_id = ? AND l.source = ?
      AND COALESCE(ce.phase, re.phase) = 'post-result'
      AND COALESCE(ce.related_event_id, re.related_event_id) = ?
      AND COALESCE(ce.capture_outcome, re.capture_outcome) = 'succeeded'
      AND COALESCE(e.exit_status, re.exit_status) = 0
      AND COALESCE(ce.signature_json, re.signature_json) = ? LIMIT 1`)
      .all(this.sessionId, repositoryId, request.source, request.source_event_id, request.signature_json) as Array<{ event_id: string }>;
    return rows.length === 1;
  }

  private tableExists(name: string): boolean {
    return this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function instructionEvidenceId(repositoryId: string, sessionId: string, source: string, sourceEventId: string,
  payloadJson: string, convention: ProjectToolConvention | ScopedToolConvention, applicability: Applicability): string {
  return `instruction-witness:v1:${sha256(JSON.stringify([repositoryId, sessionId, source, sourceEventId,
    sha256(payloadJson), convention.source, convention.digest, convention.tool, convention.replaces, applicability]))}`;
}
