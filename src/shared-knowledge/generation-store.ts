import { createHash, type Hash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolvePrivateDataDirectory } from '../storage/database.js';
import { compare } from './schema.js';

export const MAX_INDEX_BYTES = 1_048_576;
export const MAX_MARKDOWN_BYTES = 65_536;
const MAX_GENERATION_PATHS = 1_002;
const MAX_GENERATION_BYTES = MAX_INDEX_BYTES + (1_000 * MAX_MARKDOWN_BYTES);

export class RepositoryKnowledgeValidationError extends Error {
  readonly code = 'INVALID_REPOSITORY_KNOWLEDGE';
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RepositoryKnowledgeValidationError'; }
}

export class RepositoryKnowledgeConfigurationError extends Error {
  readonly code = 'INVALID_REPOSITORY_KNOWLEDGE_CONFIGURATION';
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RepositoryKnowledgeConfigurationError'; }
}

export interface PrivateGenerationPaths { readonly directory: string; readonly recovery: string; }
export interface LocalGenerationSource {
  readonly readFile: (path: string, maxBytes?: number) => string | undefined;
  readonly listFiles: (prefix: string) => readonly string[];
}

export function repositoryIdentityHash(canonicalRepositoryRoot: string): string {
  return createHash('sha256').update(canonicalRepositoryRoot).digest('hex');
}

export function safeGenerationBase(repositoryRoot: string): string {
  const root = resolve(repositoryRoot);
  const base = resolve(root, 'agent-experience');
  if (relative(root, base).startsWith('..')) throw new Error('Repository knowledge path escapes repository root.');
  return base;
}

export function resolvePrivateGenerationPaths(repositoryRoot: string, stateRootOption?: string): PrivateGenerationPaths {
  const canonical = realpathSync.native(resolve(repositoryRoot));
  const requestedStateRoot = resolve(stateRootOption ?? join(resolvePrivateDataDirectory(), 'repository-knowledge'));
  const stateRoot = canonicalizePotentialPath(requestedStateRoot);
  if (isPathInside(canonical, stateRoot)) throw new Error('Repository knowledge private state must be outside the repository.');
  const directory = join(stateRoot, repositoryIdentityHash(canonical));
  if (isPathInside(canonical, canonicalizePotentialPath(directory))) throw new Error('Repository knowledge private state must be outside the repository.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return { directory, recovery: join(directory, 'recovery') };
}

export function createLocalGenerationSource(repositoryRoot: string, base: string): LocalGenerationSource {
  assertNoSymlinkPath(repositoryRoot, base);
  validateClosedWorldGeneration(base);
  return {
    readFile: (path, maxBytes) => {
      const target = safeChild(base, path);
      try { assertNotSymlink(target); return boundedReadText(target, maxBytes ?? MAX_MARKDOWN_BYTES); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== 'index.json') return undefined;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (listMarkdownFiles(base, 'knowledge').length > 0) throw new Error('Orphan knowledge documents exist without an index.');
          throw new Error('Repository knowledge generation is unavailable.');
        }
        throw error;
      }
    },
    listFiles: (prefix) => prefix === ''
      ? [...(existsSync(join(base, 'index.json')) ? ['index.json'] : []), ...listMarkdownFiles(base, 'knowledge')]
      : listMarkdownFiles(base, prefix)
  };
}

export function generationFingerprint(base: string): string {
  if (!existsSync(base)) return 'absent';
  validateClosedWorldGeneration(base);
  const hash = createHash('sha256');
  for (const entry of readdirSync(base, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name))) {
    const path = join(base, entry.name);
    hash.update(entry.name).update('\0');
    if (entry.isFile()) updateHashFromBoundedFile(hash, path, MAX_INDEX_BYTES);
    else for (const document of readdirSync(path, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name))) {
      hash.update(`knowledge/${document.name}`).update('\0');
      updateHashFromBoundedFile(hash, join(path, document.name), MAX_MARKDOWN_BYTES);
    }
  }
  return hash.digest('hex');
}

