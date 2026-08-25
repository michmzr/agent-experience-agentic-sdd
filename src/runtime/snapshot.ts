import { createHash } from 'node:crypto';

import type { KnowledgeState } from '../domain/types.js';
import type { RuntimeRule, RuntimeSignature } from './contracts.js';
import { canonicalRuntimePathIdentity } from './matcher.js';

export const RUNTIME_SNAPSHOT_VERSION = 1 as const;
export const MAX_RUNTIME_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_RULES = 10_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4_096;
const checksumPattern = /^[a-f0-9]{64}$/;
const activeStates = new Set<KnowledgeState>(['observed', 'confirmed', 'verified', 'disputed']);
const allStates = new Set<KnowledgeState>(['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired']);

export class RuntimeSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RuntimeSnapshotValidationError'; }
}

export interface RuntimeSnapshotV1 {
  readonly version: typeof RUNTIME_SNAPSHOT_VERSION;
  readonly repositoryId: string;
  readonly generatedAt: string;
  readonly rules: readonly RuntimeRule[];
  readonly checksum: string;
}

interface RuntimeSnapshotCompilationBase {
  readonly repositoryId: string;
  readonly globalRules?: readonly RuntimeRule[];
  readonly repositoryRules?: readonly RuntimeRule[];
  /** Non-authoritative, observed, or disputed knowledge must enter through this explicit boundary. */
  readonly contextRules?: readonly RuntimeRule[];
}

export type RuntimeSnapshotCompilation = RuntimeSnapshotCompilationBase & (
  | { readonly generatedAt: string; readonly now?: never }
  | { readonly generatedAt?: never; readonly now: () => Date | string }
);

export function compileRuntimeSnapshot(input: RuntimeSnapshotCompilation): RuntimeSnapshotV1 {
  assertString(input.repositoryId, 'repositoryId');
  const generatedAt = input.generatedAt ?? timestampFromNow(input.now);
  assertTimestamp(generatedAt);
  assertAuthoritativeInput(input.globalRules ?? [], 'global');
  assertAuthoritativeInput((input.repositoryRules ?? []).filter((rule) => rule.applicability.scope !== 'repository'
    || rule.applicability.repositoryId === input.repositoryId), 'repository');
  assertContextInput((input.contextRules ?? []).filter((rule) => rule.applicability.scope === 'global'
    || rule.applicability.repositoryId === input.repositoryId));
  const selected = [
    ...(input.globalRules ?? []).filter((rule) => rule.applicability.scope === 'global' && rule.authoritative),
    ...(input.repositoryRules ?? []).filter((rule) => rule.authoritative && rule.applicability.scope === 'repository' && rule.applicability.repositoryId === input.repositoryId),
    ...(input.contextRules ?? []).filter((rule) => rule.applicability.scope === 'global'
      || rule.applicability.repositoryId === input.repositoryId).map((rule) => ({ ...rule, effect: 'context' as const }))
  ].filter((rule) => activeStates.has(rule.state))
    .map((rule) => rule.state === 'observed' || rule.state === 'disputed' || !rule.authoritative
      ? { ...rule, effect: 'context' as const }
      : rule);

  const rules = selected.map(parseRule).sort((left, right) => compare(left.id, right.id));
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new RuntimeSnapshotValidationError(`Duplicate runtime rule identifier: ${rule.id}.`);
    ids.add(rule.id);
  }
  if (rules.length > MAX_RULES) throw new RuntimeSnapshotValidationError('Runtime snapshot rule-count limit exceeded.');
  const payload = { version: RUNTIME_SNAPSHOT_VERSION, repositoryId: input.repositoryId, generatedAt, rules };
  return freezeSnapshot({ ...payload, checksum: checksumPayload(payload) });
}

