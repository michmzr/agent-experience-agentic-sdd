import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadAnalysisWorkerSettings } from '../src/learning/worker-settings.js';

function dataDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'ael-analysis-worker-'));
}

function writeSettings(directory: string, contents: string): void {
  writeFileSync(join(directory, 'analysis-worker.json'), contents);
}

test('returns frozen defaults when the global settings file is missing', () => {
  const settings = loadAnalysisWorkerSettings(dataDirectory());
  assert.deepEqual(settings, { version: 1, maxProcesses: 3, idleTimeoutMs: 300_000 });
  assert.equal(Object.isFrozen(settings), true);
});

test('loads a valid global settings file', () => {
  const directory = dataDirectory();
  writeSettings(directory, JSON.stringify({ version: 1, maxProcesses: 6, idleTimeoutMs: 60_000 }));
  assert.deepEqual(loadAnalysisWorkerSettings(directory), { version: 1, maxProcesses: 6, idleTimeoutMs: 60_000 });
});

test('rejects maxProcesses outside 1..16', () => {
  for (const maxProcesses of [0, 17]) {
    const directory = dataDirectory();
    writeSettings(directory, JSON.stringify({ version: 1, maxProcesses, idleTimeoutMs: 60_000 }));
    assert.throws(() => loadAnalysisWorkerSettings(directory), /Max processes must be between 1 and 16\./);
  }
});

test('rejects idleTimeoutMs outside 1000..3600000', () => {
  for (const idleTimeoutMs of [999, 3_600_001]) {
    const directory = dataDirectory();
    writeSettings(directory, JSON.stringify({ version: 1, maxProcesses: 3, idleTimeoutMs }));
    assert.throws(() => loadAnalysisWorkerSettings(directory), /Idle timeout must be between 1000 and 3600000 milliseconds\./);
  }
});

test('rejects unknown or missing fields and invalid values', () => {
  const values = [
    { version: 1, maxProcesses: 3, idleTimeoutMs: 60_000, extra: true },
    { version: 1, maxProcesses: 3 },
    { version: 2, maxProcesses: 3, idleTimeoutMs: 60_000 },
    { version: 1, maxProcesses: 3.5, idleTimeoutMs: 60_000 },
    { version: 1, maxProcesses: 3, idleTimeoutMs: '60000' }
  ];
  for (const value of values) {
    const directory = dataDirectory();
    writeSettings(directory, JSON.stringify(value));
    assert.throws(() => loadAnalysisWorkerSettings(directory), /Analysis worker settings are invalid\./);
  }
});

test('rejects invalid JSON and non-object JSON values without exposing input', () => {
  for (const contents of ['{not-json', 'null', '[]', '42', '"settings"', 'true']) {
    const directory = dataDirectory();
    writeSettings(directory, contents);
    assert.throws(() => loadAnalysisWorkerSettings(directory), (error: unknown) => {
      assert.equal((error as Error).message, 'Analysis worker settings are invalid.');
      assert.equal((error as Error).message.includes(contents), false);
      return true;
    });
  }
});

test('rejects symlinked and non-regular settings files', () => {
  const symlinkDirectory = dataDirectory();
  const target = join(symlinkDirectory, 'target.json');
  writeFileSync(target, JSON.stringify({ version: 1, maxProcesses: 3, idleTimeoutMs: 60_000 }));
  symlinkSync(target, join(symlinkDirectory, 'analysis-worker.json'));
  assert.throws(() => loadAnalysisWorkerSettings(symlinkDirectory), /must be a regular file/);

  const directory = dataDirectory();
  mkdirSync(join(directory, 'analysis-worker.json'));
  assert.throws(() => loadAnalysisWorkerSettings(directory), /must be a regular file/);
});
