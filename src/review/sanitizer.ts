import { createHash } from 'node:crypto';

import type { NormalizedSession, NormalizedSessionEvent } from './contracts.js';

export type RedactionCategory =
  | 'absolute-path'
  | 'configured-pattern'
  | 'credential-url'
  | 'opaque-id'
  | 'password'
  | 'private-key'
  | 'secret'
  | 'token';

export interface SanitizationPolicy {
  readonly version: '1';
  readonly hash: string;
}

export interface SanitizedReviewArtifact {
  readonly policy: SanitizationPolicy;
  readonly redactions: Readonly<Record<RedactionCategory, number>>;
  readonly session: NormalizedSession;
}

export interface SanitizeForReviewOptions {
  readonly configuredPatterns?: readonly RegExp[];
}

export class SanitizationError extends Error {
  readonly code = 'UNSUPPORTED_NORMALIZED_SESSION';

  constructor(message = 'Normalized session content is malformed or unsupported.') {
    super(message);
    this.name = 'SanitizationError';
  }
}

const categories: readonly RedactionCategory[] = [
  'absolute-path', 'configured-pattern', 'credential-url', 'opaque-id', 'password', 'private-key', 'secret', 'token'
];

const sanitizedArtifacts = new WeakSet<object>();

const baseRules: readonly [RedactionCategory, RegExp][] = [
  ['private-key', /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gi],
  ['credential-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+(?:\/[^\s]*)?/gi],
  ['absolute-path', /(?<=\bfile:\/\/\/)(?!\[REDACTED:)[^\s"'`;,)](?:[^\s"'`;,)]*)/gi],
  ['absolute-path', /(?<![A-Za-z0-9+.:/\\\]-])\/(?!\/)[^\s"'`;,)](?:[^\s"'`;,)]*)?|(?<![A-Za-z0-9])(?:[A-Za-z]:\\(?:[^\\\s"'`;,)]*\\?)+|\\\\[^\\\s"'`;,)]*\\[^\\\s"'`;,)]*(?:\\[^\\\s"'`;,)]*)*)/g],
  ['token', /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi],
  ['token', /\b(?:token|api[_-]?key|access[_-]?key)\s*[:=]\s*[^\s;,]+/gi],
  ['token', /(?<![A-Za-z0-9_])(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_])/g],
  ['password', /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s;,]+/gi],
  ['secret', /\b(?:secret|client[_-]?secret)\s*[:=]\s*[^\s;,]+/gi]
];

export function sanitizeForReview(input: NormalizedSession, options: SanitizeForReviewOptions = {}): SanitizedReviewArtifact {
  validateNormalizedSession(input);
  const configuredPatterns = normalizePatterns(options.configuredPatterns ?? []);
  const redactions = emptyCounts();
  const policy = { version: '1' as const, hash: policyHash(configuredPatterns) };
  const sanitize = (value: string, redactOpaqueId = false): string => {
    let result = redactOpaqueId ? pseudonymizeOpaqueId(value, redactions) : value;
    for (const [category, pattern] of baseRules) result = redact(result, pattern, category, redactions);
    for (const pattern of configuredPatterns) result = redact(result, pattern, 'configured-pattern', redactions);
    return result;
  };

  const artifact: SanitizedReviewArtifact = {
    policy,
    redactions,
    session: {
      source: input.source,
      sessionId: sanitize(input.sessionId, true),
      ...(input.repositoryHint ? { repositoryHint: sanitize(input.repositoryHint) } : {}),
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      events: input.events.map((event) => sanitizeEvent(event, sanitize))
    }
  };
  assertNoSensitiveContent(artifact.session, configuredPatterns);
  freezeArtifact(artifact);
  sanitizedArtifacts.add(artifact);
  return artifact;
}

export function assertSanitizedReviewArtifact(value: unknown): asserts value is SanitizedReviewArtifact {
  if (!isRecord(value) || !sanitizedArtifacts.has(value)) {
    throw new SanitizationError(
      'Sanitized review artifact is malformed or unsupported; an artifact created by sanitizeForReview is required.'
    );
  }
}

function sanitizeEvent(event: NormalizedSessionEvent, sanitize: (value: string, redactOpaqueId?: boolean) => string): NormalizedSessionEvent {
  return {
    id: sanitize(event.id, true),
    kind: event.kind,
    occurredAt: event.occurredAt,
    ...(event.tool ? { tool: sanitize(event.tool) } : {}),
    ...(event.exitStatus === undefined ? {} : { exitStatus: event.exitStatus }),
    outcome: event.outcome
  };
}

function redact(value: string, expression: RegExp, category: RedactionCategory, counts: Record<RedactionCategory, number>): string {
  return value.replace(expression, () => {
    counts[category] += 1;
    return `[REDACTED:${category}]`;
  });
}

function pseudonymizeOpaqueId(value: string, counts: Record<RedactionCategory, number>): string {
  counts['opaque-id'] += 1;
  const digest = createHash('sha256').update('ael:opaque-id:v1\0').update(value).digest('hex');
  return `[REDACTED:opaque-id:${digest}]`;
}

function freezeArtifact(artifact: SanitizedReviewArtifact): void {
  for (const event of artifact.session.events) Object.freeze(event);
  Object.freeze(artifact.session.events);
  Object.freeze(artifact.session);
  Object.freeze(artifact.redactions);
  Object.freeze(artifact.policy);
  Object.freeze(artifact);
}

function normalizePatterns(patterns: readonly RegExp[]): readonly RegExp[] {
  for (const pattern of patterns) {
    if (!(pattern instanceof RegExp) || pattern.source.length === 0 || pattern.flags.includes('y') || pattern.test('')) throw new SanitizationError();
  }
  return patterns
    .map((pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
    .sort((left, right) => `${left.source}/${left.flags}`.localeCompare(`${right.source}/${right.flags}`));
}

function assertNoSensitiveContent(session: NormalizedSession, configuredPatterns: readonly RegExp[]): void {
  const values = [
    session.source,
    session.repositoryHint,
    session.sessionId,
    session.startedAt,
    session.endedAt,
    ...session.events.flatMap((event) => [event.id, event.kind, event.occurredAt, event.tool, event.outcome])
  ].filter((value): value is string => value !== undefined);
  const residualPatterns = [...baseRules.map(([, pattern]) => pattern), ...configuredPatterns];

  for (const value of values) {
    for (const pattern of residualPatterns) {
      pattern.lastIndex = 0;
      const remains = pattern.test(value);
      pattern.lastIndex = 0;
      if (remains) throw new SanitizationError();
    }
  }
}

function policyHash(patterns: readonly RegExp[]): string {
  const policy = JSON.stringify({
    version: '1',
    baseRules: baseRules.map(([category, pattern]) => [category, pattern.source, pattern.flags]),
    configuredPatterns: patterns.map((pattern) => `${pattern.source}/${pattern.flags}`)
  });
  return createHash('sha256').update(policy).digest('hex');
}

function emptyCounts(): Record<RedactionCategory, number> {
  return Object.fromEntries(categories.map((category) => [category, 0])) as Record<RedactionCategory, number>;
}

function validateNormalizedSession(value: unknown): asserts value is NormalizedSession {
  if (!isRecord(value) || !isSource(value.source) || !isNonEmptyString(value.sessionId) || !isTimestamp(value.startedAt) || !isTimestamp(value.endedAt) || !Array.isArray(value.events)) throw new SanitizationError();
  if (!hasOnlyKeys(value, ['source', 'sessionId', 'repositoryHint', 'startedAt', 'endedAt', 'events'])) throw new SanitizationError();
  if (value.repositoryHint !== undefined && typeof value.repositoryHint !== 'string') throw new SanitizationError();
  for (const event of value.events) validateEvent(event);
}

function validateEvent(value: unknown): asserts value is NormalizedSessionEvent {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isEventKind(value.kind) || !isTimestamp(value.occurredAt) || !isOutcome(value.outcome)) throw new SanitizationError();
  if (!hasOnlyKeys(value, ['id', 'kind', 'occurredAt', 'tool', 'exitStatus', 'outcome'])) throw new SanitizationError();
  if (value.tool !== undefined && typeof value.tool !== 'string') throw new SanitizationError();
  if (value.exitStatus !== undefined && (!Number.isInteger(value.exitStatus) || !Number.isFinite(value.exitStatus))) throw new SanitizationError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isSource(value: unknown): value is NormalizedSession['source'] {
  return value === 'codex' || value === 'claude-code' || value === 'cursor';
}

function isEventKind(value: unknown): value is NormalizedSessionEvent['kind'] {
  return value === 'tool' || value === 'message' || value === 'metadata';
}

function isOutcome(value: unknown): value is NormalizedSessionEvent['outcome'] {
  return value === 'passed' || value === 'failed' || value === 'unknown';
}
