import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { KnowledgeEntry, KnowledgeState, LessonKind } from '../domain/types.js';

export interface RepositoryKnowledgeDocument {
  readonly entry: KnowledgeEntry;
  readonly kind: LessonKind;
  readonly context: string;
  readonly recommendedBehavior: string;
  readonly evidenceSummary: string;
  readonly applicability: {
    readonly path?: string;
    readonly tags?: readonly string[];
    readonly tool?: string;
  };
  readonly lastVerification?: { readonly at: string; readonly by?: string };
  readonly approval?: { readonly at: string; readonly kind: 'system' | 'user' };
  readonly activation?: 'local' | 'merged-team-active';
  readonly mergedProvenance?: string;
}

interface RepositoryIndexEntry {
  readonly applicability: { readonly path?: string; readonly tags: readonly string[]; readonly tool?: string };
  readonly approval?: { readonly at: string; readonly kind: 'system' | 'user' };
  readonly identity: string;
  readonly kind: LessonKind;
  readonly lastVerification?: { readonly at: string; readonly by?: string };
  readonly mergedProvenance?: string;
  readonly state: KnowledgeState;
}

interface RepositoryIndex {
  readonly entries: readonly RepositoryIndexEntry[];
  readonly version: 1;
}

const safeFilename = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function writeRepositoryKnowledge(repositoryRoot: string, document: RepositoryKnowledgeDocument): void {
  validateDocument(document);
  const output = outputPaths(repositoryRoot, document.entry.id);
  ensureDirectory(output.root);
  ensureDirectory(output.knowledge);

  const index = readIndex(output.index);
  const entry = toIndexEntry(document);
  const entries = [...index.entries.filter((item) => item.identity !== entry.identity), entry]
    .sort((left, right) => left.identity.localeCompare(right.identity));
  atomicWrite(output.entry, markdown(document));
  atomicWrite(output.index, `${JSON.stringify(sortObject({ entries, version: 1 }), null, 2)}\n`);
}

function validateDocument(document: RepositoryKnowledgeDocument): void {
  if (!safeFilename.test(document.entry.id) || document.entry.id === '.' || document.entry.id === '..') {
    throw new Error('Knowledge identifier must be a safe filename.');
  }
  if (document.activation === 'merged-team-active' && !document.mergedProvenance?.trim()) {
    throw new Error('Merged team activation requires merged provenance.');
  }
  for (const value of [document.context, document.entry.statement, document.recommendedBehavior, document.evidenceSummary]) {
    if (!value.trim()) throw new Error('Repository knowledge document text must not be empty.');
  }
}

function outputPaths(repositoryRoot: string, knowledgeId: string): { root: string; knowledge: string; index: string; entry: string } {
  const root = resolve(repositoryRoot, 'agent-experience');
  const knowledge = resolve(root, 'knowledge');
  const index = resolve(root, 'index.json');
  const entry = resolve(knowledge, `${knowledgeId}.md`);
  for (const path of [root, knowledge, index, entry]) {
    if (relative(resolve(repositoryRoot), path).startsWith('..')) throw new Error('Repository knowledge output escapes the selected repository root.');
  }
  return { root, knowledge, index, entry };
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o755 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Repository knowledge output directory is unsafe.');
}

function readIndex(path: string): RepositoryIndex {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RepositoryIndex;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Invalid repository knowledge index.');
    return { version: 1, entries: parsed.entries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
    throw error;
  }
}

function toIndexEntry(document: RepositoryKnowledgeDocument): RepositoryIndexEntry {
  return {
    applicability: {
      ...(document.applicability.path ? { path: document.applicability.path } : {}),
      tags: [...new Set(document.applicability.tags ?? [])].sort(),
      ...(document.applicability.tool ? { tool: document.applicability.tool } : {})
    },
    ...(document.approval ? { approval: { ...document.approval } } : {}),
    identity: document.entry.id,
    kind: document.kind,
    ...(document.lastVerification ? { lastVerification: { ...document.lastVerification } } : {}),
    ...(document.mergedProvenance ? { mergedProvenance: document.mergedProvenance } : {}),
    state: document.entry.state
  };
}

function markdown(document: RepositoryKnowledgeDocument): string {
  return `# ${document.entry.statement}\n\n## Context\n\n${document.context}\n\n## Recommended behavior\n\n${document.recommendedBehavior}\n\n## Evidence summary\n\n${document.evidenceSummary}\n`;
}

function atomicWrite(path: string, content: string): void {
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  renameSync(temporary, path);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, sortObject(nested)]));
}
