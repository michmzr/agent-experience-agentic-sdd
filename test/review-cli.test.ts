import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli, runCliAsync } from '../src/cli.js';

test('runs the complete local review pipeline for an explicit session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-cli-')); mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'session.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z', payload: 'password=must-not-leak' })}\n`);
  const result = await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'nested/session.jsonl', '--json']);
  assert.equal(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.candidates[0].state, 'candidate');
  assert.equal(output.proposals[0].requiresSpecification, true);
  assert.equal(output.findings[0].recommendation.state, 'agreed');
  assert.equal(result.stdout.includes('must-not-leak'), false);
});

test('reports truthful non-JSON completion and keeps the async review path canonical', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-text-'));
  writeFileSync(join(root, 'session.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  const result = await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'session.jsonl', '--allow-expensive-checks']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Review completed: 1 finding groups, 1 candidates, 1 proposals\./);
  const sync = runCli(['review', 'session', '--source', 'codex', '--root', root, '--session', 'session.jsonl']);
  assert.equal(sync.exitCode, 2);
  assert.match(sync.stderr, /Unknown command/);
});

test('rejects missing or unsupported explicit review selection', async () => {
  for (const args of [
    ['review', 'session', '--session', 'session-123'],
    ['review', 'session', '--source', 'codex'],
    ['review', 'session', '--source', 'unknown', '--session', 'session-123'],
    ['review', 'session', '--source', 'Codex', '--session', 'session-123'],
    ['review', 'session', '--source', 'codex', '--session', 'latest'],
    ['review', 'session', '--source', 'codex', '--latest'],
    ['review', 'latest', '--source', 'codex', '--session', 'session-123']
  ]) {
    const result = await runCliAsync(args);
    assert.equal(result.exitCode, 2, args.join(' '));
    assert.match(result.stderr, /Option is required|Source must be codex, claude-code, or cursor|explicit --session|Unsupported option|Unknown command|Option requires a value/, args.join(' '));
  }
});

test('does not leak filesystem paths in review diagnostics', async () => {
  const sensitiveRoot = join(tmpdir(), 'SENSITIVE-review-root');
  for (const json of [true, false]) {
    const result = await runCliAsync(['review', 'session', '--source', 'cursor', '--root', sensitiveRoot, '--session', 'missing.md', ...(json ? ['--json'] : [])]);
    assert.equal(result.exitCode, 1);
    assert.equal(`${result.stdout}${result.stderr}`.includes('SENSITIVE-review-root'), false);
    assert.match(`${result.stdout}${result.stderr}`, /Review failed/);
  }
});

test('discovers repository-scoped sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-discovery-'));
  writeFileSync(join(root, 'older.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  writeFileSync(join(root, 'newer.jsonl'), `${JSON.stringify({ kind: 'tool', occurredAt: '2026-08-24T11:00:00.000Z', tool: 'git', exitStatus: 1 })}\n`);
  const discovered = await runCliAsync(['review', 'sessions', '--source', 'codex', '--root', root, '--json']);
  assert.deepEqual(JSON.parse(discovered.stdout).map(({ id }: { id: string }) => id), ['newer.jsonl', 'older.jsonl'].sort());
});

test('derives materially different traceable findings from different session evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-evidence-'));
  writeFileSync(join(root, 'message.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  writeFileSync(join(root, 'failure.jsonl'), `${JSON.stringify({ kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', tool: 'git', exitStatus: 1 })}\n`);
  const message = JSON.parse((await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'message.jsonl', '--json'])).stdout);
  const failure = JSON.parse((await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'failure.jsonl', '--json'])).stdout);
  assert.notDeepEqual(message.findings, failure.findings);
  assert.notDeepEqual(message.candidates, failure.candidates);
  assert.equal(failure.proposals[0].findingId, failure.candidates[0].findingId);
});
