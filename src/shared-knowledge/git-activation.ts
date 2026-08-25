import { readSharedKnowledge, readSharedKnowledgeContent, type KnowledgeContentSource, type RepositoryKnowledgeOptions, type SharedKnowledgeDocument } from './repository.js';

export interface GitContentAdapter {
  readonly resolveCommit: (trustedRef: string) => string;
  readonly readFile: (commit: string, path: string) => string | undefined;
  readonly listFiles: (commit: string, prefix: string) => readonly string[];
}

export interface ActivatedKnowledgeEntry {
  readonly document: SharedKnowledgeDocument;
  readonly authoritative: boolean;
  readonly provenance: {
    readonly source: 'trusted-ref' | 'working-tree';
    readonly commit?: string;
  };
}

export interface ActivatedKnowledge {
  readonly trustedCommit?: string;
  readonly entries: readonly ActivatedKnowledgeEntry[];
}

export function activateGitKnowledge(repositoryRoot: string, git: GitContentAdapter, trustedRef?: string, options: RepositoryKnowledgeOptions = {}): ActivatedKnowledge {
  const local = readSharedKnowledge(repositoryRoot, options);
  if (!trustedRef) {
    return { entries: local.map((document) => ({ document, authoritative: false, provenance: { source: 'working-tree' } })) };
  }
  const trustedCommit = git.resolveCommit(trustedRef);
  if (!/^[a-f0-9]{40,64}$/i.test(trustedCommit)) throw new Error('Trusted Git ref did not resolve to a commit identity.');
  const source: KnowledgeContentSource = {
    readFile: (path) => git.readFile(trustedCommit, `agent-experience/${path}`),
    listFiles: (prefix) => git.listFiles(trustedCommit, `agent-experience/${prefix}`)
      .map((path) => path.startsWith('agent-experience/') ? path.slice('agent-experience/'.length) : path)
  };
  const trusted = readSharedKnowledgeContent(source);
  const trustedIdentities = new Set(trusted.map((document) => document.identity));
  const entries: ActivatedKnowledgeEntry[] = [
    ...trusted.map((document) => ({ document, authoritative: true as const, provenance: { source: 'trusted-ref' as const, commit: trustedCommit } })),
    ...local.filter((document) => !trustedIdentities.has(document.identity))
      .map((document) => ({ document, authoritative: false as const, provenance: { source: 'working-tree' as const } }))
  ];
  entries.sort((left, right) => left.document.identity < right.document.identity ? -1 : left.document.identity > right.document.identity ? 1 : 0);
  return { trustedCommit, entries };
}
