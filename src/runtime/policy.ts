import type {
  DecisionExplanation,
  DecisionOutcome,
  RuleMatch,
  RuntimeDecision,
  RuntimeExplanationCode,
  RuntimeProfile
} from './contracts.js';

const inactiveStates = new Set(['candidate', 'superseded', 'rejected', 'expired']);

export function evaluateRule(match: RuleMatch, profile: RuntimeProfile): RuntimeDecision {
  const policy = basePolicy(match);
  const applied = applyProfile(policy.outcome, policy.code, profile);
  const explanation = freezeExplanation(match, applied.code);
  const reference = Object.freeze({
    ruleId: match.rule.id,
    knowledgeId: match.rule.reference.knowledgeId,
    evidenceIds: Object.freeze([...match.rule.reference.evidenceIds]),
    ...(match.rule.reference.source === undefined ? {} : { source: match.rule.reference.source })
  });

  return Object.freeze({
    outcome: applied.outcome,
    operationClass: match.operationClass,
    explanation,
    references: Object.freeze([reference]),
    captureEnabled: profile.captureEnabled,
    retrievalEnabled: profile.retrievalEnabled
  });
}

function basePolicy(match: RuleMatch): { outcome: DecisionOutcome; code: RuntimeExplanationCode } {
  const { rule, strength } = match;

  if (inactiveStates.has(rule.state)) return { outcome: 'ALLOW', code: 'INACTIVE_RULE' };
  if (!rule.authoritative || rule.effect !== 'conflict' || rule.state === 'observed' || rule.state === 'disputed') {
    return { outcome: 'ALLOW', code: 'CONTEXT_ONLY' };
  }
  if (rule.state === 'verified' && strength === 'exact') {
    return { outcome: 'BLOCK', code: 'VERIFIED_EXACT_CONFLICT' };
  }
  if (rule.state === 'verified') {
    return strength === 'metadata'
      ? { outcome: 'WARN', code: 'VERIFIED_METADATA_CONFLICT' }
      : { outcome: 'WARN', code: 'VERIFIED_TAG_CONFLICT' };
  }
  if (rule.state === 'confirmed') return { outcome: 'WARN', code: 'CONFIRMED_CONFLICT' };

  return { outcome: 'ALLOW', code: 'CONTEXT_ONLY' };
}

function applyProfile(
  outcome: DecisionOutcome,
  code: RuntimeExplanationCode,
  profile: RuntimeProfile
): { outcome: DecisionOutcome; code: RuntimeExplanationCode } {
  if (outcome === 'BLOCK' && !profile.hardBlocking) {
    return profile.warningsEnabled
      ? { outcome: 'WARN', code: 'HARD_BLOCKING_DISABLED' }
      : { outcome: 'ALLOW', code: 'WARNINGS_DISABLED' };
  }
  if (outcome === 'WARN' && !profile.warningsEnabled) return { outcome: 'ALLOW', code: 'WARNINGS_DISABLED' };

  return { outcome, code };
}

function freezeExplanation(match: RuleMatch, code: RuntimeExplanationCode): DecisionExplanation {
  return Object.freeze({
    code,
    message: explanationMessage(code),
    ruleId: match.rule.id,
    matchStrength: match.strength,
    authoritative: match.rule.authoritative,
    knowledgeState: match.rule.state
  });
}

function explanationMessage(code: RuntimeExplanationCode): string {
  switch (code) {
    case 'VERIFIED_EXACT_CONFLICT': return 'A verified authoritative rule exactly conflicts with the operation.';
    case 'VERIFIED_METADATA_CONFLICT': return 'A verified authoritative rule conflicts through structured metadata.';
    case 'VERIFIED_TAG_CONFLICT': return 'A verified authoritative rule conflicts through matching tags.';
    case 'CONFIRMED_CONFLICT': return 'A confirmed authoritative rule conflicts with the operation.';
    case 'INACTIVE_RULE': return 'The rule lifecycle state is not active for runtime enforcement.';
    case 'HARD_BLOCKING_DISABLED': return 'The active profile converts hard blocking to a warning.';
    case 'WARNINGS_DISABLED': return 'The active profile retains the explanation without enforcement.';
    case 'CONTEXT_ONLY': return 'The rule is available as contextual knowledge only.';
  }
}
