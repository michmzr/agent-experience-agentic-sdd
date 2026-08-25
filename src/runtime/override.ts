import { createHash } from 'node:crypto';

import { assertDurableTextSafe } from '../review/sanitizer.js';
import type { ActionSignature, DecisionReference, RuntimeInput } from './contracts.js';
import { freezeDecision, strongest, type GateDecision } from './gate.js';
import { canonicalSignature } from './matcher.js';

export type RuntimeOverrideScope =
  | { readonly kind: 'rule'; readonly ruleId: string }
  | { readonly kind: 'action'; readonly signatureHash: string }
  | { readonly kind: 'task-session'; readonly taskSessionId: string };

export type RuntimeOverrideInputScope =
  | { readonly kind: 'rule'; readonly ruleId: string }
  | { readonly kind: 'action'; readonly signature: ActionSignature }
  | { readonly kind: 'task-session'; readonly taskSessionId: string };

export interface RuntimeOverride {
  readonly id: string;
  readonly scope: RuntimeOverrideScope;
  readonly reason: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface RuntimeOverrideInput {
  readonly id: string;
  readonly scope: RuntimeOverrideInputScope;
  readonly reason: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export type OverrideRejection = 'EXPIRED' | 'NOT_YET_VALID' | 'SCOPE_MISMATCH' | 'DECISION_NOT_ENFORCING';

export interface OverrideApplication {
  readonly accepted: boolean;
  readonly decision: GateDecision;
  readonly rejection?: OverrideRejection;
}

export interface ApplyRuntimeOverrideInput {
  readonly decision: GateDecision;
  readonly input: RuntimeInput;
  readonly override: RuntimeOverride;
  readonly now: string;
  readonly taskSessionId?: string;
}

export type PostActionOutcome = 'succeeded' | 'failed' | 'unknown';

export interface OverrideAuditEntry {
  readonly id: string;
  readonly override: RuntimeOverride;
  readonly phase: 'authorized' | 'completed';
  readonly recordedAt: string;
  readonly decisionReferences: readonly DecisionReference[];
  readonly postActionOutcome?: PostActionOutcome;
}

export interface OverrideLearningEvidence {
  readonly ruleId: string;
  readonly polarity: 'contradicts';
  readonly successfulOverrideIds: readonly string[];
  readonly revalidationRequired: true;
}

const signatureHashPattern = /^[a-f0-9]{64}$/;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TEXT_LENGTH = 4_096;
const MAX_REFERENCES = 100;

export function createRuntimeOverride(input: RuntimeOverrideInput): RuntimeOverride {
  const id = checkedIdentifier(input.id, 'override id');
  const reason = input.reason.trim();
  assertNonEmpty(reason, 'override reason');
  assertBounded(reason, 'override reason', MAX_TEXT_LENGTH);
  assertDurableTextSafe(reason);
  assertTimestamp(input.createdAt);
  if (input.expiresAt !== undefined) {
    assertTimestamp(input.expiresAt);
    if (input.expiresAt <= input.createdAt) throw new TypeError('Override expiry must be after its creation timestamp.');
  }

  const scope: RuntimeOverrideScope = input.scope.kind === 'action'
    ? Object.freeze({ kind: 'action', signatureHash: hashSignature(input.scope.signature) })
    : input.scope.kind === 'rule'
      ? Object.freeze({ kind: 'rule', ruleId: checkedIdentifier(input.scope.ruleId, 'rule id') })
      : Object.freeze({ kind: 'task-session', taskSessionId: checkedIdentifier(input.scope.taskSessionId, 'task-session id') });

  return Object.freeze({
    id,
    scope,
    reason,
    createdAt: input.createdAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
  });
}

/** Reconstructs and validates the credential-safe persisted override form. */
export function parseRuntimeOverride(value: unknown): RuntimeOverride {
  if (!isRecord(value) || !onlyKeys(value, ['createdAt', 'expiresAt', 'id', 'reason', 'scope'])
    || typeof value.id !== 'string' || typeof value.reason !== 'string' || typeof value.createdAt !== 'string'
    || (value.expiresAt !== undefined && typeof value.expiresAt !== 'string') || !isRecord(value.scope)) {
    throw new TypeError('Invalid persisted runtime override.');
  }
  const id = checkedIdentifier(value.id, 'override id');
  const reason = value.reason.trim();
  if (reason !== value.reason) throw new TypeError('Persisted override reason is not canonical.');
  assertNonEmpty(reason, 'override reason');
  assertBounded(reason, 'override reason', MAX_TEXT_LENGTH);
  assertDurableTextSafe(reason);
  assertTimestamp(value.createdAt);
  if (value.expiresAt !== undefined) {
    assertTimestamp(value.expiresAt);
    if (value.expiresAt <= value.createdAt) throw new TypeError('Override expiry must be after its creation timestamp.');
  }
  const scope = parseScope(value.scope);
  return Object.freeze({ id, scope, reason, createdAt: value.createdAt, ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }) });
}

