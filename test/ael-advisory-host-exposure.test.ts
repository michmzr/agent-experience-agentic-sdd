import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { challengeAdviceResponse } from '../src/advice/exposure-challenge.js';
import { attachCodexAdviceExposure, CodexAdviceExposureObserver, DeferredCodexAdviceExposureObserver,
  isHostAdviceExposureWitnessForChild } from '../src/advice/codex-exposure.js';
import { waitForAdviceContext } from '../src/advice/context-ready.js';

test('AAP-A4 challenge is response-only and bounded for ready advice', () => {
  const response = JSON.stringify({ status: 'ready', entries: [{ bundleId: `advice-use:${'a'.repeat(64)}`,
    candidateId: 'candidate-1', revision: '1', statement: 'Use pnpm.' }] }) + '\n';
  const challenged = challengeAdviceResponse(response, () => 'f'.repeat(32));
  assert.equal(JSON.parse(challenged).deliveryChallenge, `aap-challenge:${'f'.repeat(32)}`);
  assert.ok(Buffer.byteLength(challenged, 'utf8') <= 4096);
  assert.equal(response.includes('aap-challenge:'), false);
});

test('AAP-A4 challenge is absent when no advice is ready', () => {
  let called = false;
  const response = JSON.stringify({ status: 'unavailable', entries: [] }) + '\n';
  assert.equal(challengeAdviceResponse(response, () => { called = true; return 'f'.repeat(32); }), response);
  assert.equal(called, false);
});

const bundleId = `advice-use:${'a'.repeat(64)}`;
const marker = `aap-challenge:${'f'.repeat(32)}`;
const invocation = 'node challenge-retrieve.js context.json data';
const response = JSON.stringify({ status: 'ready', entries: [{ bundleId, candidateId: 'candidate-1', revision: '1',
  statement: 'Use pnpm.' }], deliveryChallenge: marker }) + '\n';

function observedEvents(output = response) {
  return [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { type: 'command_execution', id: 'retrieval-1', command: `/bin/zsh -lc '${invocation}'`, status: 'in_progress' } },
    { type: 'item.completed', item: { type: 'command_execution', id: 'retrieval-1', command: `/bin/zsh -lc '${invocation}'`,
      status: 'completed', exit_code: 0, aggregated_output: output } },
    { type: 'item.started', item: { type: 'command_execution', id: 'echo-1', command: `printf '%s\\n' '${marker}'`,
      status: 'in_progress' } },
    { type: 'item.completed', item: { type: 'command_execution', id: 'echo-1', command: `printf '%s\\n' '${marker}'`,
      status: 'completed', exit_code: 0, aggregated_output: `${marker}\n` } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
  ];
}

test('AAP-A4 host event chain binds the exact response and later independent command', () => {
  const observer = new CodexAdviceExposureObserver(invocation, bundleId);
  for (const event of observedEvents()) observer.consume(event);
  const result = observer.result();
  assert.equal(result?.bundleId, bundleId);
  assert.equal(result?.threadId, 'thread-1');
  assert.equal(result?.retrievalItemId, 'retrieval-1');
  assert.equal(result?.echoItemId, 'echo-1');
  assert.match(result?.witnessRef ?? '', /^codex-exposure:v1:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(result).includes('Use pnpm.'), false);
});

test('AAP-A4 host event chain rejects missing later access and altered response', () => {
  for (const events of [observedEvents().filter(event => event.type !== 'item.started' || event.item?.id !== 'echo-1'),
    observedEvents(response.replace(marker, `aap-challenge:${'e'.repeat(32)}`)).filter(event => event.type !== 'item.started'
      || event.item?.id !== 'echo-1'),
    observedEvents().map(event => event.type === 'item.completed' && event.item?.id === 'retrieval-1'
      ? { ...event, item: { ...event.item, exit_code: 1 } } : event)]) {
    const observer = new CodexAdviceExposureObserver(invocation, bundleId);
    for (const event of events) observer.consume(event);
    assert.equal(observer.result(), null);
  }
});

test('AAP-A4 host event chain rejects a retrieval command with extra shell work', () => {
  const observer = new CodexAdviceExposureObserver(invocation, bundleId);
  for (const event of observedEvents().map(event => event.item?.id === 'retrieval-1'
    ? { ...event, item: { ...event.item, command: `/bin/zsh -lc '${invocation}; printf forged'` } } : event)) observer.consume(event);
  assert.equal(observer.result(), null);
});