export function validateClosedWorldGeneration(base: string): void {
  const rootEntries = readdirSync(base, { withFileTypes: true });
  let pathCount = rootEntries.length;
  let totalBytes = 0;
  if (pathCount > MAX_GENERATION_PATHS) throw new RepositoryKnowledgeValidationError('Repository knowledge generation path limit exceeded.');
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink()) throw new RepositoryKnowledgeValidationError('Repository knowledge generation contains a symlink.');
    if (entry.name === 'index.json' && entry.isFile()) {
      totalBytes += assertLocalFileSize(join(base, entry.name), MAX_INDEX_BYTES, 'Repository knowledge index resource limit exceeded.');
      continue;
    }
    if (entry.name === 'knowledge' && entry.isDirectory()) continue;
    throw new RepositoryKnowledgeValidationError('Repository knowledge generation contains an unrecognized path.');
  }
  const knowledge = join(base, 'knowledge');
  if (!existsSync(knowledge)) return;
  for (const entry of readdirSync(knowledge, { withFileTypes: true })) {
    pathCount += 1;
    if (pathCount > MAX_GENERATION_PATHS) throw new RepositoryKnowledgeValidationError('Repository knowledge generation path limit exceeded.');
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.md')) {
      throw new RepositoryKnowledgeValidationError('Repository knowledge generation contains an unrecognized path or nesting.');
    }
    totalBytes += assertLocalFileSize(join(knowledge, entry.name), MAX_MARKDOWN_BYTES, 'Knowledge Markdown resource limit exceeded.');
    if (totalBytes > MAX_GENERATION_BYTES) throw new RepositoryKnowledgeValidationError('Repository knowledge generation byte limit exceeded.');
  }
}

export function cleanupPrivateCandidates(paths: PrivateGenerationPaths): void {
  for (const entry of readdirSync(paths.directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name.startsWith('stage-') || entry.name.startsWith('recovery-'))) rmSync(join(paths.directory, entry.name), { recursive: true, force: true });
  }
}

export function securePrivateTree(directory: string): void {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) securePrivateTree(path);
    else if (entry.isFile()) chmodSync(path, 0o600);
  }
}

export function assertPublicationDevice(repositoryParent: string, privateStage: string, deviceStat?: (path: string) => number | bigint): void {
  const readDevice = deviceStat ?? ((path: string) => statSync(path).dev);
  if (String(readDevice(repositoryParent)) !== String(readDevice(privateStage))) throw new RepositoryKnowledgeConfigurationError('Repository knowledge publication configuration uses different filesystems.');
}

export function publishRename(stage: string, primary: string): void {
  try { renameSync(stage, primary); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new RepositoryKnowledgeConfigurationError('Repository knowledge publication configuration uses different filesystems.');
    throw error;
  }
}

export function fsyncTree(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) fsyncTree(path);
    else if (entry.isFile()) fsyncPath(path);
  }
  fsyncDirectory(directory);
}

export function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try { descriptor = openSync(path, 'r'); fsyncSync(descriptor); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function canonicalizePotentialPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...missing);
}

function isPathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function safeChild(base: string, path: string): string {
  const target = resolve(base, path);
  if (relative(base, target).startsWith('..')) throw new Error('Knowledge document path escapes repository root.');
  return target;
}

function assertNoSymlinkPath(repositoryRoot: string, base: string): void {
  assertNotSymlink(resolve(repositoryRoot));
  if (existsSync(base)) assertNotSymlink(base);
}

function assertNotSymlink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Repository knowledge path is a symlink: ${path}.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function assertLocalFileSize(path: string, maxBytes: number, message: string): number {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > maxBytes) throw new RepositoryKnowledgeValidationError(message);
  return metadata.size;
}

function boundedReadText(path: string, maxBytes: number): string { return readBoundedBuffer(path, maxBytes).toString('utf8'); }

function readBoundedBuffer(path: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, 'r');
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maxBytes) throw new RepositoryKnowledgeValidationError('Repository knowledge file resource limit exceeded.');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(16_384, maxBytes - total + 1));
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new RepositoryKnowledgeValidationError('Repository knowledge file resource limit exceeded.');
      chunks.push(buffer.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally { closeSync(descriptor); }
}

function updateHashFromBoundedFile(hash: Hash, path: string, maxBytes: number): void {
  const descriptor = openSync(path, 'r');
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maxBytes) throw new RepositoryKnowledgeValidationError('Repository knowledge file resource limit exceeded.');
    const buffer = Buffer.allocUnsafe(16_384);
    let total = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, maxBytes - total + 1), null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new RepositoryKnowledgeValidationError('Repository knowledge file resource limit exceeded.');
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(descriptor); }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function listMarkdownFiles(base: string, prefix: string): string[] {
  const directory = safeChild(base, prefix);
  try {
    assertNotSymlink(directory);
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Repository knowledge must not contain symlinks.');
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) files.push(...listMarkdownFiles(base, path));
      else if (entry.isFile() && path.endsWith('.md')) files.push(path);
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
