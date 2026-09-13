import { createHash } from 'node:crypto';

import type { CapturedEventRecord } from '../capture/contracts.js';
import { createEpisodeEvidence, createLearningCandidate, createOperationalEpisode, type EpisodeEvidence, type LearningCandidate, type OperationalEpisode, type OperationalFinding } from './contracts.js';
import type { ProjectToolConvention } from './project-conventions.js';

const detectorVersion = 'm6-deterministic@1';

export interface DetectorInput {
  readonly repositoryId: string;
  readonly sessionId: string;
  readonly events: readonly CapturedEventRecord[];
  readonly conventions: readonly ProjectToolConvention[];
  readonly episodeEvidence?: readonly EpisodeEvidence[];
}

export interface CorrectionEpisode extends OperationalEpisode {
  readonly kind: 'correction';
  readonly originalDecisionEvidenceId: string;
  readonly changedDecisionEvidenceId: string;
  readonly reasonEvidenceId?: string;
  readonly outcomeEvidenceId?: string;
}
export interface VerificationGapEpisode extends OperationalEpisode {
  readonly kind: 'verification-gap';
  readonly closureEvidenceId: string;
  readonly criterionEvidenceId?: string;
  readonly criterionState: 'met' | 'unmet' | 'unknown';
}
export interface RepeatedAcceptanceEpisode extends OperationalEpisode {
  readonly kind: 'repeated-acceptance';
  readonly firstAcceptanceEvidenceId: string;
  readonly repeatedAcceptanceEvidenceId: string;
  readonly scopeKey: string;
}
export type DerivedOperationalEpisode = (OperationalEpisode & { readonly kind?: never }) | CorrectionEpisode | VerificationGapEpisode | RepeatedAcceptanceEpisode;
export type DerivedOperationalFinding = OperationalFinding | (Omit<OperationalFinding, 'kind'> & { readonly kind: 'insufficient-evidence' });

export interface DetectorResult {
  readonly episodes: readonly DerivedOperationalEpisode[];
  readonly findings: readonly DerivedOperationalFinding[];
  readonly candidates: readonly LearningCandidate[];
}

interface Operation {
  readonly request: CapturedEventRecord;
  readonly result?: CapturedEventRecord;
}

export function detectOperationalEpisodes(input: DetectorInput): DetectorResult {
  const convention = conventionEpisodes(input);
  const repairs = repairEpisodes(input);
  const typed = typedEpisodes(input);
  return Object.freeze({
    episodes: Object.freeze([...convention.episodes, ...repairs.episodes, ...typed.episodes].sort(byId)),
    findings: Object.freeze([...repairs.findings, ...typed.findings].sort(byId)),
    candidates: Object.freeze([...convention.candidates, ...repairs.candidates].sort(byId))
  });
}

