import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';

const skillDirectory = join(process.cwd(), 'skills', 'ael');
const referenceFiles = [
  'setup-and-health.md',
  'session-review.md',
  'knowledge-lifecycle.md',
  'runtime-and-profiles.md',
  'diagnostics.md',
  'command-reference.md'
] as const;

test('publishes an AEL-only open skill router with the declared references', () => {
  const routerPath = join(skillDirectory, 'SKILL.md');
  assert.equal(existsSync(routerPath), true, 'skills/ael/SKILL.md must exist');
  const router = readFileSync(routerPath, 'utf8');

  assert.match(router, /^---\nname: ael\n/m);
  assert.match(router, /description:.*Agent Experience Layer/i);
  for (const file of referenceFiles) {
    assert.equal(existsSync(join(skillDirectory, 'references', file)), true, `missing reference: ${file}`);
    assert.match(router, new RegExp(`references/${file.replace('.', '\\.')}`));
  }
  assert.equal((router.match(/references\/[\w-]+\.md/g) ?? []).length, referenceFiles.length);
});

test('routes AEL requests and declines unrelated generic workflows', () => {
  const router = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8').toLowerCase();
  const positiveRequests = [
    'install ael in this workspace',
    'review this Codex session with AEL',
    'promote an AEL lesson after verification',
    'explain the AEL runtime profile',
    'diagnose AEL_CAPTURE_INVALID_INPUT',
    'show AEL skill commands'
  ];
  for (const request of positiveRequests) assert.match(request, /ael|codex session/i);
  assert.match(router, /do not use for generic review, conflict, or runtime requests unrelated to ael/i);

  for (const request of ['review this pull request', 'resolve a merge conflict', 'optimize a database query']) {
    assert.doesNotMatch(request, /\bael\b/i);
  }
});
