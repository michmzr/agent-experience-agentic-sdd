import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, opendirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
  type Dirent
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { getSystemErrorName } from 'node:util';

import {
  MAX_RUNTIME_SNAPSHOT_BYTES, parseSerializedRuntimeSnapshot, RuntimeSnapshotValidationError, serializeRuntimeSnapshot,
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

class RuntimeSnapshotDirectoryLimitError extends RuntimeSnapshotStorageError {
  readonly directory: 'reclaim' | 'state';
  constructor(directory: 'reclaim' | 'state', message: string) {
    super(message);
    this.name = 'RuntimeSnapshotDirectoryLimitError';
    this.directory = directory;
  }
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
  | 'after-writer-lock-rename'
  | 'before-writer-lock-directory-sync'
  | 'cleanup';

export interface RuntimeSnapshotStoreOptions {
  readonly clock: () => number;
  readonly wait?: (milliseconds: number) => void;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly injectFailure?: (step: RuntimeSnapshotStoreStep) => void;
  readonly afterLockAcquired?: () => void;
  readonly onLockWait?: () => void;
  readonly beforeStaleLockRename?: () => void;
  readonly beforeStaleCandidateRemoval?: () => void;
  readonly beforeLockRelease?: () => void;
  readonly beforeReclaimClaimRelease?: (claim: string) => void;
  readonly beforeStaleReclaimClaimRemoval?: (claim: string) => void;
  readonly onDirectoryEntryRead?: (directory: 'reclaim' | 'state') => void;
}
export interface RuntimeSnapshotPaths { readonly root: string; readonly manifest: string; readonly rollbackManifest: string }
interface ManifestReference { readonly checksum: string; readonly file: string }
interface RuntimeSnapshotManifestV1 { readonly version: 1; readonly current: ManifestReference; readonly lastKnownGood?: ManifestReference }

const checksumPattern = /^[a-f0-9]{64}$/;
const generationPattern = /^generation-([a-f0-9]{64})\.json$/;
const MAX_MANIFEST_BYTES = 16 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const reclaimClaimPattern = /^claim-(\d{12})-([a-f0-9-]+)$/;
const reclaimChoosingPattern = /^choosing-([a-f0-9-]+)$/;
const reclaimRecoveringPattern = /^(?:recovering|releasing)-([a-f0-9-]+)$/;
const MAX_RECLAIM_CLAIMS = 128;
const MAX_STATE_DIRECTORY_ENTRIES = 256;
const MAX_RECOVERY_CLEANUP_TRANSIENT_ENTRIES = 2;

export class RuntimeSnapshotStore {
  readonly paths: RuntimeSnapshotPaths;
  readonly #injectFailure: (step: RuntimeSnapshotStoreStep) => void;
  readonly #clock: () => number;
  readonly #wait: (milliseconds: number) => void;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #afterLockAcquired: () => void;
  readonly #onLockWait: () => void;
  readonly #beforeStaleLockRename: () => void;
  readonly #beforeStaleCandidateRemoval: () => void;
  readonly #beforeLockRelease: () => void;
  readonly #beforeReclaimClaimRelease: (claim: string) => void;
  readonly #beforeStaleReclaimClaimRemoval: (claim: string) => void;
  readonly #onDirectoryEntryRead: (directory: 'reclaim' | 'state') => void;

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
    this.#beforeStaleLockRename = options.beforeStaleLockRename ?? (() => undefined);
    this.#beforeStaleCandidateRemoval = options.beforeStaleCandidateRemoval ?? (() => undefined);
    this.#beforeLockRelease = options.beforeLockRelease ?? (() => undefined);
    this.#beforeReclaimClaimRelease = options.beforeReclaimClaimRelease ?? (() => undefined);
    this.#beforeStaleReclaimClaimRemoval = options.beforeStaleReclaimClaimRemoval ?? (() => undefined);
    this.#onDirectoryEntryRead = options.onDirectoryEntryRead ?? (() => undefined);
  }

  generationPath(checksum: string): string {
    if (!checksumPattern.test(checksum)) throw new RuntimeSnapshotStorageError('Invalid runtime snapshot generation checksum.');
    return resolve(this.paths.root, `generation-${checksum}.json`);
  }

  publish(snapshot: RuntimeSnapshotV1): RuntimeSnapshotV1 { return this.publishSerialized(serializeRuntimeSnapshot(snapshot)); }
  recover(snapshot: RuntimeSnapshotV1, expectedRepositoryId: string): RuntimeSnapshotV1 {
    return this.recoverSerialized(serializeRuntimeSnapshot(snapshot), expectedRepositoryId);
  }
  rebuild(compiler: () => RuntimeSnapshotV1): RuntimeSnapshotV1 { return this.publish(compiler()); }

  publishSerialized(serialized: string): RuntimeSnapshotV1 {
    const expected = parseSerializedRuntimeSnapshot(serialized);
    this.#ensurePrivateDirectory();
    return this.#withWriterLock(() => this.#publishLocked(serialized, expected));
  }

  recoverSerialized(serialized: string, expectedRepositoryId: string): RuntimeSnapshotV1 {
    const expected = parseSerializedRuntimeSnapshot(serialized);
    if (expected.repositoryId !== expectedRepositoryId) throw new RuntimeSnapshotStorageError('Runtime recovery candidate has the wrong target identity.');
    this.#ensurePrivateDirectory();
    return this.#withWriterLock(() => {
      let normalPublish = false;
      let priorCurrent: ManifestReference | undefined;
      try {
        const manifest = this.#readOptionalManifest();
        priorCurrent = manifest?.current;
        if (manifest !== undefined) this.#readSnapshotFile(resolveReference(this.paths.root, manifest.current), manifest.current.checksum);
        normalPublish = true;
      } catch (error) {
        if (!isRecoverableSnapshotError(error)) throw error;
      }
      return normalPublish
        ? this.#publishLocked(serialized, expected)
        : this.#recoverPublishLocked(serialized, expected, this.#validRecoveryReference(), priorCurrent);
    });
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

  #validRecoveryReference(): ManifestReference | undefined {
    let referenceToRecover: ManifestReference | undefined;
    try {
      const rollback = this.#readOptionalRollbackManifest();
      if (rollback !== undefined) {
        this.#readSnapshotFile(resolveReference(this.paths.root, rollback.current), rollback.current.checksum);
        referenceToRecover = rollback.current;
      }
    } catch (error) {
      if (!isRecoverableSnapshotError(error)) throw error;
    }
    if (referenceToRecover === undefined) {
      try {
        const manifest = this.#readOptionalManifest();
        if (manifest?.lastKnownGood !== undefined) {
          this.#readSnapshotFile(resolveReference(this.paths.root, manifest.lastKnownGood), manifest.lastKnownGood.checksum);
          referenceToRecover = manifest.lastKnownGood;
        }
      } catch (error) {
        if (!isRecoverableSnapshotError(error)) throw error;
      }
    }
    return referenceToRecover;
  }

  #recoverPublishLocked(
    serialized: string,
    expected: RuntimeSnapshotV1,
    lastKnownGood?: ManifestReference,
    priorCurrent?: ManifestReference
  ): RuntimeSnapshotV1 {
    const priorSerialized = this.#readOwnerFile(this.paths.manifest, MAX_MANIFEST_BYTES);
    const priorFingerprint = this.#manifestFingerprint();
    const generation = this.generationPath(expected.checksum);
    const generationCandidate = this.#candidate('recovery-generation');
    const manifestCandidate = this.#candidate('recovery-manifest');
    const restorationCandidate = this.#candidate('recovery-restoration');
    try {
      this.#writeFsyncedCandidate(generationCandidate, serialized, MAX_RUNTIME_SNAPSHOT_BYTES, 'after-generation-write');
      const reopened = this.#readSnapshotFile(generationCandidate, expected.checksum);
      this.#injectFailure('after-generation-reopen');
      this.#injectFailure('before-generation-rename');
      this.#installImmutableGeneration(generationCandidate, generation, expected.checksum);
      this.#injectFailure('before-generation-directory-sync');
      this.#syncDirectory();

      const committedManifest: RuntimeSnapshotManifestV1 = {
        version: 1,
        current: reference(expected.checksum),
        ...(lastKnownGood === undefined ? {} : { lastKnownGood })
      };
      this.#writeFsyncedCandidate(manifestCandidate, serializeManifest(committedManifest), MAX_MANIFEST_BYTES, 'after-manifest-write');
      this.#readManifestFile(manifestCandidate);
      this.#injectFailure('after-manifest-reopen');
      this.#writeFsyncedCandidate(restorationCandidate, priorSerialized, MAX_MANIFEST_BYTES);
      this.#assertSafeTarget(this.paths.manifest, MAX_MANIFEST_BYTES, true);
      this.#injectFailure('before-manifest-cas');
      if (this.#manifestFingerprint() !== priorFingerprint) throw new RuntimeSnapshotConflictError('Runtime snapshot manifest changed during recovery.');
      this.#injectFailure('before-manifest-rename');
      renameSync(manifestCandidate, this.paths.manifest);
      try {
        this.#injectFailure('before-commit-directory-sync');
        this.#syncDirectory();
      } catch (error) {
        renameSync(restorationCandidate, this.paths.manifest);
        this.#syncDirectory();
        throw error;
      }
      this.#removeCandidate(restorationCandidate);
      this.#cleanupAfterCommit(committedManifest, priorCurrent, true);
      return reopened;
    } finally {
      this.#removeCandidate(generationCandidate);
      this.#removeCandidate(manifestCandidate);
      this.#removeCandidate(restorationCandidate);
    }
  }

  #cleanupAfterCommit(
    manifest: RuntimeSnapshotManifestV1,
    knownSuperseded?: ManifestReference,
    streamingRecovery = false
  ): void {
    try { this.#injectFailure('cleanup'); }
    catch (error) { if (error instanceof RuntimeSnapshotCleanupError) return; throw error; }
    try {
      const retained = new Set([manifest.current.file, manifest.lastKnownGood?.file].filter((file): file is string => file !== undefined));
      const rollback = this.#readOptionalRollbackManifest();
      if (rollback !== undefined) {
        retained.add(rollback.current.file);
        if (rollback.lastKnownGood !== undefined) retained.add(rollback.lastKnownGood.file);
      }
      if (knownSuperseded !== undefined && !retained.has(knownSuperseded.file)) {
        this.#removeCandidate(resolveReference(this.paths.root, knownSuperseded));
      }
      if (streamingRecovery) {
        this.#cleanupRecoveryGenerations(retained);
        return;
      }
      for (const { name } of this.#readStateDirectoryEntries()) {
        if (generationPattern.test(name) && !retained.has(name)) this.#removeCandidate(resolve(this.paths.root, name));
      }
      this.#syncDirectory();
    } catch (error) {
      if (error instanceof RuntimeSnapshotDirectoryLimitError && error.directory === 'state') return;
      if (isExpectedNodeFilesystemError(error)) return;
      throw error;
    }
  }

  #cleanupRecoveryGenerations(retained: ReadonlySet<string>): void {
    const directory = opendirSync(this.paths.root);
    let entriesRead = 0;
    let removed = 0;
    let ownedWriterLockObserved = false;
    try {
      while (true) {
        const entry = directory.readSync();
        if (entry === null) break;
        entriesRead += 1;
        this.#onDirectoryEntryRead('state');
        if (entry.name === '.writer-lock') ownedWriterLockObserved = true;
        const artifact = resolve(this.paths.root, entry.name);
        if (generationPattern.test(entry.name) && !retained.has(entry.name)
          && this.#isOwnerSafeGenerationFile(artifact, entry)) {
          this.#removeCandidate(artifact);
          removed += 1;
        }
        if (entriesRead > MAX_STATE_DIRECTORY_ENTRIES + MAX_RECOVERY_CLEANUP_TRANSIENT_ENTRIES) {
          throw new RuntimeSnapshotDirectoryLimitError('state', 'Runtime snapshot state directory entry limit exceeded.');
        }
      }
    } finally { directory.closeSync(); }
    const steadyStateEntries = entriesRead - removed - (ownedWriterLockObserved ? 1 : 0);
    if (steadyStateEntries > MAX_STATE_DIRECTORY_ENTRIES) {
      throw new RuntimeSnapshotDirectoryLimitError('state', 'Runtime snapshot state directory entry limit exceeded.');
    }
  }

  #isOwnerSafeGenerationFile(path: string, entry: Dirent): boolean {
    if (!entry.isFile()) return false;
    let descriptor: number | undefined;
    try {
      const observed = lstatSync(path);
      if (!observed.isFile() || observed.isSymbolicLink() || observed.size > MAX_RUNTIME_SNAPSHOT_BYTES
        || (observed.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && observed.uid !== process.getuid())) return false;
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const reopened = fstatSync(descriptor);
      return reopened.isFile() && reopened.dev === observed.dev && reopened.ino === observed.ino
        && reopened.size <= MAX_RUNTIME_SNAPSHOT_BYTES && (reopened.mode & 0o077) === 0
        && (typeof process.getuid !== 'function' || reopened.uid === process.getuid());
    } catch (error) {
      if (isMissing(error) || hasTrustedNodeErrorCode(error, ['ENOENT', 'ELOOP'])) return false;
      throw error;
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
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
      if (isExpectedNodeFilesystemError(error) && error.code === 'ENOENT' && allowMissing) return;
      if (isExpectedNodeFilesystemError(error) && error.code === 'ENOENT') throw new RuntimeSnapshotStorageError('Runtime snapshot target does not exist.', { cause: error });
      throw error;
    }
  }

  #withWriterLock<T>(action: () => T): T {
    const lock = resolve(this.paths.root, '.writer-lock');
    const reclaimClaims = resolve(this.paths.root, '.writer-lock-reclaim');
    const token = randomUUID();
    const started = this.#clock();
    let acquiredIdentity: LockIdentity | undefined;
    while (true) {
      this.#cleanupAbandonedLockCandidates(this.#clock());
      const candidate = resolve(this.paths.root, `.writer-lock-candidate-${token}-${randomUUID()}`);
      try {
        acquiredIdentity = this.#tryAcquireWriterLock(candidate, lock, reclaimClaims, token);
      } finally {
        if (existsSync(candidate)) removeLockArtifact(candidate);
      }
      if (acquiredIdentity !== undefined) break;
      this.#recoverStaleWriterLock(lock, reclaimClaims, this.#clock());
      if (this.#clock() - started >= this.#lockTimeoutMs) throw new RuntimeSnapshotStorageError('Timed out waiting for runtime snapshot writer lock.');
      this.#onLockWait();
      this.#wait(Math.min(25, this.#lockTimeoutMs));
    }
    try {
      this.#afterLockAcquired();
      return action();
    }
    finally {
      this.#releaseWriterLock(lock, token, acquiredIdentity);
    }
  }

  #tryAcquireWriterLock(candidate: string, lock: string, reclaimClaims: string, token: string): LockIdentity | undefined {
    const timestamp = this.#clock();
    try { mkdirSync(candidate, { mode: 0o700 }); }
    catch (error) {
      if (isExpectedNodeFilesystemError(error) && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) return undefined;
      throw error;
    }
    const owner = resolve(candidate, 'owner.json');
    writeFileSync(owner, JSON.stringify({ pid: process.pid, timestamp, token }), { mode: 0o600, flag: 'wx' });
    fsyncFile(owner);
    fsyncDirectory(candidate);
    const preparedIdentity = lockIdentity(candidate);
    if (existsSync(lock)) return undefined;
    const reclaimNow = this.#clock();
    if (this.#hasLiveReclaimClaim(reclaimClaims, reclaimNow)) return undefined;
    try { renameSync(candidate, lock); }
    catch (error) {
      if (isExpectedNodeFilesystemError(error) && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) return undefined;
      throw error;
    }
    try {
      this.#injectFailure('after-writer-lock-rename');
      const acquiredIdentity = lockIdentity(lock);
      if (!sameLockIdentity(preparedIdentity, acquiredIdentity)) throw new RuntimeSnapshotStorageError('Runtime snapshot writer lock identity changed during acquisition.');
      this.#injectFailure('before-writer-lock-directory-sync');
      this.#syncDirectory();
      return acquiredIdentity;
    } catch (error) {
      try { this.#releaseOwnedWriterLock(lock, token, preparedIdentity); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Runtime snapshot writer lock acquisition rollback failed.'); }
      throw error;
    }
  }

  #recoverStaleWriterLock(lock: string, claims: string, now: number): void {
    let observed: LockObservation;
    try {
      observed = observeLock(lock);
      if (now - observed.owner.timestamp <= this.#staleLockMs || isPidAlive(observed.owner.pid)) return;
    } catch (error) {
      if (isExpectedNodeFilesystemError(error)) return;
      throw error;
    }

    this.#withReclaimClaim(claims, now, () => {
      const confirmed = observeLock(lock);
      if (!sameLockObservation(observed, confirmed) || isPidAlive(confirmed.owner.pid)) return;
      this.#beforeStaleLockRename();
      let final: LockObservation;
      try { final = observeLock(lock); }
      catch (error) { if (isExpectedNodeFilesystemError(error)) return; throw error; }
      if (!sameLockObservation(confirmed, final) || isPidAlive(final.owner.pid)) return;
      const stale = resolve(this.paths.root, `.writer-lock-stale-${randomUUID()}`);
      try {
        renameSync(lock, stale);
        rmSync(stale, { recursive: true, force: true });
        this.#syncDirectory();
      } catch (error) { if (!isExpectedNodeFilesystemError(error)) throw error; }
    });
  }

  #withReclaimClaim(claims: string, now: number, action: () => void): void {
    this.#ensureReclaimClaimsDirectory(claims);
    this.#cleanupStaleReclaimClaims(claims, now);
    const token = randomUUID();
    const candidate = resolve(this.paths.root, `.writer-reclaim-candidate-${token}`);
    const choosing = resolve(claims, `choosing-${token}`);
    let ownedPath = candidate;
    let identity: LockIdentity | undefined;
    try {
      mkdirSync(candidate, { mode: 0o700 });
      const owner = resolve(candidate, 'owner.json');
      writeFileSync(owner, JSON.stringify({ pid: process.pid, timestamp: now, token }), { mode: 0o600, flag: 'wx' });
      fsyncFile(owner);
      fsyncDirectory(candidate);
      renameSync(candidate, choosing);
      ownedPath = choosing;
      identity = lockIdentity(choosing);
      fsyncDirectory(claims);
      const ticket = this.#nextReclaimTicket(claims);
      const claim = resolve(claims, `claim-${String(ticket).padStart(12, '0')}-${token}`);
      renameSync(choosing, claim);
      ownedPath = claim;
      identity = lockIdentity(claim);
      fsyncDirectory(claims);
      if (!this.#hasEarlierLiveReclaimClaim(claims, claim, ticket, token, now)) action();
    } finally {
      if (identity !== undefined) this.#releaseReclaimClaim(ownedPath, token, identity);
      else removeLockArtifact(ownedPath);
    }
  }

  #ensureReclaimClaimsDirectory(claims: string): void {
    try { mkdirSync(claims, { mode: 0o700 }); }
    catch (error) { if (!isExpectedNodeFilesystemError(error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(claims);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new RuntimeSnapshotStorageError('Runtime snapshot reclaim claim directory is unsafe.');
    }
  }

  #nextReclaimTicket(claims: string): number {
    const entries = this.#readReclaimClaimEntries(claims);
    let maximum = 0;
    for (const entry of entries) {
      const match = reclaimClaimPattern.exec(entry);
      if (match !== null) maximum = Math.max(maximum, Number(match[1]));
    }
    if (!Number.isSafeInteger(maximum) || maximum >= 999_999_999_999) throw new RuntimeSnapshotStorageError('Runtime snapshot reclaim ticket is invalid.');
    return maximum + 1;
  }

  #hasEarlierLiveReclaimClaim(claims: string, claim: string, ticket: number, token: string, now: number): boolean {
    for (const entry of this.#readReclaimClaimEntries(claims)) {
      const path = resolve(claims, entry);
      if (path === claim) continue;
      const choosing = reclaimChoosingPattern.exec(entry);
      const prepared = reclaimClaimPattern.exec(entry);
      const recovering = reclaimRecoveringPattern.exec(entry);
      if (choosing === null && prepared === null && recovering === null) continue;
      const observed = this.#observeOptionalClaim(path);
      if (observed === undefined || this.#isStaleOwner(observed.owner, now)) continue;
      if (choosing !== null || recovering !== null) return true;
      const otherTicket = Number(prepared?.[1]);
      const otherToken = prepared?.[2] ?? '';
      if (otherTicket < ticket || (otherTicket === ticket && otherToken < token)) return true;
    }
    return false;
  }

  #hasLiveReclaimClaim(claims: string, now: number): boolean {
    let entries: string[];
    try { entries = this.#readReclaimClaimEntries(claims); }
    catch (error) {
      if (isExpectedNodeFilesystemError(error) && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    for (const entry of entries) {
      if (!isReclaimClaimEntry(entry)) continue;
      const observed = this.#observeOptionalClaim(resolve(claims, entry));
      if (observed !== undefined && !this.#isStaleOwner(observed.owner, now)) return true;
    }
    return false;
  }

  #cleanupStaleReclaimClaims(claims: string, now: number): void {
    const entries = this.#readReclaimClaimEntries(claims);
    for (const entry of entries) {
      if (!isReclaimClaimEntry(entry)) continue;
      const claim = resolve(claims, entry);
      const observed = this.#observeOptionalClaim(claim);
      if (observed === undefined || !this.#isStaleOwner(observed.owner, now)) continue;
      this.#beforeStaleReclaimClaimRemoval(claim);
      const recovering = resolve(claims, `recovering-${randomUUID()}`);
      try { renameSync(claim, recovering); }
      catch (error) { if (isExpectedNodeFilesystemError(error)) continue; throw error; }
      const moved = this.#observeOptionalClaim(recovering);
      if (moved !== undefined && sameLockObservation(observed, moved) && this.#isStaleOwner(moved.owner, now)) {
        removeLockArtifact(recovering);
      }
      fsyncDirectory(claims);
    }
  }

  #observeOptionalClaim(claim: string): LockObservation | undefined {
    try { return observeLock(claim); }
    catch (error) { if (isExpectedNodeFilesystemError(error)) return undefined; throw error; }
  }

  #readReclaimClaimEntries(claims: string): string[] {
    return this.#readBoundedDirectoryEntries(claims, MAX_RECLAIM_CLAIMS, 'Runtime snapshot reclaim claim limit exceeded.', 'reclaim').map(({ name }) => name);
  }

  #isStaleOwner(owner: LockOwner, now: number): boolean {
    return now - owner.timestamp > this.#staleLockMs && !isPidAlive(owner.pid);
  }

  #cleanupAbandonedLockCandidates(now: number): void {
    for (const entry of this.#readStateDirectoryEntries()) {
      if (!entry.isDirectory() || (!entry.name.startsWith('.writer-lock-candidate-') && !entry.name.startsWith('.writer-reclaim-candidate-'))) continue;
      const candidate = resolve(this.paths.root, entry.name);
      let observed: LockIdentity;
      try { observed = lockIdentity(candidate); }
      catch (error) { if (isExpectedNodeFilesystemError(error)) continue; throw error; }
      if (now - observed.mtimeMs <= this.#staleLockMs) continue;
      this.#beforeStaleCandidateRemoval();
      let confirmed: LockIdentity;
      try { confirmed = lockIdentity(candidate); }
      catch (error) { if (isExpectedNodeFilesystemError(error)) continue; throw error; }
      if (!sameLockIdentity(observed, confirmed)) continue;
      try { rmSync(candidate, { recursive: true }); }
      catch (error) { if (!isExpectedNodeFilesystemError(error)) throw error; }
    }
  }

  #releaseWriterLock(lock: string, token: string, acquiredIdentity: LockIdentity | undefined): void {
    let programmingError: unknown;
    try { this.#beforeLockRelease(); }
    catch (error) { programmingError = error; }
    try {
      if (acquiredIdentity !== undefined) this.#releaseOwnedWriterLock(lock, token, acquiredIdentity);
    } catch (error) {
      if (!isExpectedNodeFilesystemError(error) && programmingError === undefined) programmingError = error;
    }
    if (programmingError !== undefined) throw programmingError;
  }

  #releaseOwnedWriterLock(lock: string, token: string, acquiredIdentity: LockIdentity): void {
    const observed = observeLock(lock);
    if (observed.owner.token !== token || !sameLockIdentity(observed.identity, acquiredIdentity)) return;
    rmSync(lock, { recursive: true, force: true });
    this.#syncDirectory();
  }

  #readStateDirectoryEntries(): Dirent[] {
    return this.#readBoundedDirectoryEntries(this.paths.root, MAX_STATE_DIRECTORY_ENTRIES, 'Runtime snapshot state directory entry limit exceeded.', 'state');
  }

  #readBoundedDirectoryEntries(path: string, maximum: number, message: string, kind: 'reclaim' | 'state'): Dirent[] {
    const directory = opendirSync(path);
    const entries: Dirent[] = [];
    try {
      while (true) {
        const entry = directory.readSync();
        if (entry === null) return entries;
        entries.push(entry);
        this.#onDirectoryEntryRead(kind);
        if (entries.length > maximum) throw new RuntimeSnapshotDirectoryLimitError(kind, message);
      }
    } finally {
      directory.closeSync();
    }
  }

  #releaseReclaimClaim(claim: string, token: string, identity: LockIdentity): void {
    let programmingError: unknown;
    try { this.#beforeReclaimClaimRelease(claim); }
    catch (error) { programmingError = error; }
    try {
      const releasing = resolve(dirname(claim), `releasing-${randomUUID()}`);
      renameSync(claim, releasing);
      const observed = observeLock(releasing);
      if (observed.owner.token === token && sameLockIdentity(observed.identity, identity)) {
        removeLockArtifact(releasing);
      }
      fsyncDirectory(dirname(claim));
    } catch (error) {
      if (!isExpectedNodeFilesystemError(error) && programmingError === undefined) programmingError = error;
    }
    if (programmingError !== undefined) throw programmingError;
  }

  #syncDirectory(): void {
    const descriptor = openSync(this.paths.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }

  #candidate(kind: string): string { return resolve(this.paths.root, `.${kind}-${randomUUID()}.tmp`); }
  #removeCandidate(path: string): void { try { unlinkSync(path); } catch (error) { if (!isExpectedNodeFilesystemError(error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}

