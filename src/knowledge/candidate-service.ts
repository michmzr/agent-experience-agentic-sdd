import type { CandidateRepository, CandidateRecord, VerifiedLocalEntry, CandidateReviewRequest, CandidateReviewWitness } from './candidate-repository.js';
import type { CandidateIdentityInput } from './candidate-identity.js';
import type { ManualReviewResult } from '../review/review-service.js';

export class CandidateService {
  constructor(private readonly repository: CandidateRepository,
    private readonly evidenceResolver?: { resolve(repositoryId: string, evidenceId: string): CandidateReviewWitness | undefined }) {}
  backfillOperational(repositoryId: string): number {
    let total = 0;
    let batch: number;
    do { batch = this.repository.backfillOperational(repositoryId); total += batch; } while (batch === 1_024);
    return total;
  }
  registerManualReview(repositoryId: string, applicability: CandidateIdentityInput['applicability'],
    output: Pick<ManualReviewResult, 'selectedSession' | 'candidates' | 'reviewRequired'>): void {
    this.repository.registerBatch(output.candidates.map((candidate) => ({
      repositoryId, applicability, kind: candidate.kind, statement: candidate.statement,
      originId: candidate.id, sessionId: output.selectedSession, source: 'manual-review' as const
    })), output.reviewRequired.map((finding) => ({
      repositoryId, sessionId: output.selectedSession, rootCauseId: finding.rootCauseId,
      findingIds: finding.findingIds, recommendation: finding.recommendation
    })));
  }
  list(repositoryId: string): readonly CandidateRecord[] { return this.repository.list(repositoryId); }
  inspect(repositoryId: string, id: string): CandidateRecord | undefined { return this.repository.inspect(repositoryId, id); }
  listVerifiedLocalEntries(repositoryId: string): readonly VerifiedLocalEntry[] {
    return this.repository.listVerifiedLocalEntries(repositoryId);
  }
  review(request: CandidateReviewRequest): CandidateRecord {
    if (!this.evidenceResolver) throw new Error('Candidate review requires an evidence resolver.');
    const witness = this.evidenceResolver.resolve(request.repositoryId, request.evidenceId);
    if (!witness) throw new Error('Review evidence was not found.');
    return this.repository.review(request, witness);
  }
}
