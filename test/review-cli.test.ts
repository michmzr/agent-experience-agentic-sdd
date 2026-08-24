import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../src/cli.js';

test('accepts only an explicit supported source and session for manual review', () => {
  const result = runCli(['review', 'session', '--source', 'codex', '--session', 'session-123', '--json']);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    review: 'validated',
    source: 'codex',
    session: 'session-123',
    allowExpensiveChecks: false
  });
});

test('parses the explicit expensive-checks gate without running a review', () => {
  const result = runCli(['review', 'session', '--source', 'cursor', '--session', 'export-a', '--allow-expensive-checks', '--json']);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    review: 'validated',
    source: 'cursor',
    session: 'export-a',
    allowExpensiveChecks: true
  });
});

test('rejects missing or unsupported explicit review selection', () => {
  for (const args of [
    ['review', 'session', '--session', 'session-123'],
    ['review', 'session', '--source', 'codex'],
    ['review', 'session', '--source', 'unknown', '--session', 'session-123'],
    ['review', 'session', '--source', 'Codex', '--session', 'session-123'],
    ['review', 'session', '--source', 'codex', '--session', 'latest'],
    ['review', 'session', '--source', 'codex', '--latest'],
    ['review', 'latest', '--source', 'codex', '--session', 'session-123']
  ]) {
    const result = runCli(args);
    assert.equal(result.exitCode, 2, args.join(' '));
    assert.match(result.stderr, /Option is required|Source must be codex, claude-code, or cursor|explicit --session|Unsupported option|Unknown command|Option requires a value/, args.join(' '));
  }
});
