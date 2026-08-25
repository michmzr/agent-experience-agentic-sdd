import { createHash } from 'node:crypto';

import type { KnowledgeState, LessonKind } from '../domain/types.js';
import { assertDurableTextSafe } from '../review/sanitizer.js';
import type { RuntimeSignature } from '../runtime/contracts.js';
import { normalizeRuntimePath } from '../runtime/matcher.js';

export type InstructionOrigin = 'code-tool-confirmed' | 'user-preference' | 'skill-workflow-candidate' | 'task-specific-constraint';

export interface KnowledgeApplicability {
  readonly paths: readonly string[];
  readonly tags: readonly string[];
  readonly tools: readonly string[];
}

export interface KnowledgeApproval {
  readonly at: string;
  readonly kind: 'system' | 'user';
}

export interface KnowledgeVerification {
  readonly at: string;
  readonly by?: string;
}

export interface RuntimeDirective {
  readonly signature: RuntimeSignature;
  readonly effect: 'conflict' | 'context';
}

export interface KnowledgeIndexEntryV2 {
  readonly identity: string;
  readonly document: string;
  readonly repositoryScope: string;
  readonly kind: LessonKind;
  readonly state: KnowledgeState;
  readonly applicability: KnowledgeApplicability;
  readonly instructionOrigin: InstructionOrigin;
  readonly approval?: KnowledgeApproval;
  readonly lastVerification?: KnowledgeVerification;
  readonly supersedes: readonly string[];
  readonly contentHash: string;
}

export interface KnowledgeIndexV2 {
  readonly version: 2;
  readonly entries: readonly KnowledgeIndexEntryV2[];
}

export interface KnowledgeIndexEntryV3 extends KnowledgeIndexEntryV2 {
  readonly runtimeDirective?: RuntimeDirective;
}

export interface KnowledgeIndexV3 {
  readonly version: 3;
  readonly entries: readonly KnowledgeIndexEntryV3[];
}

export interface KnowledgeIndexEntryV1 {
  readonly identity: string;
  readonly kind: LessonKind;
  readonly state: KnowledgeState;
  readonly applicability: { readonly path?: string; readonly tags: readonly string[]; readonly tool?: string };
  readonly approval?: KnowledgeApproval;
  readonly lastVerification?: KnowledgeVerification;
  readonly mergedProvenance?: string;
}

export interface KnowledgeIndexV1 {
  readonly version: 1;
  readonly entries: readonly KnowledgeIndexEntryV1[];
}

export type KnowledgeIndex = KnowledgeIndexV1 | KnowledgeIndexV2 | KnowledgeIndexV3;

const safeIdentity = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const hashPattern = /^[a-f0-9]{64}$/;
const states: readonly KnowledgeState[] = ['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired'];
const kinds: readonly LessonKind[] = ['failure', 'successful-workflow', 'project-fact', 'convention', 'tool-capability', 'environment-quirk', 'heuristic', 'preference'];
const origins: readonly InstructionOrigin[] = ['code-tool-confirmed', 'user-preference', 'skill-workflow-candidate', 'task-specific-constraint'];
const MAX_INDEX_ENTRIES = 1_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_INDEX_STRING_LENGTH = 4_096;

export function parseKnowledgeIndex(value: unknown): KnowledgeIndex {
  assertSafeExportValue(value);
  if (!isRecord(value) || !onlyKeys(value, ['entries', 'version']) || !Array.isArray(value.entries)
    || (value.version !== 1 && value.version !== 2 && value.version !== 3)) {
    throw new Error('Invalid repository knowledge index.');
  }
  if (value.entries.length > MAX_INDEX_ENTRIES) throw new Error('Repository knowledge entry-count limit exceeded.');
  assertBoundedStrings(value);
  const identities = new Set<string>();
  const entries = value.version === 1
    ? value.entries.map(parseV1Entry)
    : value.version === 2 ? value.entries.map(parseV2Entry) : value.entries.map(parseV3Entry);
  for (const entry of entries) {
    if (identities.has(entry.identity)) throw new Error(`Duplicate knowledge identity: ${entry.identity}.`);
    identities.add(entry.identity);
  }
  if (value.version === 1) return { version: 1, entries: entries as KnowledgeIndexEntryV1[] };
  if (value.version === 2) return { version: 2, entries: entries as KnowledgeIndexEntryV2[] };
  return { version: 3, entries: entries as KnowledgeIndexEntryV3[] };
}

export function serializeKnowledgeIndex(index: KnowledgeIndexV2 | KnowledgeIndexV3): string {
  const parsed = parseKnowledgeIndex(index) as KnowledgeIndexV2 | KnowledgeIndexV3;
  return `${JSON.stringify(sortObject(parsed), null, 2)}\n`;
}

