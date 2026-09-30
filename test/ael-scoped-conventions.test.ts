import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadProjectSettings } from '../src/config/project-settings.js';
import { readProjectInstructionContext, readScopedToolConventions } from '../src/learning/project-conventions.js';
import { DETECTOR_SET_VERSION, OperationalLearningRepository } from '../src/learning/repository.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';

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

test('ASC-A3 preserves the instruction revision and scoped evidence across edits and restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'asc-history-'));
  const databasePath = join(root, 'experience.sqlite');
  const project = join(root, 'project');
  try {
    mkdirSync(project); initializeGitRepository(project);
    mkdirSync(join(project, '.ael')); mkdirSync(join(project, 'apps/mobile'), { recursive: true });
    writeFileSync(join(project, '.ael/settings.json'), JSON.stringify({ version: 1, captureDeliveryDeadlineMs: 2000,
      instructionScopes: [{ location: 'AGENTS.md', qualifier: 'mobile app', path: 'apps/mobile' }] }));
    writeFileSync(join(project, 'AGENTS.md'), 'For mobile app, use pnpm (never npm).\n');
    const store = new ExperienceStore(databasePath);
    try {
      store.registerRepository({ id: 'repo-1', root: project, observedAt: '2026-09-29T10:00:00.000Z' });
      store.appendIncremental({ session: { id: 'old-session' as never, source: 'codex', startedAt: '2026-09-29T10:00:00.000Z', repositoryId: 'repo-1' as never } });
    } finally { store.close(); }
    assert.equal(new OperationalLearningService(databasePath).enqueueCommittedSession('repo-1', 'old-session'), true);
    writeFileSync(join(project, 'AGENTS.md'), 'For mobile app, use uv rather than pip.\n');
    const secondStore = new ExperienceStore(databasePath);
    try { secondStore.appendIncremental({ session: { id: 'new-session' as never, source: 'codex', startedAt: '2026-09-29T11:00:00.000Z', repositoryId: 'repo-1' as never } }); }
    finally { secondStore.close(); }
    const restarted = new OperationalLearningService(databasePath);
    assert.equal(restarted.enqueueCommittedSession('repo-1', 'old-session'), false);
    assert.equal(restarted.enqueueCommittedSession('repo-1', 'new-session'), true);
    const repository = new OperationalLearningRepository(databasePath);
    try {
      const old = repository.contextSnapshotFor('repo-1', 'old-session');
      const current = repository.contextSnapshotFor('repo-1', 'new-session');
      const scoped = (snapshot: unknown): readonly { tool: string; scopePath: string }[] | undefined =>
        (snapshot as { scopedConventions?: readonly { tool: string; scopePath: string }[] } | undefined)?.scopedConventions;
      assert.deepEqual(scoped(old)?.map(({ tool, scopePath }) => ({ tool, scopePath })), [{ tool: 'pnpm', scopePath: 'apps/mobile' }]);
      assert.deepEqual(scoped(current)?.map(({ tool, scopePath }) => ({ tool, scopePath })), [{ tool: 'uv', scopePath: 'apps/mobile' }]);
      const oldInstruction = old?.instructions.find(({ location }) => location === 'AGENTS.md');
      const currentInstruction = current?.instructions.find(({ location }) => location === 'AGENTS.md');
      assert.notEqual(oldInstruction?.digest, currentInstruction?.digest);
      assert.equal(oldInstruction?.found, true);
      assert.equal(oldInstruction?.delivered, 'unknown');
      assert.equal(oldInstruction?.explicitlyRead, 'unknown');
      assert.deepEqual(old?.conventions, []);
      assert.deepEqual(current?.conventions, []);
    } finally { repository.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ASC-A4 refuses current instructions for a legacy operation without retained historical context', () => {
  const root = mkdtempSync(join(tmpdir(), 'asc-reanalysis-'));
  const project = join(root, 'project'); const databasePath = join(root, 'experience.sqlite');
  try {
    mkdirSync(project); initializeGitRepository(project);
    const store = new ExperienceStore(databasePath);
    try {
      store.registerRepository({ id: 'repo-1', root: project, observedAt: '2026-09-29T10:00:00.000Z' });
      store.appendIncremental({ session: { id: 'legacy-session' as never, source: 'codex', startedAt: '2026-09-29T10:00:00.000Z', repositoryId: 'repo-1' as never } });
    } finally { store.close(); }
    const repository = new OperationalLearningRepository(databasePath);
    try { repository.enqueue({ repositoryId: 'repo-1', sessionId: 'legacy-session', inputHighWater: 0 }); }
    finally { repository.close(); }
    writeFileSync(join(project, 'AGENTS.md'), 'Use pnpm (never npm).\n');
    assert.equal(new OperationalLearningService(databasePath).runNext().status, 'completed');
    const reopened = new OperationalLearningRepository(databasePath);
    try {
      assert.equal(reopened.contextSnapshotFor('repo-1', 'legacy-session'), undefined);
      assert.deepEqual(reopened.report('repo-1').candidates, []);
      assert.equal(reopened.report('repo-1').historicalInstructionGaps, 1);
    } finally { reopened.close(); }
    assert.match(DETECTOR_SET_VERSION, /asc-parser@2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ASC-A5 bounds instruction reads and rejects symlinked ancestor paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'asc-bounded-'));
  const outside = mkdtempSync(join(tmpdir(), 'asc-external-'));
  try {
    writeFileSync(join(outside, 'AGENTS.md'), 'Use pnpm (never npm).\n');
    symlinkSync(outside, join(root, '.agents'));
    let context = readProjectInstructionContext(root);
    assert.equal(context.instructions.find(({ location }) => location === '.agents/AGENTS.md')?.found, false);
    assert.deepEqual(context.conventions, []);
    writeFileSync(join(root, 'AGENTS.md'), `${'x'.repeat(128 * 1024)}\nUse uv rather than pip.\n`);
    context = readProjectInstructionContext(root);
    assert.equal(context.instructions.find(({ location }) => location === 'AGENTS.md')?.found, false);
    assert.deepEqual(context.conventions, []);
    writeFileSync(join(root, 'AGENTS.md'), 'Use uv rather than pip.\n');
    context = readProjectInstructionContext(root);
    assert.deepEqual(context.conventions.map(({ tool }) => tool), ['uv']);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
