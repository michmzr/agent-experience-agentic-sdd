import { constants, closeSync, copyFileSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, relative, resolve } from 'node:path';

import type { RuntimeSnapshotV1 } from '../runtime/snapshot.js';
import { MAX_RUNTIME_SNAPSHOT_BYTES, parseSerializedRuntimeSnapshot, serializeRuntimeSnapshot } from '../runtime/snapshot.js';

export class RuntimeSnapshotStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RuntimeSnapshotStorageError'; }
}

export interface RuntimeSnapshotPaths { readonly root: string; readonly current: string; readonly lastKnownGood: string }

export class RuntimeSnapshotStore {
  readonly paths: RuntimeSnapshotPaths;

  constructor(stateDirectory: string) {
    const root = resolve(stateDirectory);
    if (!basename(root) || relative(root, root) !== '') throw new RuntimeSnapshotStorageError('Invalid runtime snapshot state path.');
    this.paths = Object.freeze({ root, current: resolve(root, 'current.json'), lastKnownGood: resolve(root, 'last-known-good.json') });
    for (const path of [this.paths.current, this.paths.lastKnownGood]) {
      if (dirname(path) !== root) throw new RuntimeSnapshotStorageError('Runtime snapshot path escapes private state.');
    }
  }

  publish(snapshot: RuntimeSnapshotV1): RuntimeSnapshotV1 { return this.publishSerialized(serializeRuntimeSnapshot(snapshot)); }

  rebuild(compiler: () => RuntimeSnapshotV1): RuntimeSnapshotV1 {
    return this.publish(compiler());
  }

  publishSerialized(serialized: string): RuntimeSnapshotV1 {
    const expected = parseSerializedRuntimeSnapshot(serialized);
    this.#ensurePrivateDirectory();
    this.#assertSafeTarget(this.paths.current);
    this.#assertSafeTarget(this.paths.lastKnownGood);
    const candidate = resolve(this.paths.root, `.candidate-${randomUUID()}.json`);
    const previousCandidate = resolve(this.paths.root, `.previous-${randomUUID()}.json`);
    try {
      this.#writeCandidate(candidate, serialized);
      const reopened = this.#readValidated(candidate);
      if (reopened.checksum !== expected.checksum) throw new RuntimeSnapshotStorageError('Candidate checksum changed during write.');

      const current = this.#readOptionalValidated(this.paths.current);
      if (current !== undefined) {
        copyFileSync(this.paths.current, previousCandidate, constants.COPYFILE_EXCL);
        const previous = this.#readValidated(previousCandidate);
        if (previous.checksum !== current.checksum) throw new RuntimeSnapshotStorageError('Last-known-good candidate checksum mismatch.');
        renameSync(previousCandidate, this.paths.lastKnownGood);
      }
      renameSync(candidate, this.paths.current);
      this.#syncDirectory();
      return reopened;
    } catch (error) {
      this.#removeCandidate(candidate); this.#removeCandidate(previousCandidate);
      if (error instanceof RuntimeSnapshotStorageError) throw error;
      throw new RuntimeSnapshotStorageError('Runtime snapshot publication failed.', { cause: error });
    }
  }

  loadCurrent(): RuntimeSnapshotV1 { return this.#readValidated(this.paths.current); }
  loadLastKnownGood(): RuntimeSnapshotV1 { return this.#readValidated(this.paths.lastKnownGood); }

  #ensurePrivateDirectory(): void {
    this.#assertNoSymlinkAncestors();
    mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.paths.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeSnapshotStorageError('Runtime snapshot state directory is unsafe.');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new RuntimeSnapshotStorageError('Runtime snapshot state directory has a different owner.');
    if ((stat.mode & 0o077) !== 0) throw new RuntimeSnapshotStorageError('Runtime snapshot state directory must be owner-only.');
  }

  #assertNoSymlinkAncestors(): void {
    let path = this.paths.root;
    while (true) {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new RuntimeSnapshotStorageError('Runtime snapshot state path has a symlinked ancestor.');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = dirname(path);
      if (parent === path) return;
      path = parent;
    }
  }

  #assertSafeTarget(path: string): void {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new RuntimeSnapshotStorageError('Runtime snapshot target is unsafe.');
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new RuntimeSnapshotStorageError('Runtime snapshot target has a different owner.');
      if ((stat.mode & 0o077) !== 0) throw new RuntimeSnapshotStorageError('Runtime snapshot target must be owner-only.');
      if (stat.size > MAX_RUNTIME_SNAPSHOT_BYTES) throw new RuntimeSnapshotStorageError('Runtime snapshot size limit exceeded.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  #writeCandidate(path: string, serialized: string): void {
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_SNAPSHOT_BYTES) throw new RuntimeSnapshotStorageError('Runtime snapshot size limit exceeded.');
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, serialized, 'utf8'); fchmodSync(descriptor, 0o600); fsyncSync(descriptor);
      if (fstatSync(descriptor).dev !== statSync(this.paths.root).dev) throw new RuntimeSnapshotStorageError('Runtime snapshot staging crossed filesystems.');
    } finally { closeSync(descriptor); }
  }

  #readOptionalValidated(path: string): RuntimeSnapshotV1 | undefined {
    try { return this.#readValidated(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).cause && ((error as Error).cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  #readValidated(path: string): RuntimeSnapshotV1 {
    let descriptor: number | undefined;
    try {
      this.#ensurePrivateDirectory(); this.#assertSafeTarget(path);
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_RUNTIME_SNAPSHOT_BYTES) throw new RuntimeSnapshotStorageError('Runtime snapshot resource limit exceeded.');
      return parseSerializedRuntimeSnapshot(readFileSync(descriptor, 'utf8'));
    } catch (error) {
      if (error instanceof RuntimeSnapshotStorageError) throw error;
      throw new RuntimeSnapshotStorageError(`Unable to load runtime snapshot ${basename(path)}.`, { cause: error });
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  #syncDirectory(): void {
    const descriptor = openSync(this.paths.root, constants.O_RDONLY);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }

  #removeCandidate(path: string): void { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
