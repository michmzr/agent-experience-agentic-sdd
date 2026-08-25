import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import {
  MAX_RUNTIME_SNAPSHOT_BYTES, parseSerializedRuntimeSnapshot, serializeRuntimeSnapshot,
  type RuntimeSnapshotV1
} from '../runtime/snapshot.js';

export class RuntimeSnapshotStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RuntimeSnapshotStorageError'; }
}

export type RuntimeSnapshotStoreStep =
  | 'after-generation-write'
  | 'after-generation-reopen'
  | 'before-generation-rename'
  | 'before-generation-directory-sync'
  | 'after-manifest-write'
  | 'after-manifest-reopen'
  | 'before-manifest-rename'
  | 'before-commit-directory-sync'
  | 'cleanup';

export interface RuntimeSnapshotStoreOptions { readonly injectFailure?: (step: RuntimeSnapshotStoreStep) => void }
export interface RuntimeSnapshotPaths { readonly root: string; readonly manifest: string }
interface ManifestReference { readonly checksum: string; readonly file: string }
interface RuntimeSnapshotManifestV1 { readonly version: 1; readonly current: ManifestReference; readonly lastKnownGood?: ManifestReference }

const checksumPattern = /^[a-f0-9]{64}$/;
const generationPattern = /^generation-([a-f0-9]{64})\.json$/;
const MAX_MANIFEST_BYTES = 16 * 1024;

export class RuntimeSnapshotStore {
  readonly paths: RuntimeSnapshotPaths;
  readonly #injectFailure: (step: RuntimeSnapshotStoreStep) => void;

  constructor(stateDirectory: string, options: RuntimeSnapshotStoreOptions = {}) {
    const root = canonicalStateRoot(stateDirectory);
    assertNoCallerSymlink(root);
    if (!basename(root) || relative(root, root) !== '') throw new RuntimeSnapshotStorageError('Invalid runtime snapshot state path.');
    this.paths = Object.freeze({ root, manifest: resolve(root, 'manifest.json') });
    if (dirname(this.paths.manifest) !== root) throw new RuntimeSnapshotStorageError('Runtime snapshot manifest escapes private state.');
    this.#injectFailure = options.injectFailure ?? (() => undefined);
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
    const priorManifest = this.#readOptionalManifest();
    if (priorManifest !== undefined) {
      this.#readSnapshotFile(resolveReference(this.paths.root, priorManifest.current), priorManifest.current.checksum);
    }
    const priorSerialized = priorManifest === undefined ? undefined : serializeManifest(priorManifest);
    const generation = this.generationPath(expected.checksum);
    const generationCandidate = this.#candidate('generation');
    const manifestCandidate = this.#candidate('manifest');
    const rollbackCandidate = this.#candidate('rollback');
    let manifestRenamed = false;

    try {
      this.#writeFsyncedCandidate(generationCandidate, serialized, MAX_RUNTIME_SNAPSHOT_BYTES, 'after-generation-write');
      const reopened = this.#readSnapshotFile(generationCandidate, expected.checksum);
      this.#injectFailure('after-generation-reopen');
      this.#injectFailure('before-generation-rename');
      this.#installImmutableGeneration(generationCandidate, generation, expected.checksum);
      this.#injectFailure('before-generation-directory-sync');
      this.#syncDirectory();

      const nextManifest: RuntimeSnapshotManifestV1 = Object.freeze({
        version: 1,
        current: reference(expected.checksum),
        ...(priorManifest === undefined ? {} : { lastKnownGood: priorManifest.current })
      });
      const nextSerialized = serializeManifest(nextManifest);
      this.#writeFsyncedCandidate(manifestCandidate, nextSerialized, MAX_MANIFEST_BYTES, 'after-manifest-write');
      this.#readManifestFile(manifestCandidate);
      this.#injectFailure('after-manifest-reopen');
      if (priorSerialized !== undefined) {
        this.#writeFsyncedCandidate(rollbackCandidate, priorSerialized, MAX_MANIFEST_BYTES);
        this.#readManifestFile(rollbackCandidate);
      }

      this.#assertSafeTarget(this.paths.manifest, MAX_MANIFEST_BYTES, true);
      this.#injectFailure('before-manifest-rename');
      renameSync(manifestCandidate, this.paths.manifest);
      manifestRenamed = true;
      try {
        this.#injectFailure('before-commit-directory-sync');
        this.#syncDirectory();
      } catch (error) {
        this.#restoreManifest(rollbackCandidate, priorSerialized !== undefined);
        manifestRenamed = false;
        throw error;
      }

      this.#removeCandidate(rollbackCandidate);
      this.#cleanupAfterCommit(nextManifest);
      return reopened;
    } catch (error) {
      this.#removeCandidate(generationCandidate);
      this.#removeCandidate(manifestCandidate);
      if (!manifestRenamed) this.#removeCandidate(rollbackCandidate);
      if (error instanceof RuntimeSnapshotStorageError) throw error;
      throw new RuntimeSnapshotStorageError('Runtime snapshot publication failed.', { cause: error });
    }
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

  #restoreManifest(rollbackCandidate: string, hadPriorManifest: boolean): void {
    if (hadPriorManifest) renameSync(rollbackCandidate, this.paths.manifest);
    else this.#removeCandidate(this.paths.manifest);
    this.#syncDirectory();
  }

  #cleanupAfterCommit(manifest: RuntimeSnapshotManifestV1): void {
    try {
      this.#injectFailure('cleanup');
      const retained = new Set([manifest.current.file, manifest.lastKnownGood?.file].filter((file): file is string => file !== undefined));
      for (const name of readdirSync(this.paths.root)) {
        if (generationPattern.test(name) && !retained.has(name)) this.#removeCandidate(resolve(this.paths.root, name));
      }
      this.#syncDirectory();
    } catch { /* Cleanup is post-commit and cannot change manifest correctness. */ }
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

  #syncDirectory(): void {
    const descriptor = openSync(this.paths.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }

  #candidate(kind: string): string { return resolve(this.paths.root, `.${kind}-${randomUUID()}.tmp`); }
  #removeCandidate(path: string): void { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
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
