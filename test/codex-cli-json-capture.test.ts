import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { CodexCliJsonCapture, codexCliJsonEvidenceCapability, observeVerifiedCodexCliJsonChild } from '../src/capture/adapters/codex-cli-json.js';
import { projectCodexCliJsonEvidence } from '../src/evidence/codex-cli-json-projection.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';

const at = '2026-10-01T10:00:00.000Z';
const thread = '0199a400-0000-7000-8000-000000000001';
const item = 'item_123';

function started(command = 'printf secret'): unknown {
  return { type: 'item.started', item: { id: item, type: 'command_execution', command, aggregated_output: '', status: 'in_progress', exit_code: null } };
}

function completed(exitCode: number | null, status: string, output = 'secret output'): unknown {
  return { type: 'item.completed', item: { id: item, type: 'command_execution', command: 'printf secret', aggregated_output: output, status, exit_code: exitCode } };
}

test('Codex CLI JSON source emits linked success and failure without retaining command or output', () => {
  const capture = new CodexCliJsonCapture('0.157.1');
  assert.equal(capture.accept({ type: 'thread.started', thread_id: thread }, at), undefined);
  const request = capture.accept(started(), at);
  const success = capture.accept(completed(0, 'completed'), '2026-10-01T10:00:01.000Z');
  assert.equal(request?.phase, 'pre-action');
  assert.equal(success?.phase, 'post-result');
  assert.equal(success?.relatedEventId, request?.sourceEventId);
  assert.equal(success?.exitStatus, 0);
  assert.equal(success?.outcome, 'succeeded');
  assert.equal(JSON.stringify([request, success]).includes('secret'), false);

  const failed = new CodexCliJsonCapture('0.157.1');
  failed.accept({ type: 'thread.started', thread_id: thread }, at);
  failed.accept(started(), at);
  const result = failed.accept(completed(1, 'failed'), '2026-10-01T10:00:01.000Z');
  assert.equal(result?.exitStatus, 1);
  assert.equal(result?.outcome, 'failed');
});

test('Codex CLI JSON source keeps missing exit status unknown and requires a matching start', () => {
  const capture = new CodexCliJsonCapture('0.157.1');
  capture.accept({ type: 'thread.started', thread_id: thread }, at);
  assert.equal(capture.accept(completed(0, 'completed'), at), undefined);
  capture.accept(started(), at);
  const unknown = capture.accept(completed(null, 'failed'), at);
  assert.equal(unknown?.outcome, 'unknown');
  assert.equal(unknown?.exitStatus, undefined);
  assert.equal(capture.accept(completed(0, 'completed'), at), undefined);
  assert.equal(codexCliJsonEvidenceCapability.processExit, 'available');
  assert.equal(codexCliJsonEvidenceCapability.asyncRelation, 'not-qualified');
});

test('Codex CLI JSON source rejects a command start without a terminal item at close', () => {
  const capture = new CodexCliJsonCapture('0.157.1');
  capture.accept({ type: 'thread.started', thread_id: thread }, at);
  capture.accept(started(), at);
  assert.throws(() => capture.assertComplete(), /pending|incomplete/i);
  capture.accept(completed(0, 'completed'), at);
  assert.doesNotThrow(() => capture.assertComplete());
});

test('Codex CLI JSON source ignores other item classes and rejects changed identities', () => {
  const capture = new CodexCliJsonCapture('0.157.1');
  capture.accept({ type: 'thread.started', thread_id: thread }, at);
  assert.equal(capture.accept({ type: 'item.started', item: { id: 'x', type: 'agent_message', text: 'private' } }, at), undefined);
  assert.equal(capture.accept({ type: 'turn.completed', usage: { input_tokens: 7 } }, at), undefined);
  capture.accept(started(), at);
  assert.throws(() => capture.accept({ type: 'thread.started', thread_id: 'different-thread' }, at), /thread/i);
  assert.throws(() => capture.accept(completed(0.5, 'completed'), at), /exit/i);
  assert.throws(() => capture.accept(completed(0, 'completed'), 'not-a-time'), /timestamp/i);
});

test('Codex CLI JSON adapter links a delayed terminal item after an intervening observation page', () => {
  const capture = new CodexCliJsonCapture('0.157.1');
  capture.accept({ type: 'thread.started', thread_id: thread }, at);
  const request = capture.accept(started('sleep 3'), at)!;
  const firstPage = [request];
  assert.equal(firstPage.length, 1);
  const result = capture.accept(completed(0, 'completed'), '2026-10-01T10:00:04.000Z')!;
  assert.equal(result.relatedEventId, request.sourceEventId);
  assert.equal(result.outcome, 'succeeded');
});

test('Codex CLI JSON qualification is bound to the installed version', () => {
  assert.throws(() => new CodexCliJsonCapture('0.157.2'), /version/i);
});

test('AEC rejects fabricated CLI-shaped normalized events as host provenance', () => {
  const id = 'cli-' + 'a'.repeat(64);
  const request = normalizeMappedCapture({ source: 'codex', sourceEventId: `${id}-start`, sessionId: thread,
    phase: 'pre-action', occurredAt: at, tool: 'shell', action: 'command', summary: 'Codex CLI command started.' });
  const result = normalizeMappedCapture({ source: 'codex', sourceEventId: `${id}-result`, sessionId: thread,
    phase: 'post-result', occurredAt: at, tool: 'shell', action: 'command', summary: 'Codex CLI command completed.',
    outcome: 'succeeded', exitStatus: 0, relatedEventId: `${id}-start` });
  assert.throws(() => projectCodexCliJsonEvidence({ session: { id: request.sessionId, source: 'codex', startedAt: at },
    stream: { sessionId: thread, events: [request, result], childExitCode: 0 } }), /trusted|provenance/i);
});

test('AEC rejects JSONL from an unverified direct child before reading it', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"fake"})+"\\n")'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => observeVerifiedCodexCliJsonChild(child), /verified/i);
  if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
});