export function parseRuntimeSnapshot(value: unknown): RuntimeSnapshotV1 {
  if (!isRecord(value) || !onlyKeys(value, ['checksum', 'generatedAt', 'repositoryId', 'rules', 'version'])
    || value.version !== RUNTIME_SNAPSHOT_VERSION || typeof value.repositoryId !== 'string'
    || typeof value.generatedAt !== 'string' || !Array.isArray(value.rules)
    || typeof value.checksum !== 'string' || !checksumPattern.test(value.checksum)) {
    throw new RuntimeSnapshotValidationError('Invalid runtime snapshot schema or version.');
  }
  assertString(value.repositoryId, 'repositoryId');
  assertTimestamp(value.generatedAt);
  const rawRules = value.rules;
  if (rawRules.length > MAX_RULES) throw new RuntimeSnapshotValidationError('Runtime snapshot rule-count limit exceeded.');
  assertResourceLimits(value);
  const rules = rawRules.map(parseRule).sort((left, right) => compare(left.id, right.id));
  if (!rules.every((rule, index) => rule.id === (rawRules[index] as RuntimeRule | undefined)?.id)) {
    throw new RuntimeSnapshotValidationError('Runtime snapshot rules are not in stable order.');
  }
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!activeStates.has(rule.state)) throw new RuntimeSnapshotValidationError('Runtime snapshot contains an inactive rule.');
    if ((!rule.authoritative || rule.state === 'observed' || rule.state === 'disputed') && rule.effect !== 'context') {
      throw new RuntimeSnapshotValidationError('Non-enforcing runtime knowledge must be stored as context.');
    }
    if (rule.applicability.scope === 'repository' && rule.applicability.repositoryId !== value.repositoryId) {
      throw new RuntimeSnapshotValidationError('Runtime snapshot contains a rule from another repository.');
    }
    if (ids.has(rule.id)) throw new RuntimeSnapshotValidationError(`Duplicate runtime rule identifier: ${rule.id}.`);
    ids.add(rule.id);
  }
  const payload = { version: RUNTIME_SNAPSHOT_VERSION, repositoryId: value.repositoryId, generatedAt: value.generatedAt, rules };
  if (checksumPayload(payload) !== value.checksum) throw new RuntimeSnapshotValidationError('Runtime snapshot checksum mismatch.');
  return freezeSnapshot({ ...payload, checksum: value.checksum });
}

export function parseSerializedRuntimeSnapshot(serialized: string): RuntimeSnapshotV1 {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_SNAPSHOT_BYTES) throw new RuntimeSnapshotValidationError('Runtime snapshot size limit exceeded.');
  let value: unknown;
  try { value = JSON.parse(serialized) as unknown; } catch { throw new RuntimeSnapshotValidationError('Runtime snapshot is not valid JSON.'); }
  return parseRuntimeSnapshot(value);
}

export function serializeRuntimeSnapshot(snapshot: RuntimeSnapshotV1): string {
  const parsed = parseRuntimeSnapshot(snapshot);
  return `${JSON.stringify(sortObject(parsed), null, 2)}\n`;
}

function parseRule(value: unknown): RuntimeRule {
  if (!isRecord(value) || !onlyKeys(value, ['applicability', 'authoritative', 'effect', 'id', 'reference', 'signature', 'state'])
    || typeof value.id !== 'string' || !allStates.has(value.state as KnowledgeState)
    || typeof value.authoritative !== 'boolean' || (value.effect !== 'conflict' && value.effect !== 'context')) {
    throw new RuntimeSnapshotValidationError('Invalid runtime rule.');
  }
  assertString(value.id, 'rule id');
  const signature = parseSignature(value.signature);
  const applicability = parseApplicability(value.applicability);
  const reference = parseReference(value.reference);
  return deepFreeze({ id: value.id, state: value.state as KnowledgeState, authoritative: value.authoritative, effect: value.effect, signature, applicability, reference });
}

function parseSignature(value: unknown): RuntimeSignature {
  if (!isRecord(value) || (value.kind !== 'action' && value.kind !== 'intent')) throw new RuntimeSnapshotValidationError('Invalid runtime signature.');
  if (value.kind === 'action') {
    if (!onlyKeys(value, ['action', 'arguments', 'kind', 'path', 'tool']) || typeof value.tool !== 'string' || typeof value.action !== 'string'
      || (value.arguments !== undefined && (!Array.isArray(value.arguments) || value.arguments.length > MAX_ARRAY_ITEMS || !value.arguments.every((item) => typeof item === 'string')))
      || (value.path !== undefined && typeof value.path !== 'string')) throw new RuntimeSnapshotValidationError('Invalid action signature.');
    assertString(value.tool, 'signature tool'); assertString(value.action, 'signature action');
    if (value.path !== undefined) validateRuntimePath(value.path);
    return deepFreeze({ kind: 'action', tool: value.tool, action: value.action, ...(value.arguments === undefined ? {} : { arguments: [...value.arguments] as string[] }), ...(value.path === undefined ? {} : { path: value.path }) });
  }
  if (!onlyKeys(value, ['kind', 'path', 'target', 'tool', 'verb']) || typeof value.verb !== 'string' || typeof value.target !== 'string'
    || (value.tool !== undefined && typeof value.tool !== 'string') || (value.path !== undefined && typeof value.path !== 'string')) throw new RuntimeSnapshotValidationError('Invalid intent signature.');
  assertString(value.verb, 'signature verb'); assertString(value.target, 'signature target');
  if (value.path !== undefined) validateRuntimePath(value.path);
  return deepFreeze({ kind: 'intent', verb: value.verb, target: value.target, ...(value.tool === undefined ? {} : { tool: value.tool }), ...(value.path === undefined ? {} : { path: value.path }) });
}

