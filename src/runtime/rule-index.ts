import type { RuleMatch, RuntimeInput, RuntimeRule } from './contracts.js';
import { matchRules } from './matcher.js';
import { parseRuntimeSnapshot, type RuntimeSnapshotV1 } from './snapshot.js';

export interface RuleIndex {
  readonly repositoryId: string;
  readonly rules: readonly RuntimeRule[];
  match(input: RuntimeInput): readonly RuleMatch[];
}

export function createRuleIndex(snapshot: RuntimeSnapshotV1): RuleIndex {
  const validated = parseRuntimeSnapshot(snapshot);
  const repositoryId = validated.repositoryId;
  const rules = validated.rules;
  return Object.freeze({
    repositoryId,
    rules,
    match(input: RuntimeInput): readonly RuleMatch[] {
      return matchRules(input, rules);
    }
  });
}