interface LockOwner { readonly pid: number; readonly timestamp: number; readonly token: string }
interface LockIdentity { readonly dev: number; readonly ino: number; readonly mtimeMs: number }
interface LockObservation { readonly identity: LockIdentity; readonly owner: LockOwner }

function observeLock(lock: string): LockObservation {
  const identity = lockIdentity(lock);
  const value = JSON.parse(readFileSync(resolve(lock, 'owner.json'), 'utf8')) as unknown;
  if (!isRecord(value) || typeof value.pid !== 'number' || typeof value.timestamp !== 'number' || typeof value.token !== 'string') {
    throw new RuntimeSnapshotStorageError('Runtime snapshot writer lock owner is invalid.');
  }
  return { identity, owner: { pid: value.pid, timestamp: value.timestamp, token: value.token } };
}

function lockIdentity(path: string): LockIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeSnapshotStorageError('Runtime snapshot writer lock is unsafe.');
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
}

function sameLockObservation(left: LockObservation, right: LockObservation): boolean {
  return sameLockIdentity(left.identity, right.identity)
    && left.owner.pid === right.owner.pid
    && left.owner.timestamp === right.owner.timestamp
    && left.owner.token === right.owner.token;
}

function sameLockIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

function isReclaimClaimEntry(name: string): boolean {
  return reclaimChoosingPattern.test(name) || reclaimClaimPattern.test(name) || reclaimRecoveringPattern.test(name);
}

