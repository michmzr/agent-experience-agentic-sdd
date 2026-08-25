import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { KnowledgeState, LessonKind } from '../domain/types.js';
import { assertDurableTextSafe } from '../review/sanitizer.js';
import { resolvePrivateDataDirectory } from '../storage/database.js';
import { assertIdentity, assertSafeExportValue, compare, contentHash, parseKnowledgeIndex, serializeKnowledgeIndex, type InstructionOrigin, type KnowledgeApplicability, type KnowledgeApproval, type KnowledgeIndexEntryV2, type KnowledgeIndexV2, type KnowledgeVerification } from './schema.js';

export interface PromotionEvidence {
  readonly kind: 'code-or-tool' | 'reviewed-summary';
  readonly summary: string;
  readonly deterministic: boolean;
}

export interface SharedKnowledgeDocument {
  readonly identity: string;
  readonly repositoryScope: string;
  readonly kind: LessonKind;
  readonly state: KnowledgeState;
  readonly applicability: KnowledgeApplicability;
  readonly instructionOrigin: InstructionOrigin;
  readonly approval?: KnowledgeApproval;
  readonly lastVerification?: KnowledgeVerification;
  readonly supersedes: readonly string[];
  readonly title: string;
  readonly context: string;
  readonly lesson: string;
  readonly recommendedBehavior: string;
  readonly evidenceSummary: string;
  readonly evidence?: readonly PromotionEvidence[];
  readonly activation?: 'local' | 'merged-team-active';
  readonly mergedProvenance?: string;
}

export interface KnowledgeContentSource {
  readonly readFile: (path: string) => string | undefined;
  readonly listFiles: (prefix: string) => readonly string[];
}

export interface PublicationHooks {
  readonly beforePrimaryPublication?: () => void;
  readonly afterPrimaryRemoved?: () => void;
}

export interface RepositoryKnowledgeOptions extends PublicationHooks {
  readonly stateRoot?: string;
  readonly clock?: () => number;
  readonly wait?: (milliseconds: number) => void;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

export class RepositoryKnowledgeValidationError extends Error {
  readonly code = 'INVALID_REPOSITORY_KNOWLEDGE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RepositoryKnowledgeValidationError';
  }
}

const MAX_INDEX_BYTES = 1_048_576;
const MAX_MARKDOWN_BYTES = 65_536;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

export function readSharedKnowledge(repositoryRoot: string, options: RepositoryKnowledgeOptions = {}): SharedKnowledgeDocument[] {
  return withRepositoryKnowledgeLock(repositoryRoot, () => readSharedKnowledgeUnlocked(repositoryRoot, privatePaths(repositoryRoot, options)), options);
}

function readSharedKnowledgeUnlocked(repositoryRoot: string, paths: PrivatePaths): SharedKnowledgeDocument[] {
  const base = safeBase(repositoryRoot);
  assertNotSymlink(resolve(repositoryRoot));
  if (existsSync(base)) return readGeneration(repositoryRoot, base);
  recoverAbsentPrimary(repositoryRoot, base, paths);
  return existsSync(base) ? readGeneration(repositoryRoot, base) : [];
}

function readGeneration(repositoryRoot: string, base: string): SharedKnowledgeDocument[] {
  try {
    assertNoSymlinkPath(repositoryRoot, base);
    const source: KnowledgeContentSource = {
      readFile: (path) => {
        const target = safeChild(base, path);
        try { assertNotSymlink(target); return readFileSync(target, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== 'index.json') return undefined;
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            if (listMarkdownFiles(base, 'knowledge').length > 0) throw new Error('Orphan knowledge documents exist without an index.');
            throw new Error('Repository knowledge generation is unavailable.');
          }
          throw error;
        }
      },
      listFiles: (prefix) => listMarkdownFiles(base, prefix)
    };
    return readSharedKnowledgeContent(source);
  } catch (error) {
    if (error instanceof RepositoryKnowledgeValidationError) throw error;
    throw new RepositoryKnowledgeValidationError(`Invalid repository knowledge generation: ${errorMessage(error)}`, { cause: error });
  }
}

