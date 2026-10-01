import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexCliJsonCapture } from '../src/capture/adapters/codex-cli-json.js';
import { attachVerifiedCodexPassiveCapture, createSyntheticDirectCliPassiveAdmission,
  isDirectCliPassiveResultForChild } from '../src/capture/direct-cli-ingress.js';
import { drainCaptureSpool } from '../src/capture/spool-drain.js';
import { CaptureSpool } from '../src/capture/spool.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { resolveRepository } from '../src/repository/local-repository.js';

const at = '2026-10-01T11:00:00.000Z';

test('direct CLI JSON admission reaches drain and analysis while the source is still active', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-cli-passive-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const repositoryId = resolveRepository(root)!.id as never;
  const databasePath = join(root, 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  store.registerRepository({ id: repositoryId, root, observedAt: at });
  store.close();
  const capture = new CodexCliJsonCapture('0.157.1');
  let drainCalls = 0;
  const admission = createSyntheticDirectCliPassiveAdmission({ databasePath, repositoryId,
    workingDirectory: root, now: () => at, scheduleDrain: () => { drainCalls++; } });
  try {
    capture.accept({ type: 'thread.started', thread_id: 'thread-direct' }, at);
    admission.threadStarted('thread-direct', at);
    const request = capture.accept({ type: 'item.started', item: { type: 'command_execution', id: 'item-1',
      status: 'in_progress', command: 'printf secret' } }, at)!;
    admission.event(request);
    const result = capture.accept({ type: 'item.completed', item: { type: 'command_execution', id: 'item-1',
      status: 'completed', exit_code: 0, command: 'printf secret', aggregated_output: 'raw private output' } }, at)!;
    admission.event(result);
    assert.equal(admission.source, 'synthetic-fixture');
    assert.equal(admission.status, 'capturing');
    assert.equal(admission.admitted, 3);
    assert.equal(drainCalls, 3);
    let drained;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const now = new Date(Date.parse(at) + attempt * 3_000).toISOString();
      drained = drainCaptureSpool({ databasePath, now: () => now,
        learningAdmission: new OperationalLearningService(databasePath), scheduleAnalysis: () => {} });
      if (drained.committed === 3) break;
    }
    assert.equal(drained?.committed, 3, JSON.stringify(drained));
    const observed = new ExperienceStore(databasePath);
    try {
      assert.equal(observed.loadSession('thread-direct' as never)?.source, 'codex');
      assert.equal(observed.listCapturedEventsPage().entries.length, 2);
    } finally { observed.close(); }
    assert.equal(new OperationalLearningService(databasePath).runNext({ repositoryId }).status, 'completed');
    admission.sessionEnded('thread-direct', at);
    assert.equal(admission.status, 'captured');
    assert.equal(admission.admitted, 4);
    const final = drainCaptureSpool({ databasePath, now: () => new Date(Date.parse(at) + 12_000).toISOString(),
      learningAdmission: new OperationalLearningService(databasePath), scheduleAnalysis: () => {} });
    assert.equal(final.committed, 4);
    const spool = new CaptureSpool(join(root, 'capture-spool.sqlite'));
    try { assert.equal(spool.status().pending, 0); }
    finally { spool.close(); }
    assert.equal(JSON.stringify([request, result]).includes('secret'), false);
    for (const file of ['experience.sqlite', 'capture-spool.sqlite']) {
      const bytes = readFileSync(join(root, file));
      assert.equal(bytes.includes(Buffer.from('raw private output')), false);
      assert.equal(bytes.includes(Buffer.from('printf secret')), false);
    }
  } finally { admission.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unverified child cannot attach direct passive ingress or write a session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-cli-passive-fake-'));
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"fake"})+"\\n")'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    assert.throws(() => attachVerifiedCodexPassiveCapture(child, { databasePath: join(root, 'experience.sqlite'),
      repositoryId: 'repo-direct' as never, workingDirectory: root }), /verified/i);
    assert.equal(isDirectCliPassiveResultForChild({ source: 'cli-json-item' } as never, child), false);
    if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
    const spool = new CaptureSpool(join(root, 'capture-spool.sqlite'));
    try { assert.equal(spool.status().admitted, 0); }
    finally { spool.close(); }
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('synthetic direct admission rejects changed scope and incomplete session without a trusted result', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-cli-passive-invalid-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const repositoryId = resolveRepository(root)!.id as never;
  const wrong = createSyntheticDirectCliPassiveAdmission({ databasePath: join(root, 'experience.sqlite'),
    repositoryId: 'other-repo' as never, workingDirectory: root, scheduleDrain: () => {} });
  const empty = createSyntheticDirectCliPassiveAdmission({ databasePath: join(root, 'experience.sqlite'),
    repositoryId, workingDirectory: root, scheduleDrain: () => {} });
  try {
    wrong.threadStarted('thread-wrong', at);
    assert.equal(wrong.status, 'degraded');
    assert.equal(wrong.admitted, 0);
    empty.threadStarted('thread-empty', at);
    assert.equal(empty.status, 'capturing');
    empty.sessionEnded('thread-empty', at);
    assert.equal(empty.status, 'degraded');
  } finally { wrong.close(); empty.close(); rmSync(root, { recursive: true, force: true }); }
});

test('synthetic direct admission does not report captured for a start-only command', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-cli-passive-start-only-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const repositoryId = resolveRepository(root)!.id as never;
  const admission = createSyntheticDirectCliPassiveAdmission({ databasePath: join(root, 'experience.sqlite'),
    repositoryId, workingDirectory: root, scheduleDrain: () => {} });
  const capture = new CodexCliJsonCapture('0.157.1');
  try {
    capture.accept({ type: 'thread.started', thread_id: 'thread-start-only' }, at);
    admission.threadStarted('thread-start-only', at);
    admission.event(capture.accept({ type: 'item.started', item: { type: 'command_execution', id: 'item-1',
      status: 'in_progress', command: 'true' } }, at)!);
    admission.sessionEnded('thread-start-only', at);
    assert.equal(admission.admitted, 3);
    assert.equal(admission.status, 'degraded');
  } finally { admission.close(); rmSync(root, { recursive: true, force: true }); }
});
