import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import {
  MAX_RUNTIME_SNAPSHOT_BYTES, parseSerializedRuntimeSnapshot, serializeRuntimeSnapshot,
  type RuntimeSnapshotV1
} from '../runtime/snapshot.js';

export class RuntimeSnapshotStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RuntimeSnapshotStorageError'; }
}

export class RuntimeSnapshotConflictError extends RuntimeSnapshotStorageError {
  constructor(message: string) { super(message); this.name = 'RuntimeSnapshotConflictError'; }
}

export class RuntimeSnapshotCleanupError extends RuntimeSnapshotStorageError {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RuntimeSnapshotCleanupError'; }
}

export type RuntimeSnapshotStoreStep =
  | 'after-generation-write'
  | 'after-generation-reopen'
  | 'before-generation-rename'
  | 'before-generation-directory-sync'
  | 'after-manifest-write'
  | 'after-manifest-reopen'
  | 'before-manifest-cas'
  | 'before-manifest-rename'
  | 'before-commit-directory-sync'
  | 'cleanup';

export interface RuntimeSnapshotStoreOptions {
  readonly clock: () => number;
  readonly wait?: (milliseconds: number) => void;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly injectFailure?: (step: RuntimeSnapshotStoreStep) => void;
  readonly afterLockAcquired?: () => void;
  readonly onLockWait?: () => void;
}
export interface RuntimeSnapshotPaths { readonly root: string; readonly manifest: string; readonly rollbackManifest: string }
interface ManifestReference { readonly checksum: string; readonly file: string }
interface RuntimeSnapshotManifestV1 { readonly version: 1; readonly current: ManifestReference; readonly lastKnownGood?: ManifestReference }

const checksumPattern = /^[a-f0-9]{64}$/;
const generationPattern = /^generation-([a-f0-9]{64})\.json$/;
const MAX_MANIFEST_BYTES = 16 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

export class RuntimeSnapshotStore {
  readonly paths: RuntimeSnapshotPaths;
  readonly #injectFailure: (step: RuntimeSnapshotStoreStep) => void;
  readonly #clock: () => number;
  readonly #wait: (milliseconds: number) => void;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #afterLockAcquired: () => void;
  readonly #onLockWait: () => void;

  constructor(stateDirectory: string, options: RuntimeSnapshotStoreOptions) {
    if (typeof options?.clock !== 'function') throw new TypeError('Runtime snapshot store requires an injected clock.');
    const root = canonicalStateRoot(stateDirectory);
    assertNoCallerSymlink(root);
    if (!basename(root) || relative(root, root) !== '') throw new RuntimeSnapshotStorageError('Invalid runtime snapshot state path.');
    this.paths = Object.freeze({ root, manifest: resolve(root, 'manifest.json'), rollbackManifest: resolve(root, 'rollback-manifest.json') });
    if (dirname(this.paths.manifest) !== root) throw new RuntimeSnapshotStorageError('Runtime snapshot manifest escapes private state.');
    this.#injectFailure = options.injectFailure ?? (() => undefined);
    this.#clock = options.clock;
    this.#wait = options.wait ?? blockingWait;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.#afterLockAcquired = options.afterLockAcquired ?? (() => undefined);
    this.#onLockWait = options.onLockWait ?? (() => undefined);
  }

  generationPath(checksum: string): string {
    if (!checksumPattern.test(checksum)) throw new RuntimeSnapshotStorageError('Invalid runtime snapshot generation checksum.');
    return resolve(this.paths.root, `generation-${checksum}.json`);
  }

  publish(snapshot: RuntimeSnapshotV1): RuntimeSnapshotV1 { return this.publishSerialized(serializeRuntimeSnapshot(snapshot)); }
  rebuild(compiler: () => RuntimeSnapshotV1): RuntimeSnapshotV1 { return this.publish(compiler()); }

