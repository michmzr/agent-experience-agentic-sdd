import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { repositoryIdentityHash } from './generation-store.js';

export interface RepositoryLockOptions {
  readonly clock?: () => number;
  readonly wait?: (milliseconds: number) => void;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly afterLockCandidatePrepared?: (candidate: string) => void;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

export function repositoryLockDirectory(repositoryRoot: string): string {
  const canonical = realpathSync.native(resolve(repositoryRoot));
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  const coordinationRoot = join(tmpdir(), `ael-repository-knowledge-coordination-${user}`);
  mkdirSync(coordinationRoot, { recursive: true, mode: 0o700 });
  assertOwnedDirectory(coordinationRoot);
  chmodSync(coordinationRoot, 0o700);
  assertOwnerOnlyMode(coordinationRoot);
  const directory = join(coordinationRoot, repositoryIdentityHash(canonical));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnedDirectory(directory);
  chmodSync(directory, 0o700);
  assertOwnerOnlyMode(directory);
  return directory;
}

function assertOwnedDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Repository knowledge coordination path is invalid.');
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error('Repository knowledge coordination path has an invalid owner.');
}

function assertOwnerOnlyMode(path: string): void {
  if ((lstatSync(path).mode & 0o077) !== 0) throw new Error('Repository knowledge coordination path permissions are invalid.');
}

export function withRepositoryLock<T>(repositoryRoot: string, action: () => T, options: RepositoryLockOptions = {}): T {
  const directory = repositoryLockDirectory(repositoryRoot);
  const lock = join(directory, 'lock');
  const clock = options.clock ?? Date.now;
  const wait = options.wait ?? blockingWait;
  const timeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleAfter = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const started = clock();
  const token = randomUUID();
  while (true) {
    cleanupAbandonedCandidates(directory, clock(), staleAfter);
    const candidate = join(directory, `lock-candidate-${token}-${randomUUID()}`);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      const ownerPath = join(candidate, 'owner.json');
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, timestamp: clock(), token }), { mode: 0o600, flag: 'wx' });
      fsyncPath(ownerPath);
      fsyncDirectory(candidate);
      options.afterLockCandidatePrepared?.(candidate);
      if (existsSync(lock)) throw occupiedLockError();
      renameSync(candidate, lock);
      fsyncDirectory(directory);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      recoverStaleLock(lock, clock(), staleAfter);
      if (clock() - started >= timeout) throw new Error('Timed out waiting for repository knowledge lock.');
      wait(Math.min(25, timeout));
    } finally {
      if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
    }
  }
  try {
    return action();
  } finally {
    try {
      const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { token?: string };
      if (owner.token === token) rmSync(lock, { recursive: true, force: true });
    } catch { /* Never remove a lock whose ownership cannot be verified. */ }
  }
}

function occupiedLockError(): NodeJS.ErrnoException {
  const error = new Error('Repository knowledge lock is already held.') as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  return error;
}

function recoverStaleLock(lock: string, now: number, staleAfter: number): void {
  try {
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid?: number; timestamp?: number; token?: string };
    if (typeof owner.pid !== 'number' || typeof owner.timestamp !== 'number' || typeof owner.token !== 'string') {
      recoverMalformedStaleLock(lock, now, staleAfter);
      return;
    }
    if (now - owner.timestamp <= staleAfter || isPidAlive(owner.pid)) return;
    const confirmed = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid?: number; timestamp?: number; token?: string };
    if (confirmed.pid !== owner.pid || confirmed.timestamp !== owner.timestamp || confirmed.token !== owner.token || isPidAlive(owner.pid)) return;
    const stale = `${lock}.stale-${owner.token}`;
    renameSync(lock, stale);
    rmSync(stale, { recursive: true, force: true });
  } catch { recoverMalformedStaleLock(lock, now, staleAfter); }
}

function recoverMalformedStaleLock(lock: string, now: number, staleAfter: number): void {
  try {
    const observed = statSync(lock);
    if (now - observed.mtimeMs <= staleAfter) return;
    try {
      const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid?: number; timestamp?: number; token?: string };
      if (typeof owner.pid === 'number' && typeof owner.timestamp === 'number' && typeof owner.token === 'string') return;
    } catch { /* The conservative directory age protects an incomplete legacy owner write. */ }
    const confirmed = statSync(lock);
    if (confirmed.dev !== observed.dev || confirmed.ino !== observed.ino || confirmed.mtimeMs !== observed.mtimeMs) return;
    const stale = `${lock}.stale-malformed-${randomUUID()}`;
    renameSync(lock, stale);
    rmSync(stale, { recursive: true, force: true });
  } catch { /* A live or concurrently changing legacy lock remains untouched. */ }
}

function cleanupAbandonedCandidates(directory: string, now: number, staleAfter: number): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('lock-candidate-')) continue;
    const candidate = join(directory, entry.name);
    try {
      const observed = statSync(candidate);
      if (now - observed.mtimeMs <= staleAfter) continue;
      const confirmed = statSync(candidate);
      if (confirmed.dev !== observed.dev || confirmed.ino !== observed.ino || confirmed.mtimeMs !== observed.mtimeMs) continue;
      rmSync(candidate, { recursive: true, force: true });
    } catch { /* A concurrently changing candidate remains untouched. */ }
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

function fsyncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