export function contentHash(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

export function assertIdentity(value: string): void {
  if (!safeIdentity.test(value) || value === '.' || value === '..') throw new Error('Knowledge identity must be a safe filename.');
}

export function assertTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid ISO timestamp: ${value}.`);
  }
}

export function assertSafeExportValue(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    if (/-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY(?: BLOCK)?-----/i.test(value)
      || /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/.test(value)
      || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value)
      || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
      || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
      || /\bbearer(?:[_-]?token)?\s*(?:=|:)\s*\S+/i.test(value)) throw new Error('Repository knowledge contains credential-like material.');
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('Repository knowledge must not contain circular data.');
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:payload|rawEvent|rawTranscript|transcript|privateReview|privateReviewText)$/i.test(key)) {
      throw new Error(key.toLowerCase().includes('private') ? 'Repository knowledge must not contain private review data.' : 'Repository knowledge must not contain raw event or transcript data.');
    }
    if (/^(?:sessionId|eventId|observationId|candidateId|evidenceId|reviewerId|localDatabaseId)$/i.test(key)) {
      throw new Error('Repository knowledge must not contain private local identifiers.');
    }
    assertSafeExportValue(nested, seen);
  }
}

function parseV2Entry(value: unknown): KnowledgeIndexEntryV2 {
  if (!isRecord(value)) throw new Error('Invalid version 2 index entry.');
  const allowed = ['identity', 'document', 'repositoryScope', 'kind', 'state', 'applicability', 'instructionOrigin', 'approval', 'lastVerification', 'supersedes', 'contentHash'];
  if (!onlyKeys(value, allowed) || allowed.some((key) => !['approval', 'lastVerification'].includes(key) && !(key in value))) throw new Error('Invalid version 2 index entry.');
  if (typeof value.identity !== 'string') throw new Error('Invalid knowledge identity.');
  assertIdentity(value.identity);
  if (value.document !== `knowledge/${value.identity}.md`) throw new Error('Unsafe or inconsistent knowledge document path.');
  if (typeof value.repositoryScope !== 'string' || !value.repositoryScope.trim()) throw new Error('Invalid repository scope.');
  if (!kinds.includes(value.kind as LessonKind) || !states.includes(value.state as KnowledgeState)) throw new Error('Invalid knowledge kind or lifecycle state.');
  if (!origins.includes(value.instructionOrigin as InstructionOrigin)) throw new Error('Invalid instruction origin.');
  if (!isApplicability(value.applicability)) throw new Error('Invalid structured applicability.');
  if (value.approval !== undefined) parseApproval(value.approval);
  if (value.lastVerification !== undefined) parseVerification(value.lastVerification);
  if (!Array.isArray(value.supersedes) || value.supersedes.length > MAX_ARRAY_ITEMS || !value.supersedes.every((id) => typeof id === 'string')) throw new Error('Invalid supersedes list.');
  for (const id of value.supersedes) assertIdentity(id as string);
  if (typeof value.contentHash !== 'string' || !hashPattern.test(value.contentHash)) throw new Error('Invalid Markdown content hash.');
  return value as unknown as KnowledgeIndexEntryV2;
}

function parseV3Entry(value: unknown): KnowledgeIndexEntryV3 {
  if (!isRecord(value)) throw new Error('Invalid version 3 index entry.');
  const allowed = [
    'identity', 'document', 'repositoryScope', 'kind', 'state', 'applicability', 'instructionOrigin',
    'approval', 'lastVerification', 'supersedes', 'contentHash', 'runtimeDirective'
  ];
  if (!onlyKeys(value, allowed) || allowed.some((key) => !['approval', 'lastVerification', 'runtimeDirective'].includes(key) && !(key in value))) {
    throw new Error('Invalid version 3 index entry.');
  }
  const base = parseV2Entry(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'runtimeDirective')));
  const runtimeDirective = value.runtimeDirective === undefined ? undefined : parseRuntimeDirective(value.runtimeDirective);
  assertCanonicalV3Applicability(base.applicability, runtimeDirective);
  return runtimeDirective === undefined ? base : { ...base, runtimeDirective };
}

export function parseRuntimeDirective(value: unknown): RuntimeDirective {
  if (!isRecord(value) || !onlyKeys(value, ['effect', 'signature'])
    || (value.effect !== 'conflict' && value.effect !== 'context')) {
    throw new Error('Invalid runtime directive.');
  }
  const signature = parseDirectiveSignature(value.signature);
  const directive = { effect: value.effect, signature } as RuntimeDirective;
  assertSafeExportValue(directive);
  assertDurableTextSafe(JSON.stringify(directive));
  return deepFreeze(directive);
}

function parseDirectiveSignature(value: unknown): RuntimeSignature {
  if (!isRecord(value) || (value.kind !== 'action' && value.kind !== 'intent')) throw new Error('Invalid runtime directive signature.');
  if (value.kind === 'action') {
    if (!onlyKeys(value, ['action', 'arguments', 'kind', 'path', 'tool'])
      || !canonicalDirectiveToken(value.tool) || !canonicalDirectiveToken(value.action)
      || (value.arguments !== undefined && (!Array.isArray(value.arguments) || value.arguments.length > MAX_ARRAY_ITEMS
        || !value.arguments.every(canonicalDirectiveArgument)))
      || (value.path !== undefined && !canonicalDirectivePath(value.path))) {
      throw new Error('Invalid runtime action directive.');
    }
    return deepFreeze({
      kind: 'action', tool: value.tool as string, action: value.action as string,
      ...(value.arguments === undefined ? {} : { arguments: [...value.arguments] as string[] }),
      ...(value.path === undefined ? {} : { path: value.path as string })
    });
  }
  if (!onlyKeys(value, ['kind', 'path', 'target', 'tool', 'verb'])
    || !canonicalDirectiveToken(value.verb) || !canonicalDirectiveToken(value.target)
    || (value.tool !== undefined && !canonicalDirectiveToken(value.tool))
    || (value.path !== undefined && !canonicalDirectivePath(value.path))) {
    throw new Error('Invalid runtime intent directive.');
  }
  return deepFreeze({
    kind: 'intent', verb: value.verb as string, target: value.target as string,
    ...(value.tool === undefined ? {} : { tool: value.tool as string }),
    ...(value.path === undefined ? {} : { path: value.path as string })
  });
}

function canonicalDirectiveToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_INDEX_STRING_LENGTH
    && value === value.trim() && value === value.toLowerCase();
}

function canonicalDirectiveArgument(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_INDEX_STRING_LENGTH && !/[\r\n\0]/.test(value);
}

function canonicalDirectivePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INDEX_STRING_LENGTH) return false;
  try { return normalizeRuntimePath(value) === value; }
  catch { return false; }
}

function assertCanonicalV3Applicability(applicability: KnowledgeApplicability, directive?: RuntimeDirective): void {
  for (const values of [applicability.paths, applicability.tags, applicability.tools]) {
    if (values.some((value) => typeof value !== 'string' || value.length === 0 || value.length > MAX_INDEX_STRING_LENGTH || value !== value.trim())) {
      throw new Error('Version 3 applicability values must be canonical bounded strings.');
    }
    if (new Set(values).size !== values.length || !values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0)) {
      throw new Error('Version 3 applicability arrays must be unique and sorted.');
    }
  }
  if (applicability.tags.some((value) => value !== value.toLowerCase())
    || applicability.tools.some((value) => value !== value.toLowerCase())) {
    throw new Error('Version 3 applicability tokens must be canonical lowercase values.');
  }
  if (directive === undefined) return;
  const signatureTool = directive.signature.tool;
  if (applicability.tools.length > 0
    && (applicability.tools.length !== 1 || signatureTool === undefined || applicability.tools[0] !== signatureTool)) {
    throw new Error('Runtime directive tool does not match structured applicability.');
  }
  if (applicability.paths.length > 0
    && (applicability.paths.length !== 1 || directive.signature.path === undefined || applicability.paths[0] !== directive.signature.path)) {
    throw new Error('Runtime directive path does not match structured applicability.');
  }
}

function parseV1Entry(value: unknown): KnowledgeIndexEntryV1 {
  if (!isRecord(value) || !onlyKeys(value, ['applicability', 'approval', 'identity', 'kind', 'lastVerification', 'mergedProvenance', 'state'])
    || typeof value.identity !== 'string' || !kinds.includes(value.kind as LessonKind)
    || !states.includes(value.state as KnowledgeState) || !isLegacyApplicability(value.applicability)) throw new Error('Invalid version 1 index entry.');
  assertIdentity(value.identity);
  if (value.approval !== undefined) parseApproval(value.approval);
  if (value.lastVerification !== undefined) parseVerification(value.lastVerification);
  if (value.mergedProvenance !== undefined && typeof value.mergedProvenance !== 'string') throw new Error('Invalid merged provenance.');
  return value as unknown as KnowledgeIndexEntryV1;
}

function parseApproval(value: unknown): void {
  if (!isRecord(value) || !onlyKeys(value, ['at', 'kind']) || typeof value.at !== 'string' || (value.kind !== 'system' && value.kind !== 'user')) throw new Error('Invalid approval.');
  assertTimestamp(value.at);
}

function parseVerification(value: unknown): void {
  if (!isRecord(value) || !onlyKeys(value, ['at', 'by']) || typeof value.at !== 'string' || (value.by !== undefined && typeof value.by !== 'string')) throw new Error('Invalid last verification.');
  assertTimestamp(value.at);
}

function isApplicability(value: unknown): value is KnowledgeApplicability {
  return isRecord(value) && onlyKeys(value, ['paths', 'tags', 'tools'])
    && ['paths', 'tags', 'tools'].every((key) => Array.isArray(value[key]) && (value[key] as unknown[]).length <= MAX_ARRAY_ITEMS && (value[key] as unknown[]).every((item) => typeof item === 'string'));
}

function isLegacyApplicability(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ['path', 'tags', 'tool']) && Array.isArray(value.tags) && value.tags.length <= MAX_ARRAY_ITEMS && value.tags.every((tag) => typeof tag === 'string')
    && (value.path === undefined || typeof value.path === 'string') && (value.tool === undefined || typeof value.tool === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compare(a, b)).map(([key, nested]) => [key, sortObject(nested)]));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertBoundedStrings(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    if (value.length > MAX_INDEX_STRING_LENGTH) throw new Error('Repository knowledge string-length limit exceeded.');
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) assertBoundedStrings(nested, seen);
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
