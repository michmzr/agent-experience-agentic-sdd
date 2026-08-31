import type { LessonKind } from '../domain/types.js';
import { projectFindingSeverities } from './project-improvements.js';

const proposalCategories = ['documentation', 'knowledge', 'code', 'tooling', 'skill', 'workflow', 'architecture', 'developer-experience', 'project-management'] as const;
const specificationCategories = new Set<ProposalCategory>(['code', 'tooling', 'skill', 'workflow', 'architecture']);

export type ProposalCategory = (typeof proposalCategories)[number];
export type ProposalSeverity = (typeof projectFindingSeverities)[number];

export interface ReviewFindingForProposal {
  readonly id: string;
  readonly statement: string;
  readonly lessonKind: LessonKind;
  readonly proposal: {
    readonly category: ProposalCategory;
    readonly title: string;
  };
  readonly severity?: ProposalSeverity;
  readonly evidenceEventIds?: readonly string[];
  readonly findingIds?: readonly string[];
}

export interface CandidateLesson {
  readonly id: string;
  readonly sessionId: string;
  readonly findingId: string;
  readonly state: 'candidate';
  readonly kind: LessonKind;
  readonly statement: string;
}

export interface ImprovementProposal {
  readonly id: string;
  readonly sessionId: string;
  readonly findingId: string;
  readonly candidateId: string;
  readonly category: ProposalCategory;
  readonly title: string;
  readonly requiresSpecification: boolean;
  readonly severity?: ProposalSeverity;
  readonly evidenceEventIds?: readonly string[];
  readonly findingIds?: readonly string[];
}

export interface CreateReviewProposalsInput {
  readonly sessionId: string;
  readonly findings: readonly ReviewFindingForProposal[];
}

export interface ReviewProposalResult {
  readonly candidates: readonly CandidateLesson[];
  readonly proposals: readonly ImprovementProposal[];
}

export function createReviewProposals(input: CreateReviewProposalsInput): ReviewProposalResult {
  requireText(input.sessionId, 'Session id');
  const findings = [...input.findings].sort((left, right) => compareText(left.id, right.id));
  const findingIds = new Set<string>();

  for (const finding of findings) {
    requireText(finding.id, 'Finding id');
    requireText(finding.statement, 'Finding statement');
    requireText(finding.proposal.title, 'Proposal title');
    if (!proposalCategories.includes(finding.proposal.category)) throw new Error('Proposal category is unsupported.');
    if (finding.severity !== undefined && !projectFindingSeverities.includes(finding.severity)) throw new Error('Proposal severity is unsupported.');
    if (finding.evidenceEventIds !== undefined) validateEvidenceEventIds(finding.evidenceEventIds);
    if (finding.findingIds !== undefined) validateFindingIds(finding.findingIds);
    if (findingIds.has(finding.id)) throw new Error(`Duplicate finding id: ${finding.id}.`);
    findingIds.add(finding.id);
  }

  const candidates = findings.map((finding) => createCandidate(input.sessionId, finding));
  const proposals = findings.map((finding, index) => createProposal(input.sessionId, finding, candidates[index].id));
  return { candidates, proposals };
}

function createCandidate(sessionId: string, finding: ReviewFindingForProposal): CandidateLesson {
  return {
    id: `candidate:${sessionId}:${finding.id}`,
    sessionId,
    findingId: finding.id,
    state: 'candidate',
    kind: finding.lessonKind,
    statement: finding.statement
  };
}

function createProposal(sessionId: string, finding: ReviewFindingForProposal, candidateId: string): ImprovementProposal {
  return {
    id: `proposal:${sessionId}:${finding.id}`,
    sessionId,
    findingId: finding.id,
    candidateId,
    category: finding.proposal.category,
    title: finding.proposal.title,
    requiresSpecification: specificationCategories.has(finding.proposal.category),
    ...(finding.severity === undefined ? {} : { severity: finding.severity }),
    ...(finding.evidenceEventIds === undefined ? {} : { evidenceEventIds: [...finding.evidenceEventIds] }),
    ...(finding.findingIds === undefined ? {} : { findingIds: [...finding.findingIds] })
  };
}

function validateEvidenceEventIds(eventIds: readonly string[]): void {
  validateIdentifiers(eventIds, 'Evidence event ids');
}

function validateFindingIds(findingIds: readonly string[]): void {
  validateIdentifiers(findingIds, 'Finding ids');
}

function validateIdentifiers(ids: readonly string[], label: string): void {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`${label} must be nonempty, unique, nonblank strings.`);
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim().length === 0 || id.trim() !== id || unique.has(id)) {
      throw new Error(`${label} must be nonempty, unique, nonblank strings.`);
    }
    unique.add(id);
  }
}

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} is required.`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
