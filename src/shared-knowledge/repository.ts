import { randomUUID } from 'node:crypto';
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

export function readSharedKnowledge(repositoryRoot: string): SharedKnowledgeDocument[] {
  const base = safeBase(repositoryRoot);
  assertNoSymlinkPath(repositoryRoot, base);
  const source: KnowledgeContentSource = {
    readFile: (path) => {
      const target = safeChild(base, path);
      try { assertNotSymlink(target); return readFileSync(target, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
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

export function writeSharedKnowledge(repositoryRoot: string, documents: readonly SharedKnowledgeDocument[]): void {
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
  assertNoSymlinkPath(repositoryRoot, base);
  mkdirSync(dirname(base), { recursive: true });
  const stageContainer = resolve(dirname(base), `.agent-experience-stage-${randomUUID()}`);
  const stage = resolve(stageContainer, 'agent-experience');
  const backup = resolve(dirname(base), `.agent-experience-backup-${randomUUID()}`);
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
    readSharedKnowledge(stageContainer);
    if (existsSync(base)) { renameSync(base, backup); backedUp = true; }
    try { renameSync(stage, base); }
    catch (error) { if (backedUp) { renameSync(backup, base); backedUp = false; } throw error; }
    if (backedUp) {
      try { rmSync(backup, { recursive: true, force: true }); } catch { /* A complete prior backup is safe to retain. */ }
      backedUp = false;
    }
  } finally {
    if (existsSync(stageContainer)) rmSync(stageContainer, { recursive: true, force: true });
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
  if (/\b(?:raw\s+(?:event|transcript)|transcript\s*:|private\s+review|sessionId\s*:|eventId\s*:)/i.test(document.evidenceSummary)) {
    throw new Error('Evidence summary must be sanitized and must not contain raw or private local data.');
  }
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
  const title = body.match(/^# ([^\n]+)\n/)?.[1];
  const section = (name: string, next?: string): string | undefined => {
    const tail = next ? `(?=\n\n## ${escapeRegExp(next)}\n|$)` : '$';
    return body.match(new RegExp(`## ${escapeRegExp(name)}\\n\\n([\\s\\S]*?)${tail}`))?.[1]?.trim();
  };
  const context = section('Context', version === 2 ? 'Lesson' : 'Recommended behavior');
  const lesson = version === 2 ? section('Lesson', 'Recommended behavior') : title;
  const recommendedBehavior = section('Recommended behavior', 'Evidence summary');
  const evidenceSummary = section('Evidence summary');
  if (!title || !context || !lesson || !recommendedBehavior || !evidenceSummary) throw new Error(`Invalid knowledge Markdown content for ${identity}.`);
  assertSafeExportValue({ title, context, lesson, recommendedBehavior, evidenceSummary });
  return { title, context, lesson, recommendedBehavior, evidenceSummary };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