function removeLockArtifact(path: string): boolean {
  try { rmSync(path, { recursive: true }); return true; }
  catch (error) {
    if (isExpectedNodeFilesystemError(error)) return false;
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !hasTrustedNodeErrorCode(error, ['ESRCH']); }
}

function isRecoverableSnapshotError(error: unknown): boolean {
  return error instanceof RuntimeSnapshotStorageError || error instanceof RuntimeSnapshotValidationError;
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
      if (isExpectedNodeFilesystemError(error) && error.code === 'ENOENT') return;
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
  return isExpectedNodeFilesystemError(error) && error.code === 'ENOENT'
    || (error instanceof RuntimeSnapshotStorageError && isExpectedNodeFilesystemError(error.cause) && error.cause.code === 'ENOENT');
}
function isExpectedNodeFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return hasTrustedNodeErrorCode(error, ['ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOTEMPTY']);
}
function hasTrustedNodeErrorCode(error: unknown, allowedCodes: readonly string[]): error is NodeJS.ErrnoException {
  if (!(error instanceof Error) || error instanceof TypeError || error instanceof SyntaxError) return false;
  const systemError = error as NodeJS.ErrnoException;
  if (typeof systemError.errno !== 'number' || typeof systemError.syscall !== 'string') return false;
  try {
    return getSystemErrorName(systemError.errno) === systemError.code
      && allowedCodes.includes(systemError.code ?? '');
  } catch {
    return false;
  }
}