/** Applies a validated override without persistence, clocks, or other I/O. */
export function applyRuntimeOverride(input: ApplyRuntimeOverrideInput): OverrideApplication {
  assertTimestamp(input.now);
  const override = parseRuntimeOverride(input.override);
  if (input.now < override.createdAt) return rejected(input.decision, 'NOT_YET_VALID');
  if (override.expiresAt !== undefined && input.now >= override.expiresAt) return rejected(input.decision, 'EXPIRED');

  const matching = scopeMatches(override.scope, input);
  if (!matching.matches) return rejected(input.decision, 'SCOPE_MISMATCH');
  if (matching.overriddenRuleIds.length === 0) return rejected(input.decision, 'DECISION_NOT_ENFORCING');

  const overriddenRuleIds = matching.overriddenRuleIds;
  const outcome = override.scope.kind === 'rule'
    ? strongest(input.decision.explanations
        .filter(({ ruleId }) => ruleId === undefined || !overriddenRuleIds.includes(ruleId))
        .map(({ outcome }) => outcome))
    : 'ALLOW';
  const decision = freezeDecision({
    ...input.decision,
    outcome,
    override: { overrideId: override.id, scope: override.scope.kind, overriddenRuleIds }
  });
  return Object.freeze({ accepted: true, decision });
}

/** Produces evidence proposals only. It never changes or removes knowledge. */
export function deriveOverrideLearningEvidence(entries: readonly OverrideAuditEntry[]): readonly OverrideLearningEvidence[] {
  const successes = new Map<string, Set<string>>();
  const authorized = new Map<string, string>();
  for (const entry of entries) {
    const validated = validateOverrideAuditEntry(entry);
    if (entry.phase === 'authorized') {
      authorized.set(entry.override.id, auditBinding(validated));
      continue;
    }
    if (entry.postActionOutcome !== 'succeeded' || authorized.get(entry.override.id) !== auditBinding(validated)) continue;
    const scopedRuleId = entry.override.scope.kind === 'rule' ? entry.override.scope.ruleId : undefined;
    const references = scopedRuleId === undefined
      ? entry.decisionReferences
      : entry.decisionReferences.filter(({ ruleId }) => ruleId === scopedRuleId);
    for (const reference of references) {
      const overrideIds = successes.get(reference.ruleId) ?? new Set<string>();
      overrideIds.add(entry.override.id);
      successes.set(reference.ruleId, overrideIds);
    }
  }
  const evidence = [...successes.entries()]
    .filter(([, ids]) => ids.size >= 2)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ruleId, ids]) => Object.freeze({
      ruleId,
      polarity: 'contradicts' as const,
      successfulOverrideIds: Object.freeze([...ids].sort()),
      revalidationRequired: true as const
    }));
  return Object.freeze(evidence);
}

export function validateOverrideAuditEntry(value: OverrideAuditEntry): OverrideAuditEntry {
  if (!isRecord(value) || !onlyKeys(value, ['decisionReferences', 'id', 'override', 'phase', 'postActionOutcome', 'recordedAt'])
    || typeof value.id !== 'string' || (value.phase !== 'authorized' && value.phase !== 'completed')
    || typeof value.recordedAt !== 'string' || !Array.isArray(value.decisionReferences)) {
    throw new TypeError('Invalid override audit entry.');
  }
  assertNonEmpty(value.id, 'audit id');
  assertBounded(value.id, 'audit id', MAX_IDENTIFIER_LENGTH);
  assertTimestamp(value.recordedAt);
  const override = parseRuntimeOverride(value.override);
  if (value.phase === 'authorized' && value.postActionOutcome !== undefined) throw new TypeError('Authorization audit rows cannot contain a post-action outcome.');
  if (value.phase === 'completed' && !isPostActionOutcome(value.postActionOutcome)) throw new TypeError('Completion audit rows require a post-action outcome.');
  const references = value.decisionReferences.map(parseReference);
  if (references.length > MAX_REFERENCES) throw new TypeError('Override decision reference limit exceeded.');
  return Object.freeze({
    id: value.id,
    override,
    phase: value.phase,
    recordedAt: value.recordedAt,
    decisionReferences: Object.freeze(references),
    ...(value.postActionOutcome === undefined ? {} : { postActionOutcome: value.postActionOutcome })
  });
}

function scopeMatches(scope: RuntimeOverrideScope, input: ApplyRuntimeOverrideInput): { matches: boolean; overriddenRuleIds: readonly string[] } {
  const enforcingRuleIds = Object.freeze(input.decision.explanations
    .filter(({ outcome, ruleId }) => outcome !== 'ALLOW' && ruleId !== undefined)
    .map(({ ruleId }) => ruleId!));
  if (scope.kind === 'action') return { matches: scope.signatureHash === hashSignature(input.input.signature), overriddenRuleIds: enforcingRuleIds };
  if (scope.kind === 'task-session') return { matches: input.taskSessionId !== undefined && scope.taskSessionId === input.taskSessionId, overriddenRuleIds: enforcingRuleIds };
  const matches = input.decision.references.some(({ ruleId }) => ruleId === scope.ruleId);
  return { matches, overriddenRuleIds: Object.freeze(enforcingRuleIds.includes(scope.ruleId) ? [scope.ruleId] : []) };
}