function parseApplicability(value: unknown): RuntimeRule['applicability'] {
  if (!isRecord(value) || !onlyKeys(value, ['path', 'repositoryId', 'scope', 'tags', 'tool'])
    || (value.scope !== 'global' && value.scope !== 'repository')
    || (value.tool !== undefined && typeof value.tool !== 'string') || (value.path !== undefined && typeof value.path !== 'string')
    || (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > MAX_ARRAY_ITEMS || !value.tags.every((tag) => typeof tag === 'string')))) throw new RuntimeSnapshotValidationError('Invalid rule applicability.');
  if (value.scope === 'global' && value.repositoryId !== undefined) throw new RuntimeSnapshotValidationError('Global applicability cannot identify a repository.');
  if (value.scope === 'repository' && typeof value.repositoryId !== 'string') throw new RuntimeSnapshotValidationError('Repository applicability requires a repository identifier.');
  if (value.repositoryId !== undefined) assertString(value.repositoryId as string, 'repositoryId');
  if (value.path !== undefined) validateRuntimePath(value.path);
  const optional = { ...(value.tool === undefined ? {} : { tool: value.tool }), ...(value.path === undefined ? {} : { path: value.path }), ...(value.tags === undefined ? {} : { tags: [...value.tags] as string[] }) };
  return value.scope === 'global' ? deepFreeze({ scope: 'global', ...optional }) : deepFreeze({ scope: 'repository', repositoryId: value.repositoryId as string, ...optional });
}

function parseReference(value: unknown): RuntimeRule['reference'] {
  if (!isRecord(value) || !onlyKeys(value, ['evidenceIds', 'knowledgeId', 'source']) || typeof value.knowledgeId !== 'string'
    || !Array.isArray(value.evidenceIds) || value.evidenceIds.length > MAX_ARRAY_ITEMS || !value.evidenceIds.every((id) => typeof id === 'string')
    || (value.source !== undefined && typeof value.source !== 'string')) throw new RuntimeSnapshotValidationError('Invalid runtime reference.');
  assertString(value.knowledgeId, 'knowledgeId');
  return deepFreeze({ knowledgeId: value.knowledgeId, evidenceIds: [...value.evidenceIds] as string[], ...(value.source === undefined ? {} : { source: value.source }) });
}

function checksumPayload(payload: Omit<RuntimeSnapshotV1, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(sortObject(payload)), 'utf8').digest('hex');
}

function freezeSnapshot(value: RuntimeSnapshotV1): RuntimeSnapshotV1 { return deepFreeze(value); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, nested]) => [key, sortObject(nested)]));
}
function assertResourceLimits(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') { if (value.length > MAX_STRING_LENGTH) throw new RuntimeSnapshotValidationError('Runtime snapshot string-length limit exceeded.'); return; }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new RuntimeSnapshotValidationError('Runtime snapshot cannot contain circular data.');
  seen.add(value);
  if (Array.isArray(value) && value.length > MAX_RULES) throw new RuntimeSnapshotValidationError('Runtime snapshot array limit exceeded.');
  for (const nested of Object.values(value)) assertResourceLimits(nested, seen);
}
function assertString(value: string, label: string): void { if (!value.trim() || value.length > MAX_STRING_LENGTH || value.includes('\0')) throw new RuntimeSnapshotValidationError(`Invalid ${label}.`); }
function assertTimestamp(value: string): void {
  let canonical = false;
  try { canonical = new Date(value).toISOString() === value; } catch { /* Invalid dates are rejected below. */ }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !canonical) throw new RuntimeSnapshotValidationError('Invalid runtime snapshot timestamp.');
}
function timestampFromNow(now: (() => Date | string) | undefined): string {
  if (now === undefined) throw new RuntimeSnapshotValidationError('Runtime snapshot compilation requires an explicit timestamp or injected clock.');
  const value = now();
  if (!(value instanceof Date)) return value;
  try { return value.toISOString(); } catch (error) { throw new RuntimeSnapshotValidationError('Injected runtime snapshot clock returned an invalid date.', { cause: error }); }
}
function assertAuthoritativeInput(rules: readonly RuntimeRule[], source: string): void {
  for (const rule of rules) {
    if (rule.applicability.scope !== source) continue;
    parseRule(rule);
    if (!rule.authoritative || rule.state === 'observed' || rule.state === 'disputed') {
      throw new RuntimeSnapshotValidationError('Observed, disputed, and non-authoritative rules require explicit context input.');
    }
  }
}
function assertContextInput(rules: readonly RuntimeRule[]): void { for (const rule of rules) parseRule(rule); }
function validateRuntimePath(path: string): void {
  try { canonicalRuntimePathIdentity(path); } catch (error) {
    if (error instanceof RangeError) throw new RuntimeSnapshotValidationError('Invalid runtime path.', { cause: error });
    throw error;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
