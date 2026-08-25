import assert from 'node:assert/strict';
import test from 'node:test';

import { CircuitBreaker } from '../src/runtime/circuit-breaker.js';

test('opens after consecutive failures, skips while open, and recovers through a half-open probe', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 100, clock: () => now });
  assert.equal(breaker.canAttempt(), true);
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state, 'open');
  assert.equal(breaker.canAttempt(), false);
  now = 100;
  assert.equal(breaker.canAttempt(), true);
  assert.equal(breaker.state, 'half-open');
  assert.equal(breaker.canAttempt(), false);
  breaker.recordSuccess();
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.consecutiveFailures, 0);
});

test('a failed half-open probe reopens the circuit for a new reset interval', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetAfterMs: 10, clock: () => now });
  breaker.recordFailure();
  now = 10;
  assert.equal(breaker.canAttempt(), true);
  breaker.recordFailure();
  assert.equal(breaker.state, 'open');
  now = 19;
  assert.equal(breaker.canAttempt(), false);
});

test('requires an injected clock', () => {
  assert.throws(() => new CircuitBreaker({ failureThreshold: 1, resetAfterMs: 10 } as never));
});
