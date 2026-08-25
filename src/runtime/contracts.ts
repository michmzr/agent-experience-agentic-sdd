import type { KnowledgeState } from '../domain/types.js';

export type OperationClass = 'normal' | 'caution' | 'protected';
export type DecisionOutcome = 'ALLOW' | 'WARN' | 'BLOCK';
export type MatchStrength = 'exact' | 'metadata' | 'tags';

export interface ActionSignature {
  readonly kind: 'action';
  readonly tool: string;
  readonly action: string;
  readonly arguments?: readonly string[];
  readonly path?: string;
}

export interface IntentSignature {
  readonly kind: 'intent';
  readonly verb: string;
  readonly target: string;
  readonly tool?: string;
  readonly path?: string;
}

export type RuntimeSignature = ActionSignature | IntentSignature;

interface RuntimeInputContext {
  readonly repositoryId?: string;
  readonly operationClass: OperationClass;
  readonly tags?: readonly string[];
}

export type RuntimeInput =
  | (RuntimeInputContext & { readonly signature: ActionSignature })
  | (RuntimeInputContext & { readonly signature: IntentSignature });

export interface RuleApplicability {
  readonly scope: 'global' | 'repository';
  readonly repositoryId?: string;
  readonly tool?: string;
  readonly path?: string;
  readonly tags?: readonly string[];
}

export interface RuntimeReference {
  readonly knowledgeId: string;
  readonly evidenceIds: readonly string[];
  readonly source?: string;
}

export interface RuntimeRule {
  readonly id: string;
  readonly state: KnowledgeState;
  readonly authoritative: boolean;
  readonly effect: 'conflict' | 'context';
  readonly signature: RuntimeSignature;
  readonly applicability: RuleApplicability;
  readonly reference: RuntimeReference;
}

export interface RuleMatch {
  readonly rule: RuntimeRule;
  readonly strength: MatchStrength;
  readonly operationClass: OperationClass;
}

export interface RuntimeProfile {
  readonly id: string;
  readonly hardBlocking: boolean;
  readonly warningsEnabled: boolean;
  readonly captureEnabled: boolean;
  readonly retrievalEnabled: boolean;
  readonly degradedOutcomes: Readonly<Record<OperationClass, DecisionOutcome>>;
}

export type RuntimeExplanationCode =
  | 'VERIFIED_EXACT_CONFLICT'
  | 'VERIFIED_METADATA_CONFLICT'
  | 'CONFIRMED_CONFLICT'
  | 'CONTEXT_ONLY'
  | 'INACTIVE_RULE'
  | 'HARD_BLOCKING_DISABLED'
  | 'WARNINGS_DISABLED';

export interface DecisionExplanation {
  readonly code: RuntimeExplanationCode;
  readonly message: string;
  readonly ruleId: string;
  readonly matchStrength: MatchStrength;
  readonly authoritative: boolean;
  readonly knowledgeState: KnowledgeState;
}

export interface DecisionReference {
  readonly ruleId: string;
  readonly knowledgeId: string;
  readonly evidenceIds: readonly string[];
  readonly source?: string;
}

export interface RuntimeDecision {
  readonly outcome: DecisionOutcome;
  readonly operationClass: OperationClass;
  readonly explanation: DecisionExplanation;
  readonly references: readonly DecisionReference[];
  readonly captureEnabled: boolean;
  readonly retrievalEnabled: boolean;
}

/** Optional semantic work belongs outside deterministic runtime matching. */
export interface SemanticMatchEnricher {
  enrich(
    input: RuntimeInput,
    deterministicMatches: readonly RuleMatch[]
  ): Promise<readonly RuleMatch[]>;
}
