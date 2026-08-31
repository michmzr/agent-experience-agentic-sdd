import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { verifyInstalledHooks } from '../cli/hook-installation.js';

import { ingestPassiveHook, type HookIngressResult } from '../capture/hook-ingress.js';
import type { PassiveHookSource } from '../capture/hook-adapters/contracts.js';
import type { ExperienceImport, KnowledgeEntry, KnowledgeState } from '../domain/types.js';
import { validateImport } from '../domain/validation.js';
import { defaultDatabasePath } from '../storage/database.js';
import { ExperienceStore, type KnowledgeScope, type RetrievalFilter, type RetrievedKnowledgeEntry } from '../storage/experience-store.js';
import {
  RuntimeService,
  type BuiltInRuntimeProfileId,
  type KnowledgeValidationResult,
  type PublicGateDecision
} from './runtime-service.js';

export interface LessonFilter {
  readonly scope?: KnowledgeScope;
  readonly repositoryId?: string;
  readonly state?: KnowledgeState;
  readonly tag?: string;
}

export interface ExperienceServiceOptions {
  readonly dataDir?: string;
}

export class ExperienceService {
  private readonly databasePath: string;
  private readonly runtime: RuntimeService;

  constructor(options: ExperienceServiceOptions = {}) {
    this.databasePath = options.dataDir ? join(options.dataDir, 'experience.sqlite') : defaultDatabasePath();
    this.runtime = new RuntimeService({ dataDir: options.dataDir ?? dirname(this.databasePath) });
  }

  init(): { databasePath: string } {
    const store = this.openStore();
    store.close();
    return { databasePath: this.databasePath };
  }

  add(inputPath: string): { imported: number } {
    const record = this.readImport(inputPath);
    const validation = validateImport(record);
    if (!validation.ok) throw new DomainError(validation.code, validation.message);
    const store = this.openStore();
    try {
      store.import(record);
      return { imported: record.knowledge.length };
    } finally {
      store.close();
    }
  }

  validate(): { valid: true } {
    const store = this.openStore();
    store.close();
    return { valid: true };
  }

  inspect(id: string): KnowledgeEntry | undefined {
    const store = this.openStore();
    try {
      return store.inspect(id as KnowledgeEntry['id']);
    } finally {
      store.close();
    }
  }

  list(filter: LessonFilter = {}): RetrievedKnowledgeEntry[] {
    return this.retrieve({
      ...(filter.scope ? { scope: filter.scope } : {}),
      ...(filter.repositoryId ? { repositoryId: filter.repositoryId } : {}),
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.tag ? { tags: [filter.tag] } : {})
    });
  }

  retrieve(filter: RetrievalFilter): RetrievedKnowledgeEntry[] {
    const store = this.openStore();
    try {
      return store.retrieve(filter);
    } finally {
      store.close();
    }
  }

  export(filter: LessonFilter = {}): { knowledge: RetrievedKnowledgeEntry[] } {
    return { knowledge: this.list(filter) };
  }

  listRecords(repositoryId: string) { const store = this.openStore(); try { return store.listRepositoryRecords(repositoryId); } finally { store.close(); } }
  stats(repositoryId: string) { const store = this.openStore(); try { return store.repositoryStats(repositoryId); } finally { store.close(); } }
  statusGlobal(repositoryId?: string) { const store = this.openStore(); try { const repositories = store.listRepositories(); return { databasePath: this.databasePath, repositories: repositoryId ? repositories.filter(({ id }) => id === repositoryId) : repositories }; } finally { store.close(); } }
  status(repositoryId: string) {
    const store = this.openStore();
    try {
      const repository = store.listRepositories().find(({ id }) => id === repositoryId);
      const entrypoint = fileURLToPath(new URL('../cli.js', import.meta.url));
      const selectedSources = repository?.selectedSources ?? [];
      if (!repository || selectedSources.length === 0) return { status: 'not-ready' as const, repositoryId, cli: { entrypoint, available: existsSync(entrypoint) }, sources: [] };
      const hooks = verifyInstalledHooks({ repositoryRoot: repository.root, sources: selectedSources, cliEntrypoint: entrypoint });
      return { status: hooks.status, repositoryId, cli: { entrypoint, available: existsSync(entrypoint) }, sources: hooks.sources };
    } finally { store.close(); }
  }

  runtimeEvaluate(inputPath: string, profileId?: BuiltInRuntimeProfileId, refresh = false): PublicGateDecision {
    return this.runtime.evaluate({ inputPath, ...(profileId === undefined ? {} : { profileId }), refresh });
  }

  runtimeStatus() { return this.runtime.status(); }

  runtimeConfigExplain(workspace: string, remote?: string) {
    return this.runtime.explainConfiguration(workspace, remote);
  }

  knowledgeValidate(repository: string, trustedRef?: string): KnowledgeValidationResult {
    return this.runtime.validateKnowledge(repository, trustedRef);
  }

  knowledgeRefreshRuntime(repository: string, repositoryId: string, trustedRef: string) {
    return this.runtime.refreshKnowledgeRuntime(repository, repositoryId, trustedRef);
  }

  knowledgePromote(repository: string, inputPath: string) {
    return this.runtime.promoteKnowledge(repository, inputPath);
  }

  captureHook(source: PassiveHookSource, input: string, now: () => string = () => new Date().toISOString()): HookIngressResult {
    return ingestPassiveHook({ source, input, databasePath: this.databasePath, now });
  }

  private openStore(): ExperienceStore {
    return new ExperienceStore(this.databasePath);
  }

  private readImport(inputPath: string): ExperienceImport {
    let content: string;
    try {
      content = readFileSync(inputPath, 'utf8');
    } catch (error) {
      throw new DomainError('STORAGE_ERROR', errorMessage(error));
    }
    try {
      return JSON.parse(content) as ExperienceImport;
    } catch {
      throw new DomainError('INVALID_JSON', 'Input file is not valid JSON.');
    }
  }
}

export class DomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
