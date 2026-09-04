import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { resolveDiagnosticScope } from '../src/capture/diagnostic-scope.js';
import { CaptureDiagnosticStore } from '../src/storage/capture-diagnostic-store.js';

const now = () => '2026-09-04T08:00:00.000Z';

test('counts rejected Cursor delivery in its non-Git workspace scope', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-cursor-workspace-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cursor-diagnostic-data-'));
  try {
    const result = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      {
        workingDirectory: workspace,
        now,
        hookInput: JSON.stringify({
          conversation_id: 'session-1', hook_event_name: 'preToolUse', cwd: workspace,
          tool_name: 'Terminal', tool_use_id: 'tool-1', tool_input: { command: 'echo diagnostic-marker' }
        })
      }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    const workspaceId = JSON.parse(readFileSync(join(workspace, '.ael', 'workspace.json'), 'utf8')).workspaceId;
    assert.equal(workspaceId, basename(workspace).toLowerCase());
    const store = new CaptureDiagnosticStore(join(dataDir, 'capture-diagnostics.sqlite'));
    try {
      assert.deepEqual(store.counts({ source: 'cursor', scope: resolveDiagnosticScope(workspace) }), {
        'invalid-working-directory': 0,
        'persistence-failure': 0,
        'unsafe-command-shape': 0,
        'unsupported-tool': 1
      });
    } finally { store.close(); }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