function parseScope(value: Record<string, unknown>): RuntimeOverrideScope {
  if (value.kind === 'rule' && onlyKeys(value, ['kind', 'ruleId']) && typeof value.ruleId === 'string') {
    return Object.freeze({ kind: 'rule', ruleId: checkedIdentifier(value.ruleId, 'rule id') });
  }
  if (value.kind === 'action' && onlyKeys(value, ['kind', 'signatureHash']) && typeof value.signatureHash === 'string' && signatureHashPattern.test(value.signatureHash)) {
    return Object.freeze({ kind: 'action', signatureHash: value.signatureHash });
  }
  if (value.kind === 'task-session' && onlyKeys(value, ['kind', 'taskSessionId']) && typeof value.taskSessionId === 'string') {
    return Object.freeze({ kind: 'task-session', taskSessionId: checkedIdentifier(value.taskSessionId, 'task-session id') });
  }
  throw new TypeError('Invalid runtime override scope.');
}

function parseReference(value: unknown): DecisionReference {
  if (!isRecord(value) || !onlyKeys(value, ['evidenceIds', 'knowledgeId', 'ruleId', 'source'])
    || typeof value.ruleId !== 'string' || typeof value.knowledgeId !== 'string'
    || !Array.isArray(value.evidenceIds) || !value.evidenceIds.every((id) => typeof id === 'string')
    || (value.source !== undefined && typeof value.source !== 'string')) throw new TypeError('Invalid override decision reference.');
  assertNonEmpty(value.ruleId, 'rule id');
  assertNonEmpty(value.knowledgeId, 'knowledge id');
  assertBounded(value.ruleId, 'rule id', MAX_IDENTIFIER_LENGTH);
  assertBounded(value.knowledgeId, 'knowledge id', MAX_IDENTIFIER_LENGTH);
  if (value.evidenceIds.length > MAX_REFERENCES) throw new TypeError('Override evidence reference limit exceeded.');
  for (const evidenceId of value.evidenceIds) {
    assertNonEmpty(evidenceId, 'evidence id');
    assertBounded(evidenceId, 'evidence id', MAX_IDENTIFIER_LENGTH);
  }
  if (value.source !== undefined) assertBounded(value.source, 'reference source', MAX_TEXT_LENGTH);
  return Object.freeze({ ruleId: value.ruleId, knowledgeId: value.knowledgeId, evidenceIds: Object.freeze([...value.evidenceIds] as string[]), ...(value.source === undefined ? {} : { source: value.source }) });
}

function hashSignature(signature: RuntimeInput['signature']): string {
  validateActionSignatureResources(signature);
  return createHash('sha256').update('ael:runtime-action:v1\0').update(canonicalSignature(signature)).digest('hex');
}

function rejected(decision: GateDecision, rejection: OverrideRejection): OverrideApplication {
  return Object.freeze({ accepted: false, decision, rejection });
}

function assertTimestamp(value: string): void {
  if (!value || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Expected a canonical ISO timestamp.');
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must be non-empty.`);
}

function checkedIdentifier(value: string, field: string): string {
  assertNonEmpty(value, field);
  assertBounded(value, field, MAX_IDENTIFIER_LENGTH);
  if (value !== value.trim()) throw new TypeError(`${field} must not contain surrounding whitespace.`);
  return value;
}

function assertBounded(value: string, field: string, maximum: number): void {
  if (value.length > maximum) throw new TypeError(`${field} exceeds its resource limit.`);
}

function validateActionSignatureResources(signature: RuntimeInput['signature']): void {
  if (signature.kind === 'action') {
    assertNonEmpty(signature.tool, 'action tool');
    assertNonEmpty(signature.action, 'action name');
    assertBounded(signature.tool, 'action tool', MAX_TEXT_LENGTH);
    assertBounded(signature.action, 'action name', MAX_TEXT_LENGTH);
    if ((signature.arguments?.length ?? 0) > MAX_REFERENCES) throw new TypeError('Action argument limit exceeded.');
    for (const argument of signature.arguments ?? []) assertBounded(argument, 'action argument', MAX_TEXT_LENGTH);
  }
  if (signature.path !== undefined) assertBounded(signature.path, 'action path', MAX_TEXT_LENGTH);
}

function auditBinding(entry: OverrideAuditEntry): string {
  return JSON.stringify({ override: entry.override, decisionReferences: entry.decisionReferences });
}

function isPostActionOutcome(value: unknown): value is PostActionOutcome {
  return value === 'succeeded' || value === 'failed' || value === 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
