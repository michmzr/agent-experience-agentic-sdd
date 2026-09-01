import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createProcessDebriefTerminalHost, runSessionDebrief } from '../src/review/debrief-terminal.js';
import type { SessionDebrief } from '../src/review/debrief-model.js';
import { FakeDebriefTerminalHost } from './helpers/debrief-terminal.js';

const model: SessionDebrief = {
  source: 'codex', sessionPseudonym: '[REDACTED:opaque-id:session]',
  startedAt: '2026-09-01T10:00:00.000Z', endedAt: '2026-09-01T10:05:00.000Z', durationMs: 300_000, actionCount: 1,
  headline: 'Review completed with 1 evidence-backed improvements.', initialInsightIndex: 0,
  counts: { strengths: 1, improvements: 1, conflicts: 0, diagnostics: 0 },
  insights: [{
    id: 'project-improvement:architecture:terminal-boundary', kind: 'project-improvement', category: 'architecture', severity: 'high',
    title: 'terminal boundary', recommendation: 'Separate the terminal boundary.',
    evidence: [{ id: 'event-a', occurredAt: '2026-09-01T10:01:00.000Z', kind: 'tool', outcome: 'failed', tool: 'pnpm', summary: 'tool pnpm: failed' }],
    timeline: [{ kind: 'session-start', occurredAt: '2026-09-01T10:00:00.000Z' }, { kind: 'session-end', occurredAt: '2026-09-01T10:05:00.000Z' }]
  }]
};

async function settle(): Promise<void> { await new Promise<void>((resolve) => queueMicrotask(resolve)); }

test('enters once, redraws after navigation, and cleans up once on q', async () => {
  const host = new FakeDebriefTerminalHost();
  const run = runSessionDebrief(model, host);
  await settle();
  host.key({ name: 'j', ctrl: false });
  await settle();
  host.key({ name: 'q', ctrl: false });
  assert.deepEqual(await run, { status: 'completed' });
  assert.equal(host.enterCalls, 1);
  assert.equal(host.frames.length, 2);
  assert.equal(host.unsubscribeCalls, 1);
  assert.equal(host.leaveCalls, 1);
});

test('returns interrupted for Ctrl+C and host interrupt', async () => {
  const ctrlC = new FakeDebriefTerminalHost();
  const ctrlCRun = runSessionDebrief(model, ctrlC);
  await settle();
  ctrlC.key({ name: 'c', ctrl: true });
  assert.deepEqual(await ctrlCRun, { status: 'interrupted' });
  assert.equal(ctrlC.leaveCalls, 1);

  const interrupted = new FakeDebriefTerminalHost();
  const interruptedRun = runSessionDebrief(model, interrupted);
  await settle();
  interrupted.interrupt();
  assert.deepEqual(await interruptedRun, { status: 'interrupted' });
  assert.equal(interrupted.leaveCalls, 1);
});

test('returns unavailable and cleans up after terminal failures', async () => {
  const render = new FakeDebriefTerminalHost({ failFrame: true });
  assert.deepEqual(await runSessionDebrief(model, render), { status: 'unavailable' });
  assert.equal(render.leaveCalls, 1);

  const enter = new FakeDebriefTerminalHost({ failEnter: true });
  assert.deepEqual(await runSessionDebrief(model, enter), { status: 'unavailable' });
  assert.equal(enter.leaveCalls, 1);
});

test('handles input end and error with their specified results', async () => {
  const ended = new FakeDebriefTerminalHost();
  const endedRun = runSessionDebrief(model, ended);
  await settle();
  ended.end();
  assert.deepEqual(await endedRun, { status: 'completed' });
  assert.equal(ended.leaveCalls, 1);

  const errored = new FakeDebriefTerminalHost();
  const errorRun = runSessionDebrief(model, errored);
  await settle();
  errored.error();
  assert.deepEqual(await errorRun, { status: 'unavailable' });
  assert.equal(errored.leaveCalls, 1);
});

test('redraws using the supplied resize dimensions', async () => {
  const host = new FakeDebriefTerminalHost();
  const run = runSessionDebrief(model, host);
  await settle();
  host.resize({ width: 72, height: 20 });
  await settle();
  assert.match(host.frames.at(-1)!, /SESSION DEBRIEF/);
  assert.ok(host.frames.at(-1)!.split('\n').every((line) => line.length <= 72));
  host.key({ name: 'q', ctrl: false });
  await run;
});

