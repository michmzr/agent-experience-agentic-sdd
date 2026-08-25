import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { KnowledgeState, LessonKind } from '../domain/types.js';
import { assertDurableTextSafe } from '../review/sanitizer.js';
import { assertPublicationDevice, cleanupPrivateCandidates, createLocalGenerationSource, fsyncDirectory, fsyncTree, generationFingerprint, MAX_INDEX_BYTES, MAX_MARKDOWN_BYTES, publishRename, RepositoryKnowledgeConfigurationError, RepositoryKnowledgeValidationError, resolvePrivateGenerationPaths, safeGenerationBase, securePrivateTree, type PrivateGenerationPaths } from './generation-store.js';
import { withRepositoryLock } from './repository-lock.js';
import { assertIdentity, assertSafeExportValue, compare, contentHash, parseKnowledgeIndex, parseRuntimeDirective, serializeKnowledgeIndex, type InstructionOrigin, type KnowledgeApplicability, type KnowledgeApproval, type KnowledgeIndexEntryV3, type KnowledgeIndexV3, type KnowledgeVerification, type RuntimeDirective } from './schema.js';

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
  readonly runtimeDirective?: RuntimeDirective;
  readonly activation?: 'local' | 'merged-team-active';
  readonly mergedProvenance?: string;
}

export interface KnowledgeContentSource {
  readonly readFile: (path: string, maxBytes?: number) => string | undefined;
  readonly listFiles: (prefix: string) => readonly string[];
}

export interface PublicationHooks {
  readonly beforePrimaryPublication?: () => void;
  readonly afterPrimaryRemoved?: () => void;
  readonly afterPrimaryPublished?: () => void;
}

export interface RepositoryKnowledgeOptions extends PublicationHooks {
  readonly stateRoot?: string;
  readonly clock?: () => number;
  readonly wait?: (milliseconds: number) => void;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly afterLockCandidatePrepared?: (candidate: string) => void;
  readonly deviceStat?: (path: string) => number | bigint;
}

export { RepositoryKnowledgeConfigurationError, RepositoryKnowledgeValidationError } from './generation-store.js';

export class RepositoryKnowledgeConflictError extends Error {
  readonly code = 'REPOSITORY_KNOWLEDGE_CONFLICT';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RepositoryKnowledgeConflictError';
  }
}

export function readSharedKnowledge(repositoryRoot: string, options: RepositoryKnowledgeOptions = {}): SharedKnowledgeDocument[] {
  return withRepositoryKnowledgeLock(repositoryRoot, () => readSharedKnowledgeUnlocked(repositoryRoot, privatePaths(repositoryRoot, options), options), options);
}

function readSharedKnowledgeUnlocked(repositoryRoot: string, paths: PrivatePaths, options: RepositoryKnowledgeOptions): SharedKnowledgeDocument[] {
  const base = safeGenerationBase(repositoryRoot);
  if (existsSync(base)) return readGeneration(repositoryRoot, base);
  recoverAbsentPrimary(repositoryRoot, base, paths, options);
  return existsSync(base) ? readGeneration(repositoryRoot, base) : [];
}

function readGeneration(repositoryRoot: string, base: string): SharedKnowledgeDocument[] {
  try {
    const source: KnowledgeContentSource = createLocalGenerationSource(repositoryRoot, base);
    return readSharedKnowledgeContent(source);
  } catch (error) {
    if (error instanceof RepositoryKnowledgeValidationError) throw error;
    throw new RepositoryKnowledgeValidationError(`Invalid repository knowledge generation: ${errorMessage(error)}`, { cause: error });
  }
}

