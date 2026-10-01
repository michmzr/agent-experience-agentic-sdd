import { isTrustedCodexCliJsonStream, type TrustedCodexCliJsonStream } from '../capture/adapters/codex-cli-json.js';
import { bindObservedDeterministicOutcome, type DeterministicOutcomeWitness } from '../advice/observed-outcome.js';
import type { StoredAdviceBundle } from '../advice/usage.js';
import { checkPackageManagerScenario, packageManagerFixtureDigest, type ScenarioOperation } from './real-scenario.js';

/** Only a completed verified child stream and the fixed local checker may mint this witness. */
export function observeRealOutcome(input: { readonly root: string; readonly expectedGitDigest: string;
  readonly protocolDigest: string; readonly bundle: StoredAdviceBundle; readonly appliedEventId: string;
  readonly operations: readonly ScenarioOperation[]; readonly stream: TrustedCodexCliJsonStream }): DeterministicOutcomeWitness | null {
  if (!isTrustedCodexCliJsonStream(input.stream)
    || !/^[a-f0-9]{64}$/.test(input.protocolDigest)
    || !/^[a-f0-9]{64}$/.test(input.expectedGitDigest)
    || !qualifiesRealOutcome(input)) return null;
  return bindObservedDeterministicOutcome({ bundle: input.bundle, appliedEventId: input.appliedEventId,
    fixtureDigest: packageManagerFixtureDigest, protocolDigest: input.protocolDigest,
    sourceDigest: input.expectedGitDigest, stream: input.stream });
}

/** Pure qualification logic; it cannot mint a provenance-bearing witness. */
export function qualifiesRealOutcome(input: { readonly root: string; readonly expectedGitDigest: string;
  readonly bundle: StoredAdviceBundle; readonly appliedEventId: string;
  readonly operations: readonly ScenarioOperation[];
  readonly stream: Pick<TrustedCodexCliJsonStream, 'sessionId' | 'events' | 'childExitCode'> }): boolean {
  const { bundle, stream, appliedEventId } = input;
  if (stream.childExitCode !== 0 || stream.sessionId !== bundle.sessionId) return false;
  const command = input.operations.filter(operation => operation.id === appliedEventId
    && operation.kind === 'package-manager-check' && operation.outcome === 'succeeded');
  const starts = stream.events.filter(event => event.phase === 'pre-action'
    && event.sourceEventId === appliedEventId && event.sessionId === bundle.sessionId);
  const results = stream.events.filter(event => event.phase === 'post-result'
    && event.relatedEventId === appliedEventId && event.sessionId === bundle.sessionId
    && event.outcome === 'succeeded' && event.exitStatus === 0);
  if (command.length !== 1 || starts.length !== 1 || results.length !== 1) return false;
  const checked = checkPackageManagerScenario(input.root, command, input.expectedGitDigest);
  return checked.taskCorrect && checked.safetyViolations.length === 0;
}
