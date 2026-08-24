import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSanitizedReviewArtifact,
  SanitizationError,
  sanitizeForReview
} from '../src/review/sanitizer.js';

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

test('applies configured patterns globally even when the supplied expression is not global', () => {
  const artifact = sanitizeForReview({
    ...sensitiveSession,
    events: [{
      ...sensitiveSession.events[0],
      tool: 'customer-reference customer-reference'
    }]
  }, { configuredPatterns: [/customer-reference/i] });

  assert.equal(artifact.session.events[0]?.tool, '[REDACTED:configured-pattern] [REDACTED:configured-pattern]');
  assert.equal(artifact.redactions['configured-pattern'], 2);
});

test('redacts POSIX and Windows absolute paths outside home directories', () => {
  const artifact = sanitizeForReview({
    ...sensitiveSession,
    repositoryHint: '/private/var/folders/build/project',
    events: [{
      ...sensitiveSession.events[0],
      tool: '/var/log/service.log /tmp/review.json C:\\Users\\alice\\repo\\secret.txt \\\\server\\share\\private\\file.txt'
    }]
  });
  const serialized = JSON.stringify(artifact);

  for (const rawValue of ['/private/var/folders/build/project', '/var/log/service.log', '/tmp/review.json', 'C:\\\\Users', 'server\\\\share']) {
    assert.equal(serialized.includes(rawValue), false, `review artifact leaked an absolute path`);
  }
  assert.equal(artifact.redactions['absolute-path'], 5);
});

test('redacts canonical provider credentials even when they have no identifying label', () => {
  const credentials = [
    'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ',
    'ghp_11AA22BB33CC44DD55EE66FF77GG88HH99II',
    'AKIAIOSFODNN7EXAMPLE',
    'sk-proj-11AA22BB33CC44DD55EE66FF77GG88HH99II'
  ];
  const artifact = sanitizeForReview({
    ...sensitiveSession,
    events: [{ ...sensitiveSession.events[0], tool: credentials.join(' ') }]
  });
  const serialized = JSON.stringify(artifact);

  for (const credential of credentials) {
    assert.equal(serialized.includes(credential), false, `review artifact leaked a canonical credential`);
  }
  assert.equal(artifact.redactions.token, credentials.length);
});

test('redacts arbitrary absolute POSIX roots without corrupting URL syntax', () => {
  const artifact = sanitizeForReview({
    ...sensitiveSession,
    repositoryHint: '/workspace/service',
    events: [{
      ...sensitiveSession.events[0],
      tool: '/custom-root/build/output.json https://example.test/workspace/service file:///workspace/service'
    }]
  });

  assert.equal(artifact.session.repositoryHint, '[REDACTED:absolute-path]');
  assert.equal(
    artifact.session.events[0]?.tool,
    '[REDACTED:absolute-path] https://example.test/workspace/service file:///workspace/service'
  );
  assert.equal(artifact.redactions['absolute-path'], 2);
});

test('uses deterministic distinct pseudonyms for different opaque identities', () => {
  const first = sanitizeForReview(sensitiveSession);
  const second = sanitizeForReview(sensitiveSession);

  assert.equal(first.session.sessionId, second.session.sessionId);
  assert.equal(first.session.events[0]?.id, second.session.events[0]?.id);
  assert.notEqual(first.session.sessionId, first.session.events[0]?.id);
  assert.notEqual(first.session.events[0]?.id, first.session.events[1]?.id);
  assert.match(first.session.sessionId, /^\[REDACTED:opaque-id:[a-f0-9]{64}\]$/);
});

test('recognizes only artifacts created by the sanitizer as trusted review input', () => {
  const artifact = sanitizeForReview(sensitiveSession);

  assert.doesNotThrow(() => assertSanitizedReviewArtifact(artifact));
  assert.throws(
    () => assertSanitizedReviewArtifact(structuredClone(artifact)),
    (error: unknown) => error instanceof SanitizationError
  );
  assert.throws(
    () => assertSanitizedReviewArtifact({ ...artifact }),
    (error: unknown) => error instanceof SanitizationError
  );
});

test('prevents a trusted artifact from being mutated after sanitization', () => {
  const artifact = sanitizeForReview(sensitiveSession);
  const injectedCredential = 'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ';

  assert.throws(() => {
    (artifact.session.events[0] as { tool?: string }).tool = injectedCredential;
  }, TypeError);
  assert.equal(JSON.stringify(artifact).includes(injectedCredential), false);
  assert.doesNotThrow(() => assertSanitizedReviewArtifact(artifact));
});

test('fails closed when a supported sensitive pattern remains after redaction without leaking values', () => {
  const rawSecret = 'must-not-leak';
  const input = {
    ...sensitiveSession,
    events: [{ ...sensitiveSession.events[0], tool: rawSecret }]
  };

  assert.throws(
    () => sanitizeForReview(input, { configuredPatterns: [/(?=must-not-leak)/] }),
    (error: unknown) => error instanceof SanitizationError && !error.message.includes(rawSecret)
  );
});

test('scans validated metadata fields for residual configured sensitive patterns', () => {
  assert.throws(
    () => sanitizeForReview(sensitiveSession, { configuredPatterns: [/2026-08-24/] }),
    (error: unknown) => error instanceof SanitizationError && !error.message.includes('2026-08-24')
  );
});

test('fails closed with a typed error for malformed normalized content without leaking input', () => {
  const malformed = { ...sensitiveSession, events: [{ ...sensitiveSession.events[0], payload: 'token=must-not-leak' }] };

  assert.throws(
    () => sanitizeForReview(malformed),
    (error: unknown) => error instanceof SanitizationError && error.code === 'UNSUPPORTED_NORMALIZED_SESSION' && !error.message.includes('must-not-leak')
  );
});
