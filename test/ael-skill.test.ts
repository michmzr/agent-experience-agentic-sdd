import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectAelSkill, installAelSkill, uninstallAelSkill, updateAelSkill, validateAelSkill } from '../src/skill/ael-skill.js';
import { runCli } from '../src/cli.js';

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

test('validates, installs, updates, and protects managed AEL skills', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-skill-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const source = join(root, 'source');
  const updatedSource = join(root, 'updated-source');
  try {
    mkdirSync(workspace); mkdirSync(home);
    cpSync(skillDirectory, source, { recursive: true });
    cpSync(skillDirectory, updatedSource, { recursive: true });
    writeFileSync(join(updatedSource, 'references', 'diagnostics.md'), `${readFileSync(join(updatedSource, 'references', 'diagnostics.md'), 'utf8')}\nUpdated documentation.\n`);

    assert.equal(validateAelSkill(source).status, 'valid');
    assert.equal(installAelSkill({ source, scope: 'workspace', workspace, home }).status, 'installed');
    assert.equal(inspectAelSkill({ source, scope: 'workspace', workspace, home }).status, 'current');
    assert.equal(installAelSkill({ source, scope: 'workspace', workspace, home }).status, 'unchanged');
    assert.equal(installAelSkill({ source, scope: 'global', workspace, home, confirmed: false }).status, 'confirmation-required');
    assert.equal(updateAelSkill({ source: updatedSource, scope: 'workspace', workspace, home }).status, 'updated');
    assert.match(readFileSync(join(workspace, '.agents', 'skills', 'ael', 'references', 'diagnostics.md'), 'utf8'), /Updated documentation/);

    writeFileSync(join(workspace, '.agents', 'skills', 'ael', 'SKILL.md'), 'modified');
    assert.equal(inspectAelSkill({ source: updatedSource, scope: 'workspace', workspace, home }).status, 'invalid');
    assert.throws(() => updateAelSkill({ source: updatedSource, scope: 'workspace', workspace, home }), /AEL_SKILL_DESTINATION_UNSAFE/);
    assert.throws(() => uninstallAelSkill({ scope: 'workspace', workspace, home }), /AEL_SKILL_DESTINATION_UNSAFE/);
    assert.equal(existsSync(join(workspace, '.agents', 'skills', 'ael', 'SKILL.md')), true);

    const unmanagedWorkspace = join(root, 'unmanaged-workspace');
    mkdirSync(join(unmanagedWorkspace, '.agents', 'skills', 'ael'), { recursive: true });
    writeFileSync(join(unmanagedWorkspace, '.agents', 'skills', 'ael', 'notes.txt'), 'retain');
    assert.throws(() => installAelSkill({ source, scope: 'workspace', workspace: unmanagedWorkspace, home }), /AEL_SKILL_DESTINATION_UNSAFE/);
    assert.equal(readFileSync(join(unmanagedWorkspace, '.agents', 'skills', 'ael', 'notes.txt'), 'utf8'), 'retain');

    const symlinkSource = join(root, 'symlink-source');
    cpSync(skillDirectory, symlinkSource, { recursive: true });
    rmSync(join(symlinkSource, 'references', 'diagnostics.md'));
    symlinkSync(join(symlinkSource, 'SKILL.md'), join(symlinkSource, 'references', 'diagnostics.md'));
    assert.equal(validateAelSkill(symlinkSource).status, 'invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exposes a scoped skill CLI with explicit global confirmation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-skill-cli-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  try {
    mkdirSync(workspace); mkdirSync(home);
    const options = { workingDirectory: workspace, homeDirectory: home, skillSourceDirectory: skillDirectory };
    const installed = runCli(['skill', 'install', '--scope', 'workspace', '--json'], options);
    assert.equal(installed.exitCode, 0);
    assert.deepEqual(JSON.parse(installed.stdout).status, 'installed');
    assert.equal(existsSync(join(workspace, '.agents', 'skills', 'ael', 'SKILL.md')), true);
    assert.deepEqual(JSON.parse(runCli(['skill', 'status', '--scope', 'workspace', '--json'], options).stdout).status, 'current');
    assert.deepEqual(JSON.parse(runCli(['skill', 'update', '--scope', 'workspace', '--json'], options).stdout).status, 'unchanged');
    assert.deepEqual(JSON.parse(runCli(['skill', 'uninstall', '--scope', 'workspace', '--json'], options).stdout).status, 'removed');
    assert.deepEqual(JSON.parse(runCli(['skill', 'validate', skillDirectory, '--json'], options).stdout).status, 'valid');

    const globalWithoutConfirmation = runCli(['skill', 'install', '--scope', 'global', '--json'], options);
    assert.equal(globalWithoutConfirmation.exitCode, 2);
    assert.match(globalWithoutConfirmation.stdout, /Global skill mutations require --yes/);
    assert.equal(existsSync(join(home, '.agents', 'skills', 'ael')), false);
    assert.equal(runCli(['skill', 'install', '--scope', 'workspace', '--yes', '--json'], options).exitCode, 2);
    assert.equal(runCli(['skill', 'status', '--scope', 'invalid', '--json'], options).exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
