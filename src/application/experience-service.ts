import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { verifyInstalledHooks } from '../cli/hook-installation.js';
import { resolveRepositoryRoot } from '../repository/local-repository.js';

import { ingestPassiveHook, type HookIngressResult } from '../capture/hook-ingress.js';
import type { PassiveHookSource } from '../capture/hook-adapters/contracts.js';
import { initializeDiagnosticWorkspace, resolveDiagnosticScope, type DiagnosticScope } from '../capture/diagnostic-scope.js';
import { CaptureDiagnosticStore, type CursorDiagnosticCounts } from '../storage/capture-diagnostic-store.js';
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

export interface CursorCaptureDiagnosticsReport {
  readonly version: 1;
  readonly source: 'cursor';
  readonly scope: DiagnosticScope;
  readonly counts: CursorDiagnosticCounts;
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
  initWorkspace(directory: string, workspaceId?: string): DiagnosticScope {
    try {
      return initializeDiagnosticWorkspace(directory, workspaceId);
    } catch {
      throw new DomainError('WORKSPACE_INITIALIZATION_FAILED', 'Workspace initialization failed.');
    }
  }
  initRepository(input: { id: string; root: string; sources: readonly ('codex' | 'cursor')[]; observedAt: string }): { databasePath: string } {
    const store = this.openStore(); try { store.registerRepository({ id: input.id, root: input.root, selectedSources: input.sources, observedAt: input.observedAt }); return { databasePath: this.databasePath }; } finally { store.close(); }
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
  statusGlobal(repositoryId?: string) {
    const entrypoint = fileURLToPath(new URL('../cli.js', import.meta.url));
    const database = { path: this.databasePath, available: existsSync(this.databasePath) };
    if (!database.available) return { status: 'not-ready' as const, database, cli: { entrypoint, available: existsSync(entrypoint) }, repositories: [] };
    const store = this.openStore();
    try {
      const repositories = store.listRepositories()
        .filter(({ id }) => repositoryId === undefined || id === repositoryId)
        .map((repository) => this.repositoryStatus(repository, entrypoint));
      return { status: 'ready' as const, database, cli: { entrypoint, available: existsSync(entrypoint) }, repositories };
    } finally { store.close(); }
  }
  status(input: { id: string; root?: string }) {
    const entrypoint = fileURLToPath(new URL('../cli.js', import.meta.url));
    const database = { path: this.databasePath, available: existsSync(this.databasePath) };
    if (!database.available) return this.repositoryStatus({ id: input.id, root: input.root, observedAt: '', selectedSources: [] }, entrypoint, database);
    const store = this.openStore();
    try {
      const registered = store.listRepositories().find(({ id }) => id === input.id);
      return this.repositoryStatus(registered ?? { id: input.id, root: input.root, observedAt: '', selectedSources: [] }, entrypoint, database);
    } finally { store.close(); }
  }

  private repositoryStatus(repository: { id: string; root?: string; observedAt: string; selectedSources?: readonly ('codex' | 'cursor')[] }, entrypoint: string, database = { path: this.databasePath, available: existsSync(this.databasePath) }) {
    const selectedSources = repository.selectedSources ?? [];
    const cli = { entrypoint, available: existsSync(entrypoint) };
    const root = repository.root;
    if (!root || !resolveRepositoryRoot(root) || !database.available || !selectedSources.length) {
      return {
        status: 'not-ready' as const, repository: { id: repository.id, ...(root === undefined ? {} : { root }) }, selectedSources,
        cli, database, sources: selectedSources.map((source) => ({ source, status: 'unavailable' as const, code: root ? 'HOOK_UNAVAILABLE' : 'REPOSITORY_UNAVAILABLE' }))
      };
    }
    const hooks = verifyInstalledHooks({ repositoryRoot: root, sources: selectedSources, cliEntrypoint: entrypoint });
    return { status: hooks.status, repository: { id: repository.id, root }, selectedSources, cli, database, sources: hooks.sources };
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

  captureHook(source: PassiveHookSource, input: string, now: () => string = () => new Date().toISOString(), workingDirectory?: string): HookIngressResult {
    return ingestPassiveHook({ source, input, databasePath: this.databasePath, now, workingDirectory });
  }

  cursorCaptureDiagnostics(directory: string = process.cwd()): CursorCaptureDiagnosticsReport {
    let store: CaptureDiagnosticStore | undefined;
    try {
      const scope = resolveDiagnosticScope(directory);
      store = new CaptureDiagnosticStore(join(dirname(this.databasePath), 'capture-diagnostics.sqlite'));
      return Object.freeze({ version: 1, source: 'cursor', scope, counts: store.counts({ source: 'cursor', scope }) });
    } catch {
      throw new DomainError('DIAGNOSTICS_UNAVAILABLE', 'Capture diagnostics are unavailable.');
    } finally {
      try {
        store?.close();
      } catch {
        // Reporting only exposes a bounded failure from the surrounding operation.
      }
    }
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
