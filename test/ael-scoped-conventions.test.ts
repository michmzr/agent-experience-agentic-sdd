import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadProjectSettings } from '../src/config/project-settings.js';
import { readProjectInstructionContext, readScopedToolConventions } from '../src/learning/project-conventions.js';

test('ASC-A1 recognizes finite pnpm and uv directives without quoting, code or negation', () => {
  const root = mkdtempSync(join(tmpdir(), 'asc-grammar-'));
  try {
    writeFileSync(join(root, 'AGENTS.md'), [
      'Use pnpm (never npm).', 'pnpm only.', 'Prefer uv rather than pip.', 'uv only.',
      '"Use pnpm (never npm)"', '> Use pnpm instead of npm', '```', 'Use pnpm instead of npm', '```',
      'Do not use pnpm instead of npm.', 'Never use uv rather than pip.', 'This page mentions use pnpm instead of npm.',
      'Use `pnpm` instead of `npm`.'
    ].join('\n'));
    const context = readProjectInstructionContext(root);
    assert.deepEqual(context.conventions.map(({ tool, source }) => ({ tool, source })), [
      { tool: 'pnpm', source: 'AGENTS.md:1' }, { tool: 'pnpm', source: 'AGENTS.md:2' },
      { tool: 'uv', source: 'AGENTS.md:3' }, { tool: 'uv', source: 'AGENTS.md:4' },
      { tool: 'pnpm', source: 'AGENTS.md:13' }
    ]);
    assert.equal(context.instructions[0]?.delivered, 'unknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ASC-A2 mobile directive requires an explicit path mapping and never applies to backend', () => {
  const root = mkdtempSync(join(tmpdir(), 'asc-scope-'));
  try {
    mkdirSync(join(root, '.ael')); mkdirSync(join(root, 'apps/mobile'), { recursive: true }); mkdirSync(join(root, 'services/backend'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'For mobile app, use pnpm (never npm).\n');
    assert.equal(readProjectInstructionContext(root).conventions.length, 0);
    assert.equal(readScopedToolConventions(root, 'apps/mobile/src').length, 0);
    writeFileSync(join(root, '.ael/settings.json'), JSON.stringify({ version: 1, captureDeliveryDeadlineMs: 2000,
      instructionScopes: [{ location: 'AGENTS.md', qualifier: 'mobile app', path: 'apps/mobile' }] }));
    assert.equal(loadProjectSettings(root).instructionScopes?.[0]?.path, 'apps/mobile');
    assert.equal(readProjectInstructionContext(root).conventions.length, 0);
    assert.deepEqual(readScopedToolConventions(root, 'apps/mobile/src').map(({ tool, scopePath }) => ({ tool, scopePath })), [{ tool: 'pnpm', scopePath: 'apps/mobile' }]);
    assert.equal(readScopedToolConventions(root, 'services/backend').length, 0);
    assert.equal(readScopedToolConventions(root, 'apps/mobile-other').length, 0);
    assert.equal(readScopedToolConventions(root, '../apps/mobile').length, 0);
    const outside = mkdtempSync(join(tmpdir(), 'asc-scope-target-'));
    try {
      symlinkSync(outside, join(root, 'apps/mobile/escape'));
      assert.equal(readScopedToolConventions(root, 'apps/mobile/escape/file').length, 0);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ASC-A2 rejects traversal, ambiguous mappings, and symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'asc-map-')); const outside = mkdtempSync(join(tmpdir(), 'asc-outside-'));
  const save = (scopes: unknown) => writeFileSync(join(root, '.ael/settings.json'), JSON.stringify({ version: 1, captureDeliveryDeadlineMs: 2000, instructionScopes: scopes }));
  try {
    mkdirSync(join(root, '.ael')); mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    const valid = { location: 'AGENTS.md', qualifier: 'mobile app', path: 'apps/mobile' };
    save([{ ...valid, path: '../outside' }]); assert.throws(() => loadProjectSettings(root), /scope|path/i);
    save([valid, { ...valid, path: 'apps/mobile/sub' }]); assert.throws(() => loadProjectSettings(root), /ambiguous|overlap/i);
    save(Array.from({ length: 17 }, (_, index) => ({ ...valid, qualifier: `mobile app ${index}` }))); assert.throws(() => loadProjectSettings(root), /scope/i);
    symlinkSync(outside, join(root, 'apps/escape'));
    save([{ ...valid, path: 'apps/escape' }]); assert.throws(() => loadProjectSettings(root), /symlink|scope/i);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
