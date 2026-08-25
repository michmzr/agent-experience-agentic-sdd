import type {
  DecisionOutcome,
  DecisionReference,
  MatchStrength,
  OperationClass,
  RuntimeExplanationCode,
  RuntimeInput,
  RuntimeProfile
} from './contracts.js';
import { evaluateRule } from './policy.js';
import type { RuleIndex } from './rule-index.js';
import type { RuntimeStatus } from './resilience.js';

export type GateExplanationCode = RuntimeExplanationCode | 'DEGRADED_POLICY';

export interface GateExplanation {
  readonly code: GateExplanationCode;
  readonly message: string;
  readonly outcome: DecisionOutcome;
  readonly ruleId?: string;
  readonly matchStrength?: MatchStrength;
  readonly authoritative?: boolean;
  readonly knowledgeState?: string;
}

export interface RuntimeOverrideDecisionMetadata {
  readonly overrideId: string;
  readonly scope: 'rule' | 'action' | 'task-session';
  readonly overriddenRuleIds: readonly string[];
}

export interface GateDecision {
  readonly outcome: DecisionOutcome;
  readonly operationClass: OperationClass;
  readonly explanations: readonly GateExplanation[];
  readonly references: readonly DecisionReference[];
  readonly captureEnabled: boolean;
  readonly retrievalEnabled: boolean;
  readonly status: RuntimeStatus;
  readonly override?: RuntimeOverrideDecisionMetadata;
}

export interface RuntimeGate {
  evaluate(input: RuntimeInput): GateDecision;
}

export interface RuntimeGateOptions {
  readonly index?: RuleIndex;
  readonly profile: RuntimeProfile;
  readonly status: RuntimeStatus;
}

const outcomeRank: Readonly<Record<DecisionOutcome, number>> = Object.freeze({ ALLOW: 0, WARN: 1, BLOCK: 2 });

/** Builds a synchronous decision gate over an already resolved immutable runtime state. */
export function createRuntimeGate(options: RuntimeGateOptions): RuntimeGate {
  assertResolvedState(options);
  const index = options.index;
  const profile: RuntimeProfile = Object.freeze({
    ...options.profile,
    degradedOutcomes: Object.freeze({ ...options.profile.degradedOutcomes })
  });
  const status: RuntimeStatus = Object.freeze({ ...options.status });

  return Object.freeze({
    evaluate(input: RuntimeInput): GateDecision {
      if (status.retrievalMode === 'degraded') return degradedDecision(input.operationClass, profile, status);

      const decisions = index!.match(input).map((match) => evaluateRule(match, profile));
      const explanations = decisions.map((decision) => Object.freeze({
        ...decision.explanation,
        outcome: decision.outcome
      }));
      const references = decisions.flatMap((decision) => decision.references.map((reference) => freezeReference(reference)));
      return freezeDecision({
        outcome: strongest(explanations.map(({ outcome }) => outcome)),
        operationClass: input.operationClass,
        explanations,
        references,
        captureEnabled: profile.captureEnabled,
        retrievalEnabled: profile.retrievalEnabled,
        status
      });
    }
  });
}

export function strongest(outcomes: readonly DecisionOutcome[]): DecisionOutcome {
  return outcomes.reduce<DecisionOutcome>((selected, outcome) =>
    outcomeRank[outcome] > outcomeRank[selected] ? outcome : selected, 'ALLOW');
}

export function freezeDecision(decision: GateDecision): GateDecision {
  const explanations = Object.freeze(decision.explanations.map((item) => Object.freeze({ ...item })));
  const references = Object.freeze(decision.references.map(freezeReference));
  const override = decision.override === undefined ? undefined : Object.freeze({
    ...decision.override,
    overriddenRuleIds: Object.freeze([...decision.override.overriddenRuleIds])
  });
  return Object.freeze({ ...decision, explanations, references, ...(override === undefined ? {} : { override }) });
}

function degradedDecision(operationClass: OperationClass, profile: RuntimeProfile, status: RuntimeStatus): GateDecision {
  const outcome = operationClass === 'normal' ? 'ALLOW' : profile.degradedOutcomes[operationClass];
  const explanation: GateExplanation = Object.freeze({
    code: 'DEGRADED_POLICY',
    message: 'Runtime knowledge is unavailable; the configured degraded policy applies.',
    outcome
  });
  return freezeDecision({
    outcome,
    operationClass,
    explanations: [explanation],
    references: [],
    captureEnabled: profile.captureEnabled,
    retrievalEnabled: profile.retrievalEnabled,
    status
  });
}

function assertResolvedState(options: RuntimeGateOptions): void {
  if (options.status.profileId !== options.profile.id || options.status.hardBlocking !== options.profile.hardBlocking) {
    throw new TypeError('Runtime status does not describe the resolved profile.');
  }
  const degraded = options.status.retrievalMode === 'degraded' || options.status.fallbackSource === 'degraded-policy';
  if (degraded && options.index !== undefined) throw new TypeError('A degraded runtime gate cannot accept a rule index.');
  if (!degraded && options.index === undefined) throw new TypeError('A deterministic runtime gate requires a rule index.');
  if (degraded !== (options.status.retrievalMode === 'degraded' && options.status.fallbackSource === 'degraded-policy')) {
    throw new TypeError('Runtime status has inconsistent degradation fields.');
  }
  if (degraded !== (options.status.health === 'degraded')) {
    throw new TypeError('Runtime status has inconsistent health and degradation fields.');
  }
}

function freezeReference(reference: DecisionReference): DecisionReference {
  return Object.freeze({ ...reference, evidenceIds: Object.freeze([...reference.evidenceIds]) });
}