function typedEpisodes(input: DetectorInput): Pick<DetectorResult, 'episodes' | 'findings'> {
  const evidence = (input.episodeEvidence ?? []).map(createEpisodeEvidence).sort(byId);
  const episodes: DerivedOperationalEpisode[] = [];
  const findings: DerivedOperationalFinding[] = [];
  const byEvidenceId = new Map(evidence.map((item) => [item.id, item]));
  const decisions = evidence.filter(isDecision);

  for (const changed of decisions) {
    const originals = changed.evidenceIds.map((id) => byEvidenceId.get(id)).filter((item): item is EpisodeEvidence => item !== undefined && isDecision(item) && item.id !== changed.id && item.decisionKey === changed.decisionKey);
    if (originals.length > 0) {
      for (const original of originals) {
        const related = evidence.filter((item) => item.evidenceIds.includes(changed.id));
        const reason = related.find((item) => item.reasonClass !== undefined);
        const outcome = related.find((item) => item.kind === 'tool-result');
        const evidenceEventIds = [original.id, changed.id, ...(reason ? [reason.id] : []), ...(outcome ? [outcome.id] : [])];
        episodes.push(typedEpisode({
          id: stableId('episode', input.repositoryId, input.sessionId, detectorVersion, 'correction', ...evidenceEventIds), repositoryId: input.repositoryId, sessionId: input.sessionId, detector: detectorVersion, state: 'outcome-observed', evidenceEventIds,
          kind: 'correction', originalDecisionEvidenceId: original.id, changedDecisionEvidenceId: changed.id,
          ...(reason === undefined ? {} : { reasonEvidenceId: reason.id }), ...(outcome === undefined ? {} : { outcomeEvidenceId: outcome.id })
        }));
      }
    } else if (changed.kind === 'tool-request' && changed.state === 'succeeded' && decisions.some((item) => item.id !== changed.id && item.decisionKey === changed.decisionKey)) {
      const evidenceEventIds = [changed.id];
      const episodeId = stableId('episode', input.repositoryId, input.sessionId, detectorVersion, 'insufficient-evidence', ...evidenceEventIds);
      episodes.push(createOperationalEpisode({ id: episodeId, repositoryId: input.repositoryId, sessionId: input.sessionId, detector: detectorVersion, state: 'unresolved', evidenceEventIds }));
      findings.push(insufficientFinding(input, episodeId, evidenceEventIds, 'linked-decision-evidence'));
    }
  }

  for (const closure of evidence.filter((item) => item.kind === 'task-transition' && item.state === 'closed')) {
    const criterion = evidence.find((item) => item.kind === 'task-verification' && item.decisionKey === closure.decisionKey && item.scopeKey === closure.scopeKey);
    const criterionState = criterion === undefined ? 'unknown' : criterion.state === 'failed' ? 'unmet' : criterion.state === 'succeeded' ? 'met' : 'unknown';
    if (criterionState === 'met') continue;
    const evidenceEventIds = [closure.id, ...(criterion === undefined ? [] : [criterion.id])];
    episodes.push(typedEpisode({
      id: stableId('episode', input.repositoryId, input.sessionId, detectorVersion, 'verification-gap', ...evidenceEventIds), repositoryId: input.repositoryId, sessionId: input.sessionId, detector: detectorVersion, state: 'unresolved', evidenceEventIds,
      kind: 'verification-gap', closureEvidenceId: closure.id, ...(criterion === undefined ? {} : { criterionEvidenceId: criterion.id }), criterionState
    }));
  }

  const acceptances = evidence.filter((item) => item.kind === 'agent-claim' && item.state === 'succeeded' && item.decisionKey !== undefined && item.scopeKey !== undefined);
  for (let index = 0; index < acceptances.length; index += 1) for (let next = index + 1; next < acceptances.length; next += 1) {
    const first = acceptances[index]!; const repeated = acceptances[next]!;
    if (first.decisionKey !== repeated.decisionKey || first.scopeKey !== repeated.scopeKey || first.scopeKey === undefined) continue;
    const evidenceEventIds = [first.id, repeated.id];
    episodes.push(typedEpisode({
      id: stableId('episode', input.repositoryId, input.sessionId, detectorVersion, 'repeated-acceptance', ...evidenceEventIds), repositoryId: input.repositoryId, sessionId: input.sessionId, detector: detectorVersion, state: 'outcome-observed', evidenceEventIds,
      kind: 'repeated-acceptance', firstAcceptanceEvidenceId: first.id, repeatedAcceptanceEvidenceId: repeated.id, scopeKey: first.scopeKey
    }));
  }
  return { episodes, findings };
}

function isDecision(value: EpisodeEvidence): boolean {
  return value.kind === 'tool-request' || value.kind === 'agent-claim' || value.kind === 'user-instruction';
}

function typedEpisode<T extends DerivedOperationalEpisode>(value: T): T {
  return Object.freeze({ ...createOperationalEpisode(value), ...value }) as unknown as T;
}

function insufficientFinding(input: DetectorInput, episodeId: string, evidenceEventIds: readonly string[], missing: string): DerivedOperationalFinding {
  const id = stableId('finding', input.repositoryId, input.sessionId, detectorVersion, 'insufficient-evidence', missing, ...evidenceEventIds);
  return Object.freeze({ id, episodeId, kind: 'insufficient-evidence', evidenceEventIds: Object.freeze([...evidenceEventIds]), statement: `Missing ${missing}.` });
}