test('maps j/k, escape, return and d to reducer semantics', async () => {
  const host = new FakeDebriefTerminalHost();
  const run = runSessionDebrief(model, host);
  await settle();
  host.key({ name: 'return', ctrl: false });
  await settle();
  assert.match(host.frames.at(-1)!, /Detail/);
  host.key({ name: 'd', ctrl: false });
  await settle();
  assert.match(host.frames.at(-1)!, /tool pnpm: failed/);
  host.key({ name: 'escape', ctrl: false });
  await settle();
  assert.match(host.frames.at(-1)!, /Insight 1\/1/);
  host.key({ name: 'k', ctrl: false });
  await settle();
  assert.match(host.frames.at(-1)!, /Insight 1\/1/);
  host.key({ name: 'q', ctrl: false });
  await run;
});

test('does not touch a non-interactive terminal', async () => {
  const host = new FakeDebriefTerminalHost({ interactive: false });
  assert.deepEqual(await runSessionDebrief(model, host), { status: 'unavailable' });
  assert.equal(host.enterCalls, 0);
  assert.equal(host.frames.length, 0);
  assert.equal(host.subscribeCalls, 0);
  assert.equal(host.leaveCalls, 0);
});

test('runs both cleanup steps once when either cleanup operation throws', async () => {
  const unsubscribeFailure = new FakeDebriefTerminalHost({ failUnsubscribe: true });
  const unsubscribeRun = runSessionDebrief(model, unsubscribeFailure);
  await settle();
  unsubscribeFailure.key({ name: 'q', ctrl: false });
  assert.deepEqual(await unsubscribeRun, { status: 'completed' });
  assert.equal(unsubscribeFailure.unsubscribeCalls, 1);
  assert.equal(unsubscribeFailure.leaveCalls, 1);

  const leaveFailure = new FakeDebriefTerminalHost({ failLeave: true });
  const leaveRun = runSessionDebrief(model, leaveFailure);
  await settle();
  leaveFailure.key({ name: 'q', ctrl: false });
  assert.deepEqual(await leaveRun, { status: 'completed' });
  assert.equal(leaveFailure.unsubscribeCalls, 1);
  assert.equal(leaveFailure.leaveCalls, 1);
});

test('process host reports whether both process streams can support terminal mode', () => {
  const host = createProcessDebriefTerminalHost();
  assert.equal(host.interactive, Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function'));
  assert.equal(host.color, Boolean(process.stdout.isTTY && !('NO_COLOR' in process.env)));
});

test('process host restores raw mode before leaving the alternate screen and removes only its listeners', () => {
  const events: string[] = [];
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false,
    setRawMode(value: boolean): void { this.isRaw = value; events.push(`raw:${value}`); },
    resume(): void {}, setEncoding(): void {}
  });
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24,
    write(value: string): boolean { events.push(value); return true; }
  });
  const priorKeypress = () => {};
  const priorResize = () => {};
  const priorEnd = () => {};
  const priorError = () => {};
  const priorInterrupt = () => {};
  input.on('keypress', priorKeypress);
  input.on('end', priorEnd);
  input.on('error', priorError);
  output.on('resize', priorResize);
  const initialInterrupts = process.listenerCount('SIGINT');
  process.on('SIGINT', priorInterrupt);
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!;
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  Object.defineProperty(process, 'stdout', { configurable: true, value: output });
  try {
    const host = createProcessDebriefTerminalHost();
    host.enter();
    const unsubscribe = host.subscribe({ key() {}, resize() {}, end() {}, error() {}, interrupt() {} });
    unsubscribe();
    host.leave();
    assert.deepEqual([input.listenerCount('keypress'), output.listenerCount('resize'), input.listenerCount('end'), input.listenerCount('error'), process.listenerCount('SIGINT')], [1, 1, 1, 1, initialInterrupts + 1]);
    assert.deepEqual(events, ['\u001b[?1049h\u001b[?25l', 'raw:true', 'raw:false', '\u001b[?25h\u001b[?1049l']);
  } finally {
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    Object.defineProperty(process, 'stdout', stdoutDescriptor);
    input.removeListener('keypress', priorKeypress);
    input.removeListener('end', priorEnd);
    input.removeListener('error', priorError);
    output.removeListener('resize', priorResize);
    process.removeListener('SIGINT', priorInterrupt);
  }
});