  publishSerialized(serialized: string): RuntimeSnapshotV1 {
    const expected = parseSerializedRuntimeSnapshot(serialized);
    this.#ensurePrivateDirectory();
    return this.#withWriterLock(() => this.#publishLocked(serialized, expected));
  }

  #publishLocked(serialized: string, expected: RuntimeSnapshotV1): RuntimeSnapshotV1 {
    const priorManifest = this.#readOptionalManifest();
    if (priorManifest !== undefined) {
      this.#readSnapshotFile(resolveReference(this.paths.root, priorManifest.current), priorManifest.current.checksum);
    }
    const priorSerialized = priorManifest === undefined ? undefined : serializeManifest(priorManifest);
    const priorFingerprint = this.#manifestFingerprint();
    const generation = this.generationPath(expected.checksum);
    const generationCandidate = this.#candidate('generation');
    const manifestCandidate = this.#candidate('manifest');
    const rollbackPreparation = this.#candidate('rollback');
    let reopened: RuntimeSnapshotV1;
    let committedManifest: RuntimeSnapshotManifestV1;

    try {
      this.#writeFsyncedCandidate(generationCandidate, serialized, MAX_RUNTIME_SNAPSHOT_BYTES, 'after-generation-write');
      reopened = this.#readSnapshotFile(generationCandidate, expected.checksum);
      this.#injectFailure('after-generation-reopen');
      this.#injectFailure('before-generation-rename');
      this.#installImmutableGeneration(generationCandidate, generation, expected.checksum);
      this.#injectFailure('before-generation-directory-sync');
      this.#syncDirectory();

      committedManifest = Object.freeze({
        version: 1,
        current: reference(expected.checksum),
        ...(priorManifest === undefined ? {} : { lastKnownGood: priorManifest.current })
      });
      const nextSerialized = serializeManifest(committedManifest);
      this.#writeFsyncedCandidate(manifestCandidate, nextSerialized, MAX_MANIFEST_BYTES, 'after-manifest-write');
      this.#readManifestFile(manifestCandidate);
      this.#injectFailure('after-manifest-reopen');
      if (priorSerialized !== undefined) {
        this.#writeFsyncedCandidate(rollbackPreparation, priorSerialized, MAX_MANIFEST_BYTES);
        this.#readManifestFile(rollbackPreparation);
        this.#assertSafeTarget(this.paths.rollbackManifest, MAX_MANIFEST_BYTES, true);
        renameSync(rollbackPreparation, this.paths.rollbackManifest);
        this.#syncDirectory();
      }

      this.#assertSafeTarget(this.paths.manifest, MAX_MANIFEST_BYTES, true);
      this.#injectFailure('before-manifest-cas');
      if (this.#manifestFingerprint() !== priorFingerprint) {
        throw new RuntimeSnapshotConflictError('Runtime snapshot manifest changed during locked publication.');
      }
      this.#injectFailure('before-manifest-rename');
      renameSync(manifestCandidate, this.paths.manifest);
      try {
        this.#injectFailure('before-commit-directory-sync');
        this.#syncDirectory();
      } catch (error) {
        this.#restoreManifest(priorSerialized !== undefined);
        throw error;
      }
    } catch (error) {
      this.#removeCandidate(generationCandidate);
      this.#removeCandidate(manifestCandidate);
      this.#removeCandidate(rollbackPreparation);
      if (error instanceof RuntimeSnapshotStorageError) throw error;
      throw new RuntimeSnapshotStorageError('Runtime snapshot publication failed.', { cause: error });
    }
    this.#cleanupAfterCommit(committedManifest);
    return reopened;
  }

  loadCurrent(): RuntimeSnapshotV1 {
    const manifest = this.#readManifest();
    return this.#readSnapshotFile(resolveReference(this.paths.root, manifest.current), manifest.current.checksum);
  }

  loadLastKnownGood(): RuntimeSnapshotV1 {
    const lastKnownGood = this.#readManifest().lastKnownGood;
    if (lastKnownGood === undefined) throw new RuntimeSnapshotStorageError('No last-known-good runtime snapshot is available.');
    return this.#readSnapshotFile(resolveReference(this.paths.root, lastKnownGood), lastKnownGood.checksum);
  }

  #installImmutableGeneration(candidate: string, generation: string, checksum: string): void {
    try {
      this.#assertSafeTarget(generation, MAX_RUNTIME_SNAPSHOT_BYTES);
      this.#readSnapshotFile(generation, checksum);
      this.#removeCandidate(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      renameSync(candidate, generation);
    }
  }

  #restoreManifest(hadPriorManifest: boolean): void {
    if (hadPriorManifest) renameSync(this.paths.rollbackManifest, this.paths.manifest);
    else this.#removeCandidate(this.paths.manifest);
    this.#syncDirectory();
  }

  #cleanupAfterCommit(manifest: RuntimeSnapshotManifestV1): void {
    try {
      this.#injectFailure('cleanup');
      const retained = new Set([manifest.current.file, manifest.lastKnownGood?.file].filter((file): file is string => file !== undefined));
      const rollback = this.#readOptionalRollbackManifest();
      if (rollback !== undefined) {
        retained.add(rollback.current.file);
        if (rollback.lastKnownGood !== undefined) retained.add(rollback.lastKnownGood.file);
      }
      for (const name of readdirSync(this.paths.root)) {
        if (generationPattern.test(name) && !retained.has(name)) this.#removeCandidate(resolve(this.paths.root, name));
      }
      this.#syncDirectory();
    } catch (error) {
      if (error instanceof RuntimeSnapshotCleanupError || isExpectedCleanupFilesystemError(error)) return;
      throw error;
    }
  }

  #readOptionalRollbackManifest(): RuntimeSnapshotManifestV1 | undefined {
    try { return this.#readManifestFile(this.paths.rollbackManifest); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  #manifestFingerprint(): string {
    try {
      const serialized = this.#readOwnerFile(this.paths.manifest, MAX_MANIFEST_BYTES);
      return createHash('sha256').update(serialized, 'utf8').digest('hex');
    } catch (error) {
      if (isMissing(error)) return 'absent';
      throw error;
    }
  }

  #readOptionalManifest(): RuntimeSnapshotManifestV1 | undefined {
    try { return this.#readManifest(); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  #readManifest(): RuntimeSnapshotManifestV1 {
    this.#ensurePrivateDirectory();
    return this.#readManifestFile(this.paths.manifest);
  }

  #readManifestFile(path: string): RuntimeSnapshotManifestV1 {
    const serialized = this.#readOwnerFile(path, MAX_MANIFEST_BYTES);
    let value: unknown;
    try { value = JSON.parse(serialized) as unknown; } catch { throw new RuntimeSnapshotStorageError('Runtime snapshot manifest is not valid JSON.'); }
    return parseManifest(value);
  }

  #readSnapshotFile(path: string, expectedChecksum: string): RuntimeSnapshotV1 {
    const snapshot = parseSerializedRuntimeSnapshot(this.#readOwnerFile(path, MAX_RUNTIME_SNAPSHOT_BYTES));
    if (snapshot.checksum !== expectedChecksum) throw new RuntimeSnapshotStorageError('Runtime snapshot generation checksum does not match its manifest reference.');
    return snapshot;
  }

  #readOwnerFile(path: string, maxBytes: number): string {
    let descriptor: number | undefined;
    try {
      this.#assertSafeTarget(path, maxBytes);
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > maxBytes) throw new RuntimeSnapshotStorageError('Runtime snapshot file exceeds its resource boundary.');
      return readFileSync(descriptor, 'utf8');
    } catch (error) {
      if (error instanceof RuntimeSnapshotStorageError) throw error;
      throw new RuntimeSnapshotStorageError(`Unable to read runtime snapshot file ${basename(path)}.`, { cause: error });
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  #writeFsyncedCandidate(path: string, serialized: string, maxBytes: number, afterWrite?: RuntimeSnapshotStoreStep): void {
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new RuntimeSnapshotStorageError('Runtime snapshot candidate exceeds its resource boundary.');
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, serialized, 'utf8');
      fchmodSync(descriptor, 0o600);
      if (afterWrite !== undefined) this.#injectFailure(afterWrite);
      fsyncSync(descriptor);
      if (fstatSync(descriptor).dev !== statSync(this.paths.root).dev) throw new RuntimeSnapshotStorageError('Runtime snapshot staging crossed filesystems.');
    } finally { closeSync(descriptor); }
  }

  #ensurePrivateDirectory(): void {
    assertNoCallerSymlink(this.paths.root);
    mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.paths.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeSnapshotStorageError('Runtime snapshot state directory is unsafe.');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new RuntimeSnapshotStorageError('Runtime snapshot state directory has a different owner.');
    if ((stat.mode & 0o077) !== 0) throw new RuntimeSnapshotStorageError('Runtime snapshot state directory must be owner-only.');
  }

  #assertSafeTarget(path: string, maxBytes: number, allowMissing = false): void {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new RuntimeSnapshotStorageError('Runtime snapshot target is unsafe.');
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new RuntimeSnapshotStorageError('Runtime snapshot target has a different owner.');
      if ((stat.mode & 0o077) !== 0) throw new RuntimeSnapshotStorageError('Runtime snapshot target must be owner-only.');
      if (stat.size > maxBytes) throw new RuntimeSnapshotStorageError('Runtime snapshot target exceeds its resource boundary.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RuntimeSnapshotStorageError('Runtime snapshot target does not exist.', { cause: error });
      throw error;
    }
  }

  #withWriterLock<T>(action: () => T): T {
    const lock = resolve(this.paths.root, '.writer-lock');
    const token = randomUUID();
    const started = this.#clock();
    while (true) {
      cleanupAbandonedLockCandidates(this.paths.root, this.#clock(), this.#staleLockMs);
      const candidate = resolve(this.paths.root, `.writer-lock-candidate-${token}-${randomUUID()}`);
      try {
        mkdirSync(candidate, { mode: 0o700 });
        const owner = resolve(candidate, 'owner.json');
        writeFileSync(owner, JSON.stringify({ pid: process.pid, timestamp: this.#clock(), token }), { mode: 0o600, flag: 'wx' });
        fsyncFile(owner);
        fsyncDirectory(candidate);
        if (existsSync(lock)) throw occupiedLockError();
        renameSync(candidate, lock);
        this.#syncDirectory();
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
        recoverStaleWriterLock(lock, this.#clock(), this.#staleLockMs);
        if (this.#clock() - started >= this.#lockTimeoutMs) throw new RuntimeSnapshotStorageError('Timed out waiting for runtime snapshot writer lock.');
        this.#onLockWait();
        this.#wait(Math.min(25, this.#lockTimeoutMs));
      } finally {
        if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
      }
    }
    try {
      this.#afterLockAcquired();
      return action();
    }
    finally {
      try {
        const owner = JSON.parse(readFileSync(resolve(lock, 'owner.json'), 'utf8')) as { token?: string };
        if (owner.token === token) {
          rmSync(lock, { recursive: true, force: true });
          this.#syncDirectory();
        }
      } catch { /* Never remove a lock whose ownership cannot be verified. */ }
    }
  }

  #syncDirectory(): void {
    const descriptor = openSync(this.paths.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }

  #candidate(kind: string): string { return resolve(this.paths.root, `.${kind}-${randomUUID()}.tmp`); }
  #removeCandidate(path: string): void { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}

function occupiedLockError(): NodeJS.ErrnoException {
  const error = new Error('Runtime snapshot writer lock is occupied.') as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  return error;
}

function recoverStaleWriterLock(lock: string, now: number, staleAfter: number): void {
  try {
    const owner = JSON.parse(readFileSync(resolve(lock, 'owner.json'), 'utf8')) as { pid?: number; timestamp?: number; token?: string };
    if (typeof owner.pid !== 'number' || typeof owner.timestamp !== 'number' || typeof owner.token !== 'string') return;
    if (now - owner.timestamp <= staleAfter || isPidAlive(owner.pid)) return;
    const confirmed = JSON.parse(readFileSync(resolve(lock, 'owner.json'), 'utf8')) as { pid?: number; timestamp?: number; token?: string };
    if (confirmed.pid !== owner.pid || confirmed.timestamp !== owner.timestamp || confirmed.token !== owner.token || isPidAlive(owner.pid)) return;
    const stale = `${lock}.stale-${owner.token}`;
    renameSync(lock, stale);
    rmSync(stale, { recursive: true, force: true });
  } catch { /* A malformed, live, or concurrently changing lock remains untouched. */ }
}

function cleanupAbandonedLockCandidates(root: string, now: number, staleAfter: number): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.writer-lock-candidate-')) continue;
    const candidate = resolve(root, entry.name);
    try {
      const observed = statSync(candidate);
      if (now - observed.mtimeMs <= staleAfter) continue;
      const confirmed = statSync(candidate);
      if (confirmed.dev !== observed.dev || confirmed.ino !== observed.ino || confirmed.mtimeMs !== observed.mtimeMs) continue;
      rmSync(candidate, { recursive: true, force: true });
    } catch { /* A concurrently changing lock candidate remains untouched. */ }
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function blockingWait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, milliseconds));
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function canonicalStateRoot(path: string): string {
  let root = resolve(path);
  for (const trustedAlias of ['/var', '/tmp']) {
    if (root !== trustedAlias && !root.startsWith(`${trustedAlias}/`)) continue;
    try { root = join(realpathSync(trustedAlias), root.slice(trustedAlias.length)); } catch { /* Optional platform alias. */ }
    break;
  }
  return root;
}

function assertNoCallerSymlink(root: string): void {
  const components = root.split('/').filter(Boolean);
  let current = '/';
  for (const component of components) {
    current = resolve(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new RuntimeSnapshotStorageError('Runtime snapshot state path contains a symlink.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function reference(checksum: string): ManifestReference { return Object.freeze({ checksum, file: `generation-${checksum}.json` }); }
function resolveReference(root: string, entry: ManifestReference): string {
  const path = resolve(root, entry.file);
  if (dirname(path) !== root) throw new RuntimeSnapshotStorageError('Runtime snapshot manifest reference escapes private state.');
  return path;
}
function serializeManifest(manifest: RuntimeSnapshotManifestV1): string { return `${JSON.stringify(manifest, null, 2)}\n`; }
function parseManifest(value: unknown): RuntimeSnapshotManifestV1 {
  if (!isRecord(value) || !onlyKeys(value, ['current', 'lastKnownGood', 'version']) || value.version !== 1) throw new RuntimeSnapshotStorageError('Invalid runtime snapshot manifest.');
  const current = parseReference(value.current);
  const lastKnownGood = value.lastKnownGood === undefined ? undefined : parseReference(value.lastKnownGood);
  return Object.freeze({ version: 1, current, ...(lastKnownGood === undefined ? {} : { lastKnownGood }) });
}
function parseReference(value: unknown): ManifestReference {
  if (!isRecord(value) || !onlyKeys(value, ['checksum', 'file']) || typeof value.checksum !== 'string' || !checksumPattern.test(value.checksum)
    || value.file !== `generation-${value.checksum}.json`) throw new RuntimeSnapshotStorageError('Invalid runtime snapshot manifest reference.');
  return Object.freeze({ checksum: value.checksum, file: value.file });
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    || (error instanceof RuntimeSnapshotStorageError && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT');
}
function isExpectedCleanupFilesystemError(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if (['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOTEMPTY'].includes((current as NodeJS.ErrnoException).code ?? '')) return true;
    current = (current as Error).cause;
  }
  return false;
}