function conventionEpisodes(input: DetectorInput): Pick<DetectorResult, 'episodes' | 'candidates'> {
  const episodes: OperationalEpisode[] = [];
  const candidates: LearningCandidate[] = [];
  for (const convention of input.conventions) {
    const evidenceId = `instruction:${convention.source}`;
    const episodeId = stableId('episode', input.repositoryId, input.sessionId, detectorVersion, convention.digest, evidenceId);
    episodes.push(createOperationalEpisode({
      id: episodeId, repositoryId: input.repositoryId, sessionId: input.sessionId, detector: detectorVersion,
      state: 'solution-supported', evidenceEventIds: [evidenceId],
      attemptedOperation: convention.replaces, changedOperation: convention.tool,
      confirmingEventId: evidenceId
    }));
    candidates.push(createLearningCandidate({
      id: stableId('candidate', episodeId, convention.tool), episodeId, kind: 'convention', state: 'candidate',
      statement: `Use ${convention.tool} instead of ${convention.replaces} in this repository.`,
      conditions: [`repository:${input.repositoryId}`, `when a ${convention.tool === 'pnpm' ? 'Node package' : 'Python package'} command is required`],
      procedure: [`Use ${convention.tool} in place of ${convention.replaces}.`], evidenceEventIds: [evidenceId],
      invalidationConditions: [`The instruction at ${convention.source} changes or is removed.`]
    }));
  }
  return { episodes, candidates };
}

function repairEpisodes(input: DetectorInput): Pick<DetectorResult, 'episodes' | 'findings' | 'candidates'> {
  const operations = operationsFrom(input.events);
  const episodes: OperationalEpisode[] = [];
  const findings: OperationalFinding[] = [];
  const candidates: LearningCandidate[] = [];
  for (const failed of operations.filter(({ result }) => result?.outcome === 'failed')) {
    const replacement = operations.find((item) => item.request.occurredAt > failed.request.occurredAt && sameIntent(failed.request, item.request) && changedCommand(failed.request, item.request));
    if (replacement === undefined) continue;
    const evidenceEventIds = [failed.request.id, failed.result!.id, replacement.request.id, ...(replacement.result ? [replacement.result.id] : [])];
    const episodeId = stableId('episode', input.repositoryId, input.sessionId, detectorVersion, ...evidenceEventIds);
    if (unsafeChange(replacement.request)) {
      episodes.push(createOperationalEpisode({ id: episodeId, repositoryId: input.repositoryId, sessionId: input.sessionId, detector: detectorVersion, state: 'outcome-observed', evidenceEventIds, attemptedOperation: command(failed.request), changedOperation: command(replacement.request), hypothesis: 'The changed command requires separate safety review.' }));
      findings.push(finding(episodeId, evidenceEventIds, 'The changed command modifies privilege or destructive effect.'));
      continue;
    }
    episodes.push(createOperationalEpisode({ id: episodeId, repositoryId: input.repositoryId, sessionId: input.sessionId, detector: detectorVersion, state: 'outcome-observed', evidenceEventIds, attemptedOperation: command(failed.request), changedOperation: command(replacement.request), hypothesis: 'A source-declared task verification was not observed.' }));
    findings.push(finding(episodeId, evidenceEventIds, 'The changed command has no source-declared task verification.'));
  }
  return { episodes, findings, candidates };
}

function operationsFrom(events: readonly CapturedEventRecord[]): readonly Operation[] {
  const results = new Map(events.filter((event) => event.phase === 'post-result').map((event) => [event.relatedEventId, event]));
  return events.filter((event) => event.phase === 'pre-action').map((request) => ({ request, ...(results.get(request.sourceEventId) ? { result: results.get(request.sourceEventId) } : {}) }));
}

function sameIntent(left: CapturedEventRecord, right: CapturedEventRecord): boolean {
  return left.signature.kind === 'action' && right.signature.kind === 'action' && left.signature.arguments?.[0] !== undefined && left.signature.arguments[0] === right.signature.arguments?.[0];
}

function changedCommand(left: CapturedEventRecord, right: CapturedEventRecord): boolean {
  return command(left) !== command(right);
}

function unsafeChange(event: CapturedEventRecord): boolean {
  const commandParts = [event.signature.kind === 'action' ? event.signature.action : '', ...(event.signature.kind === 'action' ? event.signature.arguments ?? [] : [])];
  return commandParts.some((part) => ['sudo', 'doas', 'rm', '--force', '-f', '--delete'].includes(part));
}

function command(event: CapturedEventRecord): string {
  if (event.signature.kind !== 'action') return 'unknown';
  return [event.signature.action, ...(event.signature.arguments ?? [])].join(' ');
}

function finding(episodeId: string, evidenceEventIds: readonly string[], statement: string): OperationalFinding {
  return Object.freeze({ id: stableId('finding', episodeId, ...evidenceEventIds), episodeId, kind: 'ambiguous-repair', evidenceEventIds: Object.freeze([...evidenceEventIds]), statement });
}

function stableId(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}