test('AAP-A4 imported or non-Codex event streams cannot mint a trusted child witness', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"fake"})+"\\n")'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await attachCodexAdviceExposure(child, { bundleId, dataDir: '/private/tmp/no-aap-store',
    invocation, repositoryId: 'repo-a', lessonId: 'candidate-1', lessonRevision: '1',
    sessionId: 'session-b', contextRevision: 'context-1', operationSignature: 'tool:search', retrievalRef: 'retrieval-b' });
  assert.equal(result, null);
  assert.equal(isHostAdviceExposureWitnessForChild({ bundleId } as never, child), false);
  if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
});

test('AAP-A4 fake binary named codex is rejected before consuming its event stream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-fake-codex-child-'));
  const fake = join(root, 'codex');
  writeFileSync(fake, '#!/bin/sh\nsleep 2\n');
  chmodSync(fake, 0o700);
  const child = spawn(fake, ['exec', '--json', '--ephemeral'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const result = attachCodexAdviceExposure(child, { bundleId, dataDir: root,
      invocation, repositoryId: 'repo-a', lessonId: 'candidate-1', lessonRevision: '1',
      sessionId: 'session-b', contextRevision: 'context-1', operationSignature: 'tool:search', retrievalRef: 'retrieval-b' });
    assert.equal(child.stdout!.listenerCount('data'), 0);
    assert.equal(await result, null);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

const deferredScope = (sessionId: string) => ({ bundleId, dataDir: '/private/tmp/aap-test-data',
  invocation, repositoryId: 'repo-a', lessonId: 'candidate-1', lessonRevision: '1',
  sessionId, contextRevision: 'context-1', operationSignature: 'tool:search', retrievalRef: 'retrieval-b' });

test('AAP-A4 deferred scope uses host thread before the first retrieval event', () => {
  const order: string[] = [];
  const observer = new DeferredCodexAdviceExposureObserver(threadId => {
    order.push(`setup:${threadId}`);
    return deferredScope(threadId);
  });
  for (const event of observedEvents()) {
    if (event.type === 'item.started') order.push(`item:${event.item?.id}`);
    observer.consume(event);
  }
  assert.equal(observer.result()?.scope.sessionId, 'thread-1');
  assert.equal(observer.result()?.observed.threadId, 'thread-1');
  assert.deepEqual(order.slice(0, 2), ['setup:thread-1', 'item:retrieval-1']);
});

test('AAP-A4 delivery becomes observable after echo completion before selection and application', () => {
  const observer = new DeferredCodexAdviceExposureObserver(deferredScope);
  const events = observedEvents();
  for (const event of events.slice(0, 5)) observer.consume(event);
  assert.equal(observer.deliveryReady(), null);
  observer.consume(events[5]);
  assert.equal(observer.deliveryReady()?.scope.sessionId, 'thread-1');
  assert.equal(observer.result(), null);
  const order = ['delivered'];
  order.push('selected');
  observer.consume({ type: 'item.started', item: { type: 'command_execution', id: 'apply-1',
    command: 'printf applied', status: 'in_progress' } });
  order.push('applied');
  assert.deepEqual(order, ['delivered', 'selected', 'applied']);
  observer.consume(events[6]);
  assert.equal(observer.result()?.observed.witnessRef, observer.deliveryReady()?.observed.witnessRef);
});

test('AAP-A4 deferred scope rejects callback failure, mismatch and duplicate thread', () => {
  for (const make of [() => { throw new Error('setup failed'); },
    (_threadId: string) => deferredScope('other-thread')]) {
    const observer = new DeferredCodexAdviceExposureObserver(make);
    for (const event of observedEvents()) observer.consume(event);
    assert.equal(observer.result(), null);
  }
  const duplicate = new DeferredCodexAdviceExposureObserver(deferredScope);
  for (const event of [observedEvents()[0]!, observedEvents()[0]!, ...observedEvents().slice(1)]) duplicate.consume(event);
  assert.equal(duplicate.result(), null);
  const premature = new DeferredCodexAdviceExposureObserver(deferredScope);
  for (const event of [observedEvents()[2]!, ...observedEvents()]) premature.consume(event);
  assert.equal(premature.result(), null);
});

test('AAP-A4 context readiness waits for atomic file publication and rejects links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-context-ready-'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const path = join(root, 'retrieval.json');
    const waiting = waitForAdviceContext(path, 500);
    timer = setTimeout(() => writeFileSync(path, '{}'), 30);
    await waiting;
    rmSync(path);
    symlinkSync(join(root, 'missing.json'), path);
    await assert.rejects(waitForAdviceContext(path, 50), /regular file/i);
    rmSync(path);
    await assert.rejects(waitForAdviceContext(path, 10), /timed out/i);
  } finally { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); }
});
