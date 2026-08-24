import assert from 'node:assert/strict';
import test from 'node:test';

import { SanitizationError, sanitizeForReview } from '../src/review/sanitizer.js';

const sensitiveSession = {
  source: 'codex' as const,
  sessionId: 'session-opaque-123',
  repositoryHint: '/Users/alice/work/private-repo',
  startedAt: '2026-08-24T10:00:00.000Z',
  endedAt: '2026-08-24T10:01:00.000Z',
  events: [
    {
      id: 'event-opaque-456',
      kind: 'tool' as const,
      occurredAt: '2026-08-24T10:00:00.000Z',
      tool: 'Authorization: Bearer bearer-secret; api_key=api-secret; password=assigned-secret; secret=generic-secret; ssh://alice:password@credentials.test; /home/alice/.config; https://example.test/path',
      outcome: 'passed' as const
    },
    {
      id: 'event-opaque-789',
      kind: 'message' as const,
      occurredAt: '2026-08-24T10:01:00.000Z',
      tool: '-----BEGIN PRIVATE KEY-----\nprivate-key-content\n-----END PRIVATE KEY-----',
      outcome: 'unknown' as const
    }
  ]
};

test('creates a separate review artifact that redacts common secrets, paths, and opaque identifiers', () => {
  const artifact = sanitizeForReview(sensitiveSession, { configuredPatterns: [/example\.test/gi] });
  const serialized = JSON.stringify(artifact);

  for (const rawValue of [
    'session-opaque-123', 'event-opaque-456', 'event-opaque-789', 'alice', 'private-repo',
    'bearer-secret', 'api-secret', 'assigned-secret', 'generic-secret', 'private-key-content', 'example.test'
  ]) assert.equal(serialized.includes(rawValue), false, `review artifact leaked ${rawValue}`);

  assert.notEqual(artifact.session, sensitiveSession);
  assert.equal(artifact.policy.version, '1');
  assert.match(artifact.policy.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(artifact.redactions, {
    'absolute-path': 2,
    'configured-pattern': 1,
    'credential-url': 1,
    'opaque-id': 3,
    'password': 1,
    'private-key': 1,
    secret: 1,
    token: 2
  });
});

test('produces the same sanitized artifact and policy hash for the same input and policy', () => {
  const options = { configuredPatterns: [/example\.test/gi] };

  assert.deepEqual(sanitizeForReview(sensitiveSession, options), sanitizeForReview(sensitiveSession, options));
});

test('changes the policy hash when configured redaction patterns change', () => {
  const first = sanitizeForReview(sensitiveSession, { configuredPatterns: [/example\.test/gi] });
  const second = sanitizeForReview(sensitiveSession, { configuredPatterns: [/private-repo/g] });

  assert.notEqual(first.policy.hash, second.policy.hash);
});

test('fails closed with a typed error for malformed normalized content without leaking input', () => {
  const malformed = { ...sensitiveSession, events: [{ ...sensitiveSession.events[0], payload: 'token=must-not-leak' }] };

  assert.throws(
    () => sanitizeForReview(malformed),
    (error: unknown) => error instanceof SanitizationError && error.code === 'UNSUPPORTED_NORMALIZED_SESSION' && !error.message.includes('must-not-leak')
  );
});