export function readSharedKnowledgeContent(source: KnowledgeContentSource): SharedKnowledgeDocument[] {
  const rawIndex = source.readFile('index.json');
  if (rawIndex === undefined) {
    if (source.listFiles('knowledge').some((path) => path.endsWith('.md'))) throw new Error('Orphan knowledge documents exist without an index.');
    return [];
  }
  if (Buffer.byteLength(rawIndex, 'utf8') > MAX_INDEX_BYTES) throw new RepositoryKnowledgeValidationError('Repository knowledge index resource limit exceeded.');
  let index;
  try { index = parseKnowledgeIndex(JSON.parse(rawIndex) as unknown); }
  catch (error) { throw new RepositoryKnowledgeValidationError(`Repository knowledge index is invalid: ${errorMessage(error)}`, { cause: error }); }
  assertDurableTextSafe(JSON.stringify(index));
  const expected = new Set(index.entries.map((entry) => `knowledge/${entry.identity}.md`));
  const actual = source.listFiles('knowledge').filter((path) => path.endsWith('.md'));
  const orphan = actual.find((path) => !expected.has(path));
  if (orphan) throw new Error(`Orphan knowledge document: ${orphan}.`);
  if (index.version === 1) return index.entries.map((entry) => {
    const path = `knowledge/${entry.identity}.md`;
    const rawMarkdown = source.readFile(path);
    if (rawMarkdown === undefined) throw new Error(`Missing knowledge document: ${path}.`);
    if (Buffer.byteLength(rawMarkdown, 'utf8') > MAX_MARKDOWN_BYTES) throw new RepositoryKnowledgeValidationError('Knowledge Markdown resource limit exceeded.');
    const markdown = normalizeLineEndings(rawMarkdown);
    const parsed = parseMarkdown(markdown, entry.identity, 1);
    return {
      identity: entry.identity, repositoryScope: 'repository:legacy', kind: entry.kind, state: entry.state,
      applicability: { paths: entry.applicability.path ? [entry.applicability.path] : [], tags: entry.applicability.tags, tools: entry.applicability.tool ? [entry.applicability.tool] : [] },
      instructionOrigin: 'code-tool-confirmed' as const, ...(entry.approval ? { approval: entry.approval } : {}),
      ...(entry.lastVerification ? { lastVerification: entry.lastVerification } : {}), supersedes: [], ...parsed
    };
  });
  return index.entries.map((entry) => {
    const rawMarkdown = source.readFile(entry.document);
    if (rawMarkdown === undefined) throw new Error(`Missing knowledge document: ${entry.document}.`);
    if (Buffer.byteLength(rawMarkdown, 'utf8') > MAX_MARKDOWN_BYTES) throw new RepositoryKnowledgeValidationError('Knowledge Markdown resource limit exceeded.');
    const markdown = normalizeLineEndings(rawMarkdown);
    if (contentHash(markdown) !== entry.contentHash) throw new Error(`Knowledge document content mismatch: ${entry.identity}.`);
    const parsed = parseMarkdown(markdown, entry.identity, 2);
    return { identity: entry.identity, repositoryScope: entry.repositoryScope, kind: entry.kind, state: entry.state, applicability: entry.applicability,
      instructionOrigin: entry.instructionOrigin, ...(entry.approval ? { approval: entry.approval } : {}),
      ...(entry.lastVerification ? { lastVerification: entry.lastVerification } : {}), supersedes: entry.supersedes, ...parsed };
  });
}

export function writeSharedKnowledge(repositoryRoot: string, documents: readonly SharedKnowledgeDocument[], options: RepositoryKnowledgeOptions = {}): void {
  withRepositoryKnowledgeLock(repositoryRoot, () => writeSharedKnowledgeUnlocked(repositoryRoot, documents, privatePaths(repositoryRoot, options), options), options);
}

export function updateSharedKnowledge(
  repositoryRoot: string,
  update: (documents: readonly SharedKnowledgeDocument[]) => readonly SharedKnowledgeDocument[],
  options: RepositoryKnowledgeOptions = {}
): SharedKnowledgeDocument[] {
  return withRepositoryKnowledgeLock(repositoryRoot, () => {
    const paths = privatePaths(repositoryRoot, options);
    const existing = readSharedKnowledgeUnlocked(repositoryRoot, paths);
    const updated = [...update(existing)];
    writeSharedKnowledgeUnlocked(repositoryRoot, updated, paths, options);
    return updated;
  }, options);
}

