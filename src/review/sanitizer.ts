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

  constructor() {
    super('Normalized session content is malformed or unsupported.');
    this.name = 'SanitizationError';
  }
}

const categories: readonly RedactionCategory[] = [
  'absolute-path', 'configured-pattern', 'credential-url', 'opaque-id', 'password', 'private-key', 'secret', 'token'
];

const baseRules: readonly [RedactionCategory, RegExp][] = [
  ['private-key', /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gi],
  ['credential-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+(?:\/[^\s]*)?/gi],
  ['absolute-path', /(?:^|\s)(?:\/Users\/[^\s/]+|\/home\/[^\s/]+)(?:\/[^\s]*)?/g],
  ['token', /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi],
  ['token', /\b(?:token|api[_-]?key|access[_-]?key)\s*[:=]\s*[^\s;,]+/gi],
  ['password', /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s;,]+/gi],
  ['secret', /\b(?:secret|client[_-]?secret)\s*[:=]\s*[^\s;,]+/gi]
];

export function sanitizeForReview(input: NormalizedSession, options: SanitizeForReviewOptions = {}): SanitizedReviewArtifact {
  validateNormalizedSession(input);
  const configuredPatterns = normalizePatterns(options.configuredPatterns ?? []);
  const redactions = emptyCounts();
  const policy = { version: '1' as const, hash: policyHash(configuredPatterns) };
  const sanitize = (value: string, redactOpaqueId = false): string => {
    let result = redactOpaqueId ? redact(value, /.+/g, 'opaque-id', redactions) : value;
    for (const [category, pattern] of baseRules) result = redact(result, pattern, category, redactions);
    for (const pattern of configuredPatterns) result = redact(result, pattern, 'configured-pattern', redactions);
    return result;
  };

  return {
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

function normalizePatterns(patterns: readonly RegExp[]): readonly RegExp[] {
  for (const pattern of patterns) {
    if (!(pattern instanceof RegExp) || pattern.source.length === 0 || pattern.flags.includes('y') || pattern.test('')) throw new SanitizationError();
  }
  return patterns
    .map((pattern) => new RegExp(pattern.source, pattern.flags))
    .sort((left, right) => `${left.source}/${left.flags}`.localeCompare(`${right.source}/${right.flags}`));
}

function policyHash(patterns: readonly RegExp[]): string {
  const policy = JSON.stringify({ version: '1', baseCategories: categories, configuredPatterns: patterns.map((pattern) => `${pattern.source}/${pattern.flags}`) });
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
