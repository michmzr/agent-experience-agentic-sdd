import { createHash } from 'node:crypto';

import type { CapturedEventRecord } from '../capture/contracts.js';
import { createLearningCandidate, createOperationalEpisode, type EpisodeEvidence, type LearningCandidate, type OperationalEpisode, type OperationalFinding } from './contracts.js';
import type { ProjectToolConvention } from './project-conventions.js';

const detectorVersion = 'm6-deterministic@1';

export interface DetectorInput {
  readonly repositoryId: string;
  readonly sessionId: string;
  readonly events: readonly CapturedEventRecord[];
  readonly conventions: readonly ProjectToolConvention[];
  readonly episodeEvidence?: readonly EpisodeEvidence[];
}

export interface DetectorResult {
  readonly episodes: readonly OperationalEpisode[];
  readonly findings: readonly OperationalFinding[];
  readonly candidates: readonly LearningCandidate[];
}

interface Operation {
  readonly request: CapturedEventRecord;
  readonly result?: CapturedEventRecord;
}

export function detectOperationalEpisodes(input: DetectorInput): DetectorResult {
  const convention = conventionEpisodes(input);
  const repairs = repairEpisodes(input);
  return Object.freeze({
    episodes: Object.freeze([...convention.episodes, ...repairs.episodes].sort(byId)),
    findings: Object.freeze([...repairs.findings].sort(byId)),
    candidates: Object.freeze([...convention.candidates, ...repairs.candidates].sort(byId))
  });
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