function writeSharedKnowledgeUnlocked(repositoryRoot: string, documents: readonly SharedKnowledgeDocument[], paths: PrivatePaths, hooks: PublicationHooks): void {
  const normalized = documents.map(validateAndNormalize).sort((a, b) => compare(a.identity, b.identity));
  const seen = new Set<string>();
  for (const document of normalized) {
    if (seen.has(document.identity)) throw new Error(`Duplicate knowledge identity: ${document.identity}.`);
    seen.add(document.identity);
  }
  for (const document of normalized) {
    if (document.supersedes.includes(document.identity)) throw new Error(`Knowledge ${document.identity} cannot supersede itself.`);
    const missing = document.supersedes.find((identity) => !seen.has(identity));
    if (missing) throw new Error(`Superseded knowledge ${missing} is missing from the complete generation.`);
  }
  const base = safeBase(repositoryRoot);
  mkdirSync(dirname(base), { recursive: true });
  if (existsSync(base)) readGeneration(repositoryRoot, base);
  else recoverAbsentPrimary(repositoryRoot, base, paths);
  const expectedGeneration = primaryFingerprint(base);
  const stage = join(paths.directory, `stage-${randomUUID()}`);
  try {
    mkdirSync(join(stage, 'knowledge'), { recursive: true, mode: 0o700 });
    const entries: KnowledgeIndexEntryV2[] = normalized.map((document) => {
      const content = renderMarkdown(document);
      writeFileSync(join(stage, 'knowledge', `${document.identity}.md`), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return toIndexEntry(document, content);
    });
    const index: KnowledgeIndexV2 = { version: 2, entries };
    writeFileSync(join(stage, 'index.json'), serializeKnowledgeIndex(index), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    readGeneration(repositoryRoot, stage);
    fsyncTree(stage);
    if (existsSync(base)) {
      replaceRecovery(repositoryRoot, base, paths);
    }
    hooks.beforePrimaryPublication?.();
    publishStage(repositoryRoot, base, stage, paths, expectedGeneration, hooks);
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

function validateAndNormalize(document: SharedKnowledgeDocument): SharedKnowledgeDocument {
  assertSafeExportValue(document);
  if (document.activation === 'merged-team-active') throw new Error('Branch-local repository writes cannot assert merged team activation.');
  if (document.mergedProvenance !== undefined) throw new Error('Branch-local repository writes cannot provide merged provenance.');
  assertIdentity(document.identity);
  for (const identity of document.supersedes) assertIdentity(identity);
  if (!document.repositoryScope.trim()) throw new Error('Repository scope is required.');
  for (const value of [document.title, document.context, document.lesson, document.recommendedBehavior, document.evidenceSummary]) {
    if (!value.trim()) throw new Error('Knowledge Markdown content must not be empty.');
  }
  assertSanitizedContent(document);
  assertDurableTextSafe(JSON.stringify({
    identity: document.identity,
    repositoryScope: document.repositoryScope,
    kind: document.kind,
    state: document.state,
    applicability: document.applicability,
    instructionOrigin: document.instructionOrigin,
    approval: document.approval,
    lastVerification: document.lastVerification,
    supersedes: document.supersedes
  }));
  return {
    ...document,
    applicability: { paths: unique(document.applicability.paths), tags: unique(document.applicability.tags), tools: unique(document.applicability.tools) },
    supersedes: unique(document.supersedes)
  };
}

function renderMarkdown(document: SharedKnowledgeDocument): string {
  return `<!-- knowledge-id: ${document.identity} -->\n# ${document.title}\n\n## Context\n\n${document.context}\n\n## Lesson\n\n${document.lesson}\n\n## Recommended behavior\n\n${document.recommendedBehavior}\n\n## Evidence summary\n\n${document.evidenceSummary}\n`;
}

function parseMarkdown(markdown: string, identity: string, version: 1 | 2): Pick<SharedKnowledgeDocument, 'title' | 'context' | 'lesson' | 'recommendedBehavior' | 'evidenceSummary'> {
  if (version === 2) {
    const marker = markdown.match(/^<!-- knowledge-id: ([A-Za-z0-9._-]+) -->\n/);
    if (!marker || marker[1] !== identity) throw new Error(`Markdown identity mismatch for ${identity}.`);
  }
  const body = version === 2 ? markdown.replace(/^<!--[^\n]+-->\n/, '') : markdown;
  const pattern = version === 2
    ? /^# ([^\n]+)\n\n## Context\n\n([\s\S]+?)\n\n## Lesson\n\n([\s\S]+?)\n\n## Recommended behavior\n\n([\s\S]+?)\n\n## Evidence summary\n\n([\s\S]+)\n$/
    : /^# ([^\n]+)\n\n## Context\n\n([\s\S]+?)\n\n## Recommended behavior\n\n([\s\S]+?)\n\n## Evidence summary\n\n([\s\S]+)\n$/;
  const match = body.match(pattern);
  if (!match) throw new Error(`Invalid knowledge Markdown section structure for ${identity}.`);
  const [title, context, lesson, recommendedBehavior, evidenceSummary] = version === 2
    ? [match[1], match[2], match[3], match[4], match[5]]
    : [match[1], match[2], match[1], match[3], match[4]];
  const sections = [context, lesson, recommendedBehavior, evidenceSummary];
  if (!title || title.length > 200 || sections.some((section) => !section || section.length > 8_192 || section !== section.trim() || /^#{1,6}(?:\s|$)/m.test(section))) {
    throw new Error(`Invalid or oversized knowledge Markdown content for ${identity}.`);
  }
  const parsed = { title, context: context!, lesson: lesson!, recommendedBehavior: recommendedBehavior!, evidenceSummary: evidenceSummary! };
  assertSafeExportValue(parsed);
  assertSanitizedContent(parsed);
  return parsed;
}

function toIndexEntry(document: SharedKnowledgeDocument, content: string): KnowledgeIndexEntryV2 {
  return { identity: document.identity, document: `knowledge/${document.identity}.md`, repositoryScope: document.repositoryScope,
    kind: document.kind, state: document.state, applicability: document.applicability, instructionOrigin: document.instructionOrigin,
    ...(document.approval ? { approval: document.approval } : {}), ...(document.lastVerification ? { lastVerification: document.lastVerification } : {}),
    supersedes: document.supersedes, contentHash: contentHash(content) };
}

function safeBase(repositoryRoot: string): string {
  const root = resolve(repositoryRoot);
  const base = resolve(root, 'agent-experience');
  if (relative(root, base).startsWith('..')) throw new Error('Repository knowledge path escapes repository root.');
  return base;
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

interface PrivatePaths {
  readonly directory: string;
  readonly lock: string;
  readonly recovery: string;
}

function privatePaths(repositoryRoot: string, options: RepositoryKnowledgeOptions): PrivatePaths {
  const canonical = realpathSync.native(resolve(repositoryRoot));
  const digest = createHash('sha256').update(canonical).digest('hex');
  const stateRoot = resolve(options.stateRoot ?? join(resolvePrivateDataDirectory(), 'repository-knowledge'));
  if (relative(canonical, stateRoot) === '' || !relative(canonical, stateRoot).startsWith('..')) {
    throw new Error('Repository knowledge private state must be outside the repository.');
  }
  const directory = join(stateRoot, digest);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return { directory, lock: join(directory, 'lock'), recovery: join(directory, 'recovery') };
}

export function withRepositoryKnowledgeLock<T>(repositoryRoot: string, action: () => T, options: RepositoryKnowledgeOptions = {}): T {
  const paths = privatePaths(repositoryRoot, options);
  const clock = options.clock ?? Date.now;
  const wait = options.wait ?? blockingWait;
  const timeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleAfter = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const started = clock();
  const token = randomUUID();
  while (true) {
    try {
      mkdirSync(paths.lock, { mode: 0o700 });
      writeFileSync(join(paths.lock, 'owner.json'), JSON.stringify({ pid: process.pid, timestamp: clock(), token }), { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      recoverStaleLock(paths.lock, clock(), staleAfter);
      if (clock() - started >= timeout) throw new Error('Timed out waiting for repository knowledge lock.');
      wait(Math.min(25, timeout));
    }
  }
  try {
    cleanupPrivateCandidates(paths);
    return action();
  }
  finally {
    try {
      const owner = JSON.parse(readFileSync(join(paths.lock, 'owner.json'), 'utf8')) as { token?: string };
      if (owner.token === token) rmSync(paths.lock, { recursive: true, force: true });
    } catch { /* Never remove a lock whose ownership cannot be verified. */ }
  }
}

function recoverStaleLock(lock: string, now: number, staleAfter: number): void {
  try {
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid?: number; timestamp?: number; token?: string };
    if (typeof owner.pid !== 'number' || typeof owner.timestamp !== 'number' || typeof owner.token !== 'string') return;
    if (now - owner.timestamp <= staleAfter || isPidAlive(owner.pid)) return;
    const confirmed = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid?: number; timestamp?: number; token?: string };
    if (confirmed.pid !== owner.pid || confirmed.timestamp !== owner.timestamp || confirmed.token !== owner.token || isPidAlive(owner.pid)) return;
    const stale = `${lock}.stale-${owner.token}`;
    renameSync(lock, stale);
    rmSync(stale, { recursive: true, force: true });
  } catch { /* A live or concurrently changing owner remains untouched. */ }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function blockingWait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, milliseconds));
}

function recoverAbsentPrimary(repositoryRoot: string, base: string, paths: PrivatePaths): void {
  if (existsSync(base)) return;
  if (!existsSync(paths.recovery)) return;
  readGeneration(repositoryRoot, paths.recovery);
  const stage = join(paths.directory, `stage-recovery-${randomUUID()}`);
  try {
    cpSync(paths.recovery, stage, { recursive: true, errorOnExist: true });
    securePrivateTree(stage);
    readGeneration(repositoryRoot, stage);
    fsyncTree(stage);
    publishRename(stage, base);
    readGeneration(repositoryRoot, base);
    fsyncTree(base);
    fsyncDirectory(dirname(base));
  } catch (error) {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
    throw error;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

function replaceRecovery(repositoryRoot: string, base: string, paths: PrivatePaths): void {
  readGeneration(repositoryRoot, base);
  const candidate = join(paths.directory, `recovery-${randomUUID()}`);
  try {
    cpSync(base, candidate, { recursive: true, errorOnExist: true });
    securePrivateTree(candidate);
    readGeneration(repositoryRoot, candidate);
    fsyncTree(candidate);
    if (existsSync(paths.recovery)) rmSync(paths.recovery, { recursive: true, force: true });
    renameSync(candidate, paths.recovery);
    fsyncDirectory(paths.directory);
  } finally {
    if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
  }
}

function publishStage(repositoryRoot: string, base: string, stage: string, paths: PrivatePaths, expectedGeneration: string, hooks: PublicationHooks): void {
  try {
    if (primaryFingerprint(base) !== expectedGeneration) throw new Error('Repository knowledge changed during locked publication.');
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
    hooks.afterPrimaryRemoved?.();
    publishRename(stage, base);
    readGeneration(repositoryRoot, base);
    fsyncTree(base);
    fsyncDirectory(dirname(base));
  } catch (error) {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
    if (existsSync(paths.recovery)) {
      const rollback = join(paths.directory, `stage-rollback-${randomUUID()}`);
      try {
        cpSync(paths.recovery, rollback, { recursive: true, errorOnExist: true });
        securePrivateTree(rollback);
        readGeneration(repositoryRoot, rollback);
        fsyncTree(rollback);
        publishRename(rollback, base);
        readGeneration(repositoryRoot, base);
        fsyncTree(base);
      } finally {
        if (existsSync(rollback)) rmSync(rollback, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function publishRename(stage: string, primary: string): void {
  try { renameSync(stage, primary); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new Error('Repository knowledge private state must share a filesystem with the repository for atomic publication.', { cause: error });
    }
    throw error;
  }
}

function cleanupPrivateCandidates(paths: PrivatePaths): void {
  for (const entry of readdirSync(paths.directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name.startsWith('stage-') || entry.name.startsWith('recovery-'))) {
      rmSync(join(paths.directory, entry.name), { recursive: true, force: true });
    }
  }
}

function securePrivateTree(directory: string): void {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) securePrivateTree(path);
    else if (entry.isFile()) chmodSync(path, 0o600);
  }
}

function primaryFingerprint(base: string): string {
  if (!existsSync(base)) return 'absent';
  const hash = createHash('sha256');
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name))) {
      if (entry.isSymbolicLink()) throw new RepositoryKnowledgeValidationError('Repository knowledge contains a symlink.');
      const path = join(directory, entry.name);
      hash.update(relative(base, path)).update('\0');
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
    }
  };
  visit(base);
  return hash.digest('hex');
}

function fsyncTree(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) fsyncTree(path);
    else if (entry.isFile()) fsyncPath(path);
  }
  fsyncDirectory(directory);
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

function assertSanitizedContent(value: Pick<SharedKnowledgeDocument, 'title' | 'context' | 'lesson' | 'recommendedBehavior' | 'evidenceSummary'>): void {
  assertDurableTextSafe([value.title, value.context, value.lesson, value.recommendedBehavior, value.evidenceSummary].join('\n'));
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown validation error';
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}
