import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

test('registers only passive technical and session hooks', () => {
  const cursor = JSON.parse(readFileSync('.cursor/hooks.json', 'utf8')) as { version: number; hooks: Record<string, unknown> };
  const codex = JSON.parse(readFileSync('.codex/hooks.json', 'utf8')) as { description: string; hooks: Record<string, unknown> };

  assert.equal(cursor.version, 1);
  assert.deepEqual(Object.keys(cursor.hooks).sort(), [
    'postToolUse', 'preToolUse', 'sessionEnd', 'sessionStart'
  ]);
  assert.deepEqual(Object.keys(codex.hooks).sort(), [
    'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart'
  ]);
  assert.equal(JSON.stringify({ cursor, codex }).includes('Prompt'), false);
  assert.equal(JSON.stringify({ cursor, codex }).includes('beforeSubmitPrompt'), false);
});

test('uses one fail-open wrapper without permission output', () => {
  const wrapper = readFileSync('.agents/hooks/ael-passive-capture.sh', 'utf8');
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, /git rev-parse --show-toplevel/);
  assert.match(wrapper, /capture hook --source/);
  assert.doesNotMatch(wrapper.toLowerCase(), /deny|ask|block|permissiondecision/);
  assert.equal(statSync('.agents/hooks/ael-passive-capture.sh').mode & 0o111, 0o111);
});
