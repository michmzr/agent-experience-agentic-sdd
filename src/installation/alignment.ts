import { acquireAlignmentLock } from './alignment-lock.js';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { configurationPath, mergeHookConfiguration, renderManagedWrapper, type HookSource } from '../cli/hook-installation.js';
import { resolveRepositoryRoot } from '../repository/local-repository.js';
import { parseManagedWrapper, resolveManagedTarget } from './inspection.js';
import { defaultDatabasePath } from '../storage/database.js';
import { assertWriterCompatible } from './writer-contract.js';
import { readBuildManifest, sha256, verifyBuild } from './build-manifest.js';

export interface AlignmentFile {
  readonly path: string; readonly before: string | null; readonly after: string;
  readonly beforeHash: string | null; readonly afterHash: string;
  readonly beforeMode: number | null; readonly mode: number;
}
export interface AlignmentPlan {
  readonly schemaVersion: 1; readonly planId: string; readonly repositoryRoot: string; readonly repositoryId: string;
  readonly manifestPath: string; readonly manifestHash: string; readonly buildId: string;
  readonly sources: readonly HookSource[]; readonly requiredEvents: readonly string[]; readonly files: readonly AlignmentFile[];
}
const requiredEvents = ['startup', 'resume', 'pre-action', 'post-result', 'end'];
const ownedPaths = ['.agents/hooks/ael-passive-capture.sh', '.codex/hooks.json', '.cursor/hooks.json'];
function noSymlinks(root: string, path: string): void {
  if (!isAbsolute(root) || path.includes('\\') || isAbsolute(path) || path.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Invalid managed boundary.');
  let current = '/';
  // Ancestors of the boundary and every managed component must be real directories/files.
  for (const part of resolve(root).split('/').filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Managed boundary is a symlink.');
  }
  current = root;
  for (const part of path.split('/')) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Managed path is a symlink.'); }
}
function fileState(root: string, path: string): { content: string | null; hash: string | null; mode: number | null } {
  noSymlinks(root, path);
  const target = join(root, path);
  if (!existsSync(target)) return { content: null, hash: null, mode: null };
  if (!statSync(target).isFile()) throw new Error('Managed target is not a regular file.');
  const content = readFileSync(target, 'utf8');
  return { content, hash: sha256(content), mode: statSync(target).mode & 0o777 };
}
function planDigest(plan: Omit<AlignmentPlan, 'planId'>): string { return sha256(JSON.stringify(plan)); }
export function createAlignmentPlan(root: string, manifestPath: string): AlignmentPlan {
  const repository = resolveRepositoryRoot(root);
  if (!repository) throw new Error('Repository root required.');
  root = repository.root;
  const targetRoot = dirname(resolve(manifestPath));
  const manifest = readBuildManifest(targetRoot);
  verifyBuild(targetRoot, manifest);
  assertWriterCompatible([defaultDatabasePath(), join(dirname(defaultDatabasePath()), 'capture-spool.sqlite')], manifest);
  const wrapper = resolveManagedTarget(root);
  if (!['current', 'missing'].includes(wrapper.state)) throw new Error('Unrecognized wrapper requires explicit migration.');
  const sources: HookSource[] = (['codex', 'cursor'] as const).filter(source => existsSync(configurationPath(root, source)));
  if (!sources.length) sources.push('codex');
  const files: AlignmentFile[] = [];
  const add = (path: string, after: string, mode: number): void => {
    const before = fileState(root, path);
    files.push({ path, before: before.content, beforeHash: before.hash, beforeMode: before.mode, after, afterHash: sha256(after), mode });
  };
  add(ownedPaths[0], renderManagedWrapper(join(targetRoot, 'dist/src/cli.js'), repository.id), 0o755);
  for (const source of sources) {
    const path = relative(root, configurationPath(root, source));
    const previous = fileState(root, path).content;
    const config = previous === null ? {} : JSON.parse(previous);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid hook configuration.');
    add(path, JSON.stringify(mergeHookConfiguration(config, source, root), null, 2) + '\n', 0o644);
  }
  const body: Omit<AlignmentPlan, 'planId'> = { schemaVersion: 1, repositoryRoot: root, repositoryId: repository.id,
    manifestPath: resolve(manifestPath), manifestHash: sha256(readFileSync(manifestPath)), buildId: manifest.buildId, sources, requiredEvents, files };
  return { ...body, planId: planDigest(body) };
}
export function validateAlignmentPlan(value: unknown): AlignmentPlan {
  const plan = value as AlignmentPlan;
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.files) || !Array.isArray(plan.sources) || plan.sources.some(s => s !== 'codex' && s !== 'cursor') || new Set(plan.sources).size !== plan.sources.length || !plan.sources.length) throw new Error('Invalid alignment plan.');
  const { planId, ...body } = plan;
  if (planDigest(body) !== planId) throw new Error('Alignment plan digest mismatch.');
  const repository = resolveRepositoryRoot(plan.repositoryRoot);
  if (!repository || repository.root !== plan.repositoryRoot || repository.id !== plan.repositoryId) throw new Error('Changed repository boundary.');
  noSymlinks(plan.repositoryRoot, '.agents/ael-installation/journal.json');
  if (JSON.stringify(plan.requiredEvents) !== JSON.stringify(requiredEvents)) throw new Error('Invalid event contract.');
  const expectedPaths = [ownedPaths[0], ...plan.sources.map(source => source === 'codex' ? ownedPaths[1] : ownedPaths[2])];
  if (JSON.stringify(plan.files.map(f => f.path)) !== JSON.stringify(expectedPaths)) throw new Error('Invalid owned paths.');
  if (sha256(readFileSync(plan.manifestPath)) !== plan.manifestHash) throw new Error('Target manifest changed.');
  const targetRoot = dirname(plan.manifestPath);
  const manifest = readBuildManifest(targetRoot);
  if (manifest.buildId !== plan.buildId) throw new Error('Changed build identity.');
  verifyBuild(targetRoot, manifest);
  assertWriterCompatible([defaultDatabasePath(), join(dirname(defaultDatabasePath()), 'capture-spool.sqlite')], manifest);
  for (const file of plan.files) {
    fileState(plan.repositoryRoot, file.path);
    if ((file.before === null ? null : sha256(file.before)) !== file.beforeHash || sha256(file.after) !== file.afterHash || (file.before === null) !== (file.beforeMode === null)) throw new Error('Invalid plan file hash.');
    const source = file.path === '.codex/hooks.json' ? 'codex' : 'cursor';
    const expected = file.path === ownedPaths[0] ? renderManagedWrapper(join(targetRoot, 'dist/src/cli.js'), plan.repositoryId)
      : JSON.stringify(mergeHookConfiguration(file.before === null ? {} : JSON.parse(file.before), source, plan.repositoryRoot), null, 2) + '\n';
    if (file.after !== expected || file.mode !== (file.path === ownedPaths[0] ? 0o755 : 0o644) || (file.beforeMode !== null && (!Number.isSafeInteger(file.beforeMode) || file.beforeMode < 0 || file.beforeMode > 0o777))) throw new Error('Plan contains unmanaged mutation.');
  }
  return plan;
}
function publish(path: string, content: string, mode: number, suffix: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${suffix}.${randomUUID()}.tmp`;
  try { if (lstatSync(temporary).isSymbolicLink()) throw new Error('Staging path is a symlink.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  writeFileSync(temporary, content, { mode, flag: 'wx' }); chmodSync(temporary, mode); renameSync(temporary, path);
}
function assertPreviousWriter(plan: AlignmentPlan): void {
  const oldWrapper = plan.files[0].before;
  if (oldWrapper === null) return;
  const previous = parseManagedWrapper(plan.repositoryRoot, oldWrapper);
  if (!previous.target) throw new Error('Rollback target is unknown.');
  const previousRoot = resolve(dirname(previous.target), '../..');
  const previousManifest = readBuildManifest(previousRoot);
  verifyBuild(previousRoot, previousManifest);
  assertWriterCompatible([defaultDatabasePath(), join(dirname(defaultDatabasePath()), 'capture-spool.sqlite')], previousManifest);
}
function restore(plan: AlignmentPlan, files: readonly AlignmentFile[] = plan.files): void {
  if (files.some(file => file.path === ownedPaths[0])) assertPreviousWriter(plan);
  for (const file of files) {
    noSymlinks(plan.repositoryRoot, file.path);
    const path = join(plan.repositoryRoot, file.path);
    if (file.before === null) rmSync(path, { force: true });
    else publish(path, file.before, file.beforeMode!, plan.planId);
  }
}
function stateMatches(plan: AlignmentPlan, direction: 'before' | 'after'): boolean {
  return plan.files.every(file => {
    const actual = fileState(plan.repositoryRoot, file.path);
    return actual.hash === (direction === 'before' ? file.beforeHash : file.afterHash) && actual.mode === (direction === 'before' ? file.beforeMode : file.mode);
  });
}
export function applyAlignmentPlan(input: AlignmentPlan, options: { afterPublication?: (count: number) => void; afterLockAcquired?: () => void; rollback?: boolean } = {}) {
  const plan = validateAlignmentPlan(input);
  // Validate rollback safety before publication, including recovery of stopped publishers.
  assertPreviousWriter(plan);
  const directory = join(plan.repositoryRoot, '.agents/ael-installation');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  noSymlinks(plan.repositoryRoot, '.agents/ael-installation/lock.sqlite');
  noSymlinks(plan.repositoryRoot, '.agents/ael-installation/lock/owner.json');
  const journalPath = join(directory, `${plan.planId}.json`);
  noSymlinks(plan.repositoryRoot, `.agents/ael-installation/${plan.planId}.json`);
  const releaseLock = acquireAlignmentLock(directory);
  try {
    options.afterLockAcquired?.();
    if (existsSync(journalPath)) {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (JSON.stringify(journal.plan) !== JSON.stringify(plan) || journal.planId !== plan.planId || !['publishing', 'applied', 'rolled-back'].includes(journal.state)) throw new Error('Invalid alignment journal.');
      if (journal.state === 'publishing') {
        if (!plan.files.every(f => { const s = fileState(plan.repositoryRoot, f.path); return (s.hash === f.beforeHash && s.mode === f.beforeMode) || (s.hash === f.afterHash && s.mode === f.mode); })) throw new Error('Interrupted generation was edited.');
        restore(plan);
      }
    }
    if (options.rollback) {
      if (stateMatches(plan, 'before')) return { status: 'rolled-back', planId: plan.planId };
      if (!stateMatches(plan, 'after') || !existsSync(journalPath)) throw new Error('Rollback generation changed or missing.');
      restore(plan);
      publish(journalPath, JSON.stringify({ planId: plan.planId, state: 'rolled-back', plan }), 0o600, plan.planId);
      return { status: 'rolled-back', planId: plan.planId };
    }
    if (stateMatches(plan, 'after')) return { status: 'applied', planId: plan.planId, buildId: plan.buildId };
    if (!stateMatches(plan, 'before')) throw new Error('Files changed after planning.');
    publish(journalPath, JSON.stringify({ planId: plan.planId, state: 'publishing', plan }), 0o600, plan.planId);
    const published: AlignmentFile[] = [];
    try {
      for (const [index, file] of plan.files.entries()) {
        const current = fileState(plan.repositoryRoot, file.path);
        if (current.hash !== file.beforeHash || current.mode !== file.beforeMode) throw new Error('Managed file changed during publication.');
        publish(join(plan.repositoryRoot, file.path), file.after, file.mode, plan.planId);
        published.push(file);
        options.afterPublication?.(index + 1);
      }
      publish(journalPath, JSON.stringify({ planId: plan.planId, state: 'applied', plan }), 0o600, plan.planId);
    } catch (error) {
      if (!published.every(file => { const current = fileState(plan.repositoryRoot, file.path); return current.hash === file.afterHash && current.mode === file.mode; })) throw new Error('Published generation was edited; automatic restoration refused.');
      restore(plan, published);
      publish(journalPath, JSON.stringify({ planId: plan.planId, state: 'rolled-back', plan }), 0o600, plan.planId);
      throw error;
    }
    return { status: 'applied', planId: plan.planId, buildId: plan.buildId };
  } finally { releaseLock(); }
}
