import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { KnowledgeState, LessonKind } from '../domain/types.js';
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
  /** Observes the portable swap window. Readers must resolve the stable backup here. */
  readonly afterCurrentMovedToBackup?: () => void;
}

export function readSharedKnowledge(repositoryRoot: string): SharedKnowledgeDocument[] {
  const base = safeBase(repositoryRoot);
  const backup = backupPath(repositoryRoot);
  assertNotSymlink(resolve(repositoryRoot));
  if (!existsSync(base) && existsSync(backup)) return readGeneration(repositoryRoot, backup);
  if (!existsSync(base)) return [];
  try {
    return readGeneration(repositoryRoot, base);
  } catch (primaryError) {
    if (existsSync(backup)) {
      try { return readGeneration(repositoryRoot, backup); } catch { /* Report the primary generation error. */ }
    }
    throw primaryError;
  }
}

function readGeneration(repositoryRoot: string, base: string): SharedKnowledgeDocument[] {
  assertNoSymlinkPath(repositoryRoot, base);
  const source: KnowledgeContentSource = {
    readFile: (path) => {
      const target = safeChild(base, path);
      try { assertNotSymlink(target); return readFileSync(target, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== 'index.json') return undefined;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (listMarkdownFiles(base, 'knowledge').length > 0) throw new Error('Orphan knowledge documents exist without an index.');
          throw new Error('Repository knowledge generation is temporarily unavailable.');
        }
        throw error;
      }
    },
    listFiles: (prefix) => listMarkdownFiles(base, prefix)
  };
  return readSharedKnowledgeContent(source);
}

export function readSharedKnowledgeContent(source: KnowledgeContentSource): SharedKnowledgeDocument[] {
  const rawIndex = source.readFile('index.json');
  if (rawIndex === undefined) {
    if (source.listFiles('knowledge').some((path) => path.endsWith('.md'))) throw new Error('Orphan knowledge documents exist without an index.');
    return [];
  }
  const index = parseKnowledgeIndex(JSON.parse(rawIndex) as unknown);
  const expected = new Set(index.entries.map((entry) => `knowledge/${entry.identity}.md`));
  const actual = source.listFiles('knowledge').filter((path) => path.endsWith('.md'));
  const orphan = actual.find((path) => !expected.has(path));
  if (orphan) throw new Error(`Orphan knowledge document: ${orphan}.`);
  if (index.version === 1) return index.entries.map((entry) => {
    const path = `knowledge/${entry.identity}.md`;
    const markdown = source.readFile(path);
    if (markdown === undefined) throw new Error(`Missing knowledge document: ${path}.`);
    const parsed = parseMarkdown(markdown, entry.identity, 1);
    return {
      identity: entry.identity, repositoryScope: 'repository:legacy', kind: entry.kind, state: entry.state,
      applicability: { paths: entry.applicability.path ? [entry.applicability.path] : [], tags: entry.applicability.tags, tools: entry.applicability.tool ? [entry.applicability.tool] : [] },
      instructionOrigin: 'code-tool-confirmed' as const, ...(entry.approval ? { approval: entry.approval } : {}),
      ...(entry.lastVerification ? { lastVerification: entry.lastVerification } : {}), supersedes: [], ...parsed
    };
  });
  return index.entries.map((entry) => {
    const markdown = source.readFile(entry.document);
    if (markdown === undefined) throw new Error(`Missing knowledge document: ${entry.document}.`);
    if (contentHash(markdown) !== entry.contentHash) throw new Error(`Knowledge document content mismatch: ${entry.identity}.`);
    const parsed = parseMarkdown(markdown, entry.identity, 2);
    return { identity: entry.identity, repositoryScope: entry.repositoryScope, kind: entry.kind, state: entry.state, applicability: entry.applicability,
      instructionOrigin: entry.instructionOrigin, ...(entry.approval ? { approval: entry.approval } : {}),
      ...(entry.lastVerification ? { lastVerification: entry.lastVerification } : {}), supersedes: entry.supersedes, ...parsed };
  });
}

export function writeSharedKnowledge(repositoryRoot: string, documents: readonly SharedKnowledgeDocument[], hooks: PublicationHooks = {}): void {
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
  const stage = stagePath(repositoryRoot);
  const backup = backupPath(repositoryRoot);
  recoverInterruptedPublication(repositoryRoot, base, backup, stage);
  let backedUp = false;
  try {
    mkdirSync(join(stage, 'knowledge'), { recursive: true, mode: 0o755 });
    const entries: KnowledgeIndexEntryV2[] = normalized.map((document) => {
      const content = renderMarkdown(document);
      writeFileSync(join(stage, 'knowledge', `${document.identity}.md`), content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
      return toIndexEntry(document, content);
    });
    const index: KnowledgeIndexV2 = { version: 2, entries };
    writeFileSync(join(stage, 'index.json'), serializeKnowledgeIndex(index), { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    readGeneration(repositoryRoot, stage);
    if (existsSync(base)) { renameSync(base, backup); backedUp = true; }
    hooks.afterCurrentMovedToBackup?.();
    renameSync(stage, base);
    if (backedUp) {
      try { rmSync(backup, { recursive: true, force: true }); } catch { /* A complete prior backup is safe to retain. */ }
      backedUp = false;
    }
  } catch (error) {
    if (backedUp && existsSync(backup)) {
      if (existsSync(base)) rmSync(base, { recursive: true, force: true });
      renameSync(backup, base);
      backedUp = false;
    }
    throw error;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    if (backedUp && !existsSync(base)) renameSync(backup, base);
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

function backupPath(repositoryRoot: string): string {
  return resolve(repositoryRoot, '.agent-experience-backup');
}

function stagePath(repositoryRoot: string): string {
  return resolve(repositoryRoot, '.agent-experience-stage');
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

/**
 * Completes the portable publication protocol after an interrupted process.
 * Directory rename is not claimed as an atomic exchange. The stable backup lets
 * readers obtain the old complete generation while the primary name is absent.
 */
function recoverInterruptedPublication(repositoryRoot: string, base: string, backup: string, stage: string): void {
  assertNotSymlink(resolve(repositoryRoot));
  for (const path of [base, backup, stage]) if (existsSync(path)) assertNotSymlink(path);
  if (existsSync(base)) {
    try {
      readGeneration(repositoryRoot, base);
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    } catch (primaryError) {
      if (!existsSync(backup)) throw primaryError;
      readGeneration(repositoryRoot, backup);
      rmSync(base, { recursive: true, force: true });
      renameSync(backup, base);
    }
  } else if (existsSync(backup)) {
    readGeneration(repositoryRoot, backup);
    renameSync(backup, base);
  }
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
}

function assertSanitizedContent(value: Pick<SharedKnowledgeDocument, 'title' | 'context' | 'lesson' | 'recommendedBehavior' | 'evidenceSummary'>): void {
  const content = [value.title, value.context, value.lesson, value.recommendedBehavior, value.evidenceSummary].join('\n');
  if (/\b(?:raw\s+(?:event|transcript)|transcript\s*:|private\s+(?:review|reviewer)|local\s+database\s+id|localDatabaseId\s*:|sessionId\s*:|eventId\s*:)/i.test(content)) {
    throw new Error('Repository knowledge content must be sanitized and must not contain raw, private, or local database data.');
  }
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