export function readSharedKnowledgeContent(source: KnowledgeContentSource): SharedKnowledgeDocument[] {
  const allPaths = source.listFiles('');
  if (allPaths.length > 1_002) throw new RepositoryKnowledgeValidationError('Repository knowledge generation path limit exceeded.');
  if (new Set(allPaths).size !== allPaths.length) throw new RepositoryKnowledgeValidationError('Repository knowledge generation contains duplicate paths.');
  for (const path of allPaths) {
    if (Buffer.byteLength(path, 'utf8') > 512) throw new RepositoryKnowledgeValidationError('Repository knowledge generation path-length limit exceeded.');
    if (path === 'index.json' || /^knowledge\/[^/]+\.md$/.test(path)) continue;
    throw new RepositoryKnowledgeValidationError('Repository knowledge generation contains an unrecognized path or nesting.');
  }
  const rawIndex = source.readFile('index.json', MAX_INDEX_BYTES);
  if (rawIndex === undefined) {
    if (source.listFiles('knowledge').some((path) => path.endsWith('.md'))) throw new Error('Orphan knowledge documents exist without an index.');
    return [];
  }
  if (!allPaths.includes('index.json')) throw new RepositoryKnowledgeValidationError('Repository knowledge index listing is inconsistent.');
  if (Buffer.byteLength(rawIndex, 'utf8') > MAX_INDEX_BYTES) throw new RepositoryKnowledgeValidationError('Repository knowledge index resource limit exceeded.');
  let index;
  try { index = parseKnowledgeIndex(JSON.parse(rawIndex) as unknown); }
  catch (error) { throw new RepositoryKnowledgeValidationError(`Repository knowledge index is invalid: ${errorMessage(error)}`, { cause: error }); }
  assertDurableTextSafe(JSON.stringify(index));
  const expected = new Set(index.entries.map((entry) => `knowledge/${entry.identity}.md`));
  const actual = allPaths.filter((path) => path.startsWith('knowledge/') && path.endsWith('.md'));
  const orphan = actual.find((path) => !expected.has(path));
  if (orphan) throw new Error(`Orphan knowledge document: ${orphan}.`);
  if (index.version === 1) return index.entries.map((entry) => {
    const path = `knowledge/${entry.identity}.md`;
    const rawMarkdown = source.readFile(path, MAX_MARKDOWN_BYTES);
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
    const rawMarkdown = source.readFile(entry.document, MAX_MARKDOWN_BYTES);
    if (rawMarkdown === undefined) throw new Error(`Missing knowledge document: ${entry.document}.`);
    if (Buffer.byteLength(rawMarkdown, 'utf8') > MAX_MARKDOWN_BYTES) throw new RepositoryKnowledgeValidationError('Knowledge Markdown resource limit exceeded.');
    const markdown = normalizeLineEndings(rawMarkdown);
    if (contentHash(markdown) !== entry.contentHash) throw new Error(`Knowledge document content mismatch: ${entry.identity}.`);
    const parsed = parseMarkdown(markdown, entry.identity, 2);
    return { identity: entry.identity, repositoryScope: entry.repositoryScope, kind: entry.kind, state: entry.state, applicability: entry.applicability,
      instructionOrigin: entry.instructionOrigin, ...(entry.approval ? { approval: entry.approval } : {}),
      ...(entry.lastVerification ? { lastVerification: entry.lastVerification } : {}), supersedes: entry.supersedes,
      ...('runtimeDirective' in entry && entry.runtimeDirective !== undefined ? { runtimeDirective: entry.runtimeDirective } : {}), ...parsed };
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
    const existing = readSharedKnowledgeUnlocked(repositoryRoot, paths, options);
    const updated = [...update(existing)];
    writeSharedKnowledgeUnlocked(repositoryRoot, updated, paths, options);
    return updated;
  }, options);
}

function writeSharedKnowledgeUnlocked(repositoryRoot: string, documents: readonly SharedKnowledgeDocument[], paths: PrivatePaths, hooks: RepositoryKnowledgeOptions): void {
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
  const base = safeGenerationBase(repositoryRoot);
  mkdirSync(dirname(base), { recursive: true });
  if (existsSync(base)) readGeneration(repositoryRoot, base);
  else recoverAbsentPrimary(repositoryRoot, base, paths, hooks);
  const expectedGeneration = generationFingerprint(base);
  const stage = join(paths.directory, `stage-${randomUUID()}`);
  try {
    mkdirSync(join(stage, 'knowledge'), { recursive: true, mode: 0o700 });
    const entries: KnowledgeIndexEntryV3[] = normalized.map((document) => {
      const content = renderMarkdown(document);
      writeFileSync(join(stage, 'knowledge', `${document.identity}.md`), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return toIndexEntry(document, content);
    });
    const index: KnowledgeIndexV3 = { version: 3, entries };
    writeFileSync(join(stage, 'index.json'), serializeKnowledgeIndex(index), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    readGeneration(repositoryRoot, stage);
    fsyncTree(stage);
    assertPublicationDevice(dirname(base), stage, hooks.deviceStat);
    const expectedPublishedGeneration = generationFingerprint(stage);
    if (existsSync(base)) {
      replaceRecovery(repositoryRoot, base, paths);
    }
    hooks.beforePrimaryPublication?.();
    publishStage(repositoryRoot, base, stage, paths, expectedGeneration, expectedPublishedGeneration, hooks);
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
  const runtimeDirective = document.runtimeDirective === undefined ? undefined : parseRuntimeDirective(document.runtimeDirective);
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
    supersedes: unique(document.supersedes),
    ...(runtimeDirective === undefined ? {} : { runtimeDirective })
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

function toIndexEntry(document: SharedKnowledgeDocument, content: string): KnowledgeIndexEntryV3 {
  return { identity: document.identity, document: `knowledge/${document.identity}.md`, repositoryScope: document.repositoryScope,
    kind: document.kind, state: document.state, applicability: document.applicability, instructionOrigin: document.instructionOrigin,
    ...(document.approval ? { approval: document.approval } : {}), ...(document.lastVerification ? { lastVerification: document.lastVerification } : {}),
    supersedes: document.supersedes, contentHash: contentHash(content),
    ...(document.runtimeDirective === undefined ? {} : { runtimeDirective: document.runtimeDirective }) };
}

type PrivatePaths = PrivateGenerationPaths;

function privatePaths(repositoryRoot: string, options: RepositoryKnowledgeOptions): PrivatePaths {
  return resolvePrivateGenerationPaths(repositoryRoot, options.stateRoot);
}

export function withRepositoryKnowledgeLock<T>(repositoryRoot: string, action: () => T, options: RepositoryKnowledgeOptions = {}): T {
  const paths = privatePaths(repositoryRoot, options);
  return withRepositoryLock(repositoryRoot, () => {
    cleanupPrivateCandidates(paths);
    return action();
  }, options);
}

function recoverAbsentPrimary(repositoryRoot: string, base: string, paths: PrivatePaths, options: RepositoryKnowledgeOptions): void {
  if (existsSync(base)) return;
  if (!existsSync(paths.recovery)) return;
  readGeneration(repositoryRoot, paths.recovery);
  const stage = join(paths.directory, `stage-recovery-${randomUUID()}`);
  let stagePublished = false;
  let expectedPublishedGeneration = '';
  try {
    cpSync(paths.recovery, stage, { recursive: true, errorOnExist: true });
    securePrivateTree(stage);
    readGeneration(repositoryRoot, stage);
    fsyncTree(stage);
    assertPublicationDevice(dirname(base), stage, options.deviceStat);
    expectedPublishedGeneration = generationFingerprint(stage);
    publishRename(stage, base);
    stagePublished = true;
    options.afterPrimaryPublished?.();
    readGeneration(repositoryRoot, base);
    fsyncTree(base);
    fsyncDirectory(dirname(base));
  } catch (error) {
    if (stagePublished) {
      let stillOwned = false;
      try { stillOwned = generationFingerprint(base) === expectedPublishedGeneration; }
      catch { /* Post-publication changes are preserved rather than treated as recovery output. */ }
      if (!stillOwned) throw new RepositoryKnowledgeConflictError('Repository knowledge changed after publication; rollback was not applied.', { cause: error });
      if (existsSync(base)) rmSync(base, { recursive: true, force: true });
      fsyncDirectory(dirname(base));
    }
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

function publishStage(repositoryRoot: string, base: string, stage: string, paths: PrivatePaths, expectedGeneration: string, expectedPublishedGeneration: string, hooks: PublicationHooks): void {
  let primaryRemovedByThisPublication = false;
  let stagePublishedByThisPublication = false;
  try {
    if (generationFingerprint(base) !== expectedGeneration) throw new Error('Repository knowledge changed during locked publication.');
    if (existsSync(base)) {
      rmSync(base, { recursive: true, force: true });
      primaryRemovedByThisPublication = true;
    }
    hooks.afterPrimaryRemoved?.();
    publishRename(stage, base);
    stagePublishedByThisPublication = true;
    hooks.afterPrimaryPublished?.();
    readGeneration(repositoryRoot, base);
    fsyncTree(base);
    fsyncDirectory(dirname(base));
  } catch (error) {
    if (!primaryRemovedByThisPublication && !stagePublishedByThisPublication) throw error;
    if (stagePublishedByThisPublication) {
      let stillOwned = false;
      try { stillOwned = generationFingerprint(base) === expectedPublishedGeneration; }
      catch { /* Invalid or unrecognized post-publication bytes are not owned by this publication. */ }
      if (!stillOwned) {
        throw new RepositoryKnowledgeConflictError('Repository knowledge changed after publication; rollback was not applied.', { cause: error });
      }
      if (existsSync(base)) rmSync(base, { recursive: true, force: true });
    }
    if (primaryRemovedByThisPublication && existsSync(paths.recovery)) {
      const rollback = join(paths.directory, `stage-rollback-${randomUUID()}`);
      try {
        cpSync(paths.recovery, rollback, { recursive: true, errorOnExist: true });
        securePrivateTree(rollback);
        readGeneration(repositoryRoot, rollback);
        fsyncTree(rollback);
        publishRename(rollback, base);
        readGeneration(repositoryRoot, base);
        fsyncTree(base);
        fsyncDirectory(dirname(base));
      } finally {
        if (existsSync(rollback)) rmSync(rollback, { recursive: true, force: true });
      }
    }
    throw error;
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}
