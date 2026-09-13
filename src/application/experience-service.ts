import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { verifyInstalledHooks } from '../cli/hook-installation.js';
import { resolveRepositoryRoot } from '../repository/local-repository.js';

import { ingestPassiveHook, type HookIngressResult } from '../capture/hook-ingress.js';
import { drainCaptureSpool } from '../capture/spool-drain.js';
import { CaptureSpool } from '../capture/spool.js';
import type { PassiveHookSource } from '../capture/hook-adapters/contracts.js';
import { initializeDiagnosticWorkspace, resolveConfiguredWorkspaceRoot, resolveDiagnosticScope, type DiagnosticScope } from '../capture/diagnostic-scope.js';
import { CaptureDiagnosticStore, type CursorDiagnosticCounts } from '../storage/capture-diagnostic-store.js';
import type { ExperienceImport, KnowledgeEntry, KnowledgeState, RepositoryId } from '../domain/types.js';
import { validateImport } from '../domain/validation.js';
import { defaultDatabasePath } from '../storage/database.js';
import { ExperienceStore, type KnowledgeScope, type RetrievalFilter, type RetrievedKnowledgeEntry } from '../storage/experience-store.js';
import { projectCapturedSessionEvidence } from '../evidence/capture-projection.js';
import { sourceEvidenceCapabilities } from '../evidence/capabilities.js';
import { SessionEvidenceRepository } from '../evidence/repository.js';
import { OperationalLearningRepository, type OperationalAnalysisQuality } from '../learning/repository.js';
import { OperationalLearningService } from '../learning/service.js';
import type { SessionId } from '../domain/types.js';
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
  private readonly dataDirectory: string;
  private readonly databasePath: string;
  private readonly runtime: RuntimeService;

  constructor(options: ExperienceServiceOptions = {}) {
    this.databasePath = options.dataDir ? join(options.dataDir, 'experience.sqlite') : defaultDatabasePath();
    this.dataDirectory = options.dataDir ?? dirname(this.databasePath);
    this.runtime = new RuntimeService({ dataDir: this.dataDirectory });
  }

  init(): { databasePath: string } {
    const store = this.openStore();
    store.close();
    return { databasePath: this.databasePath };
  }
  initWorkspace(directory: string, workspaceId?: string): DiagnosticScope {
    try {
      return initializeDiagnosticWorkspace(directory, workspaceId, { dataDirectory: this.dataDirectory });
    } catch {
      throw new DomainError('WORKSPACE_INITIALIZATION_FAILED', 'Workspace initialization failed.');
    }
  }
  initRepository(input: { id: string; root: string; sources: readonly ('codex' | 'cursor')[]; observedAt: string }): { databasePath: string } {
    const store = this.openStore(); try { store.registerRepository({ id: input.id, root: input.root, selectedSources: input.sources, observedAt: input.observedAt }); return { databasePath: this.databasePath }; } finally { store.close(); }
  }
  unregisterRepository(repositoryId: string): { repositoryId: string; removed: boolean } {
    const store = this.openStore();
    try { return { repositoryId, removed: store.unregisterRepository(repositoryId) }; }
    finally { store.close(); }
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

  statusV2(input: { id: string; root?: string }) {
    const legacy = this.status(input);
    return this.qualityReport(input.id, legacy);
  }

  statusGlobalV2(repositoryId?: string) {
    const legacy = this.statusGlobal(repositoryId);
    const repositories = legacy.repositories.map((repository) => {
      const health = this.qualityReport(repository.repository.id, repository);
      const { version: _version, schemaVersion: _schemaVersion, ...dimensions } = health;
      return Object.freeze({ repository: Object.freeze({ id: repository.repository.id }), ...dimensions });
    });
    return Object.freeze({
      version: 2 as const,
      schemaVersion: 2 as const,
      installation: Object.freeze({ state: legacy.status === 'ready' ? 'ready' as const : 'not-ready' as const }),
      repositories: Object.freeze(repositories)
    });
  }

  operationalAnalysisReportV2(repositoryId: string) {
    return Object.freeze({ version: 2 as const, schemaVersion: 2 as const, analysis: this.analysisQuality(repositoryId) });
  }

  private repositoryStatus(repository: { id: string; root?: string; observedAt: string; selectedSources?: readonly ('codex' | 'cursor')[] }, entrypoint: string, database = { path: this.databasePath, available: existsSync(this.databasePath) }) {
    const selectedSources = repository.selectedSources ?? [];
    const cli = { entrypoint, available: existsSync(entrypoint) };
    const root = repository.root;
    const resolvedRepository = root ? resolveRepositoryRoot(root) : undefined;
    const registeredRootAvailable = resolvedRepository?.id === repository.id || configuredWorkspaceMatches(root, repository.id);
    if (!root || !registeredRootAvailable || !database.available || !selectedSources.length) {
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

  captureHook(source: PassiveHookSource, input: string, now: () => string = () => new Date().toISOString(), workingDirectory?: string, repositoryId?: RepositoryId): HookIngressResult {
    return ingestPassiveHook({ source, input, databasePath: this.databasePath, now, workingDirectory, repositoryId });
  }

  captureDrain(now: () => string = () => new Date().toISOString()) {
    return drainCaptureSpool({ databasePath: this.databasePath, now, learningAdmission: new OperationalLearningService(this.databasePath) });
  }

  runOperationalAnalysis(repositoryId: string) {
    const service = new OperationalLearningService(this.databasePath);
    return service.runNext({ repositoryId });
  }

  operationalAnalysisReport(repositoryId: string, sessionId?: string) {
    const service = new OperationalLearningService(this.databasePath);
    const report = service.report(repositoryId);
    const scopedEpisodes = sessionId === undefined ? report.episodes : report.episodes.filter((episode) => episode.sessionId === sessionId);
    const episodeIds = new Set(scopedEpisodes.map(({ id }) => id));
    return Object.freeze({
      version: 1 as const,
      cost: report.cost,
      coverage: report.coverage,
      findings: Object.freeze(report.findings.filter((finding) => episodeIds.has(finding.episodeId)).map(({ id, episodeId, kind, evidenceEventIds, statement }) => Object.freeze({ id, episodeId, kind, evidenceEventIds, statement }))),
      hypotheses: Object.freeze(scopedEpisodes.filter(({ hypothesis }) => hypothesis !== undefined).map(({ id, state, evidenceEventIds, hypothesis }) => Object.freeze({ id, state, evidenceEventIds, hypothesis }))),
      unverifiedRepairs: Object.freeze(scopedEpisodes.filter(({ state }) => state === 'outcome-observed').map(({ id, evidenceEventIds, hypothesis }) => Object.freeze({ id, evidenceEventIds, missingVerification: hypothesis ?? 'A source-declared task verification was not observed.' }))),
      candidates: Object.freeze(report.candidates.filter((candidate) => episodeIds.has(candidate.episodeId))),
      verifiedKnowledge: Object.freeze(this.list({ repositoryId, state: 'verified' }))
    });
  }

  captureStatus() {
    const spool = new CaptureSpool(join(this.dataDirectory, 'capture-spool.sqlite'));
    try { return spool.status(); } finally { spool.close(); }
  }

  private qualityReport(repositoryId: string, legacy: ReturnType<ExperienceService['status']>) {
    const spool = this.spoolQuality();
    const evidence = this.evidenceQuality(repositoryId);
    const analysis = this.analysisQuality(repositoryId);
    const installation = legacy.status === 'ready' ? 'ready' as const : 'not-ready' as const;
    const receiptScopeUnavailable = spool !== undefined;
    const dataState = receiptScopeUnavailable
      ? 'unknown' as const
      : evidence.operations === 0
        ? 'not-applicable' as const
        : evidence.unknownTotal > 0
          ? 'degraded' as const
          : 'sufficient' as const;
    return Object.freeze({
      version: 2 as const,
      schemaVersion: 2 as const,
      installation: Object.freeze({ state: installation }),
      delivery: Object.freeze(spool === undefined
        ? { state: 'unknown' as const }
        : { state: spool.status.failedAdmission > 0 || spool.status.quarantined > 0 || spool.status.delayedDelivery.count > 0 ? 'degraded' as const : spool.status.pending > 0 || spool.status.claimed > 0 ? 'backlogged' as const : 'healthy' as const, pending: spool.status.pending, claimed: spool.status.claimed, committed: spool.status.committed, quarantined: spool.status.quarantined, failedAdmission: spool.status.failedAdmission }),
      dataQuality: Object.freeze({
        state: dataState,
        admittedOperations: Object.freeze({ state: 'unavailable' as const }),
        receipts: Object.freeze({ accounting: 'unavailable' as const }),
        results: Object.freeze({ linked: evidence.linked, unknown: Object.freeze(evidence.unknown) }),
        skips: Object.freeze({ state: 'unavailable' as const }),
        denominator: Object.freeze(evidence.operations === 0 ? { state: 'unavailable' as const } : { state: 'known' as const, count: evidence.operations }),
        ...(evidence.firstObservedAt === undefined ? {} : { observedTimeRange: Object.freeze({ first: evidence.firstObservedAt, last: evidence.lastObservedAt! }) })
      }),
      analysis
    });
  }

  private spoolQuality() {
    const path = join(this.dataDirectory, 'capture-spool.sqlite');
    if (!existsSync(path)) return undefined;
    const spool = new CaptureSpool(path);
    try {
      const status = spool.status(); const receipts = spool.receiptReport();
      const skipped = Object.fromEntries(Object.entries(receipts.byDisposition).filter(([disposition]) => disposition !== 'accepted' && disposition !== 'duplicate'));
      return Object.freeze({ status, accounting: receipts.accounting, receipts: Object.freeze({ accounting: receipts.accounting, total: receipts.receipts.length, accepted: receipts.byDisposition.accepted }), skips: Object.freeze({ total: Object.values(skipped).reduce((total, value) => total + value, 0), byDisposition: Object.freeze(skipped) }) });
    } finally { spool.close(); }
  }

  private evidenceQuality(repositoryId: string) {
    if (!existsSync(this.databasePath)) return Object.freeze({ operations: 0, linked: 0, unknownTotal: 0, unknown: {}, firstObservedAt: undefined, lastObservedAt: undefined });
    const store = this.openStore();
    try { return store.repositoryQuality(repositoryId); } finally { store.close(); }
  }

  private analysisQuality(repositoryId: string) {
    const empty = Object.freeze({ state: 'not-run' as const, detectorVersions: Object.freeze([]), desiredThrough: 0, completedThrough: 0, backlog: 0, range: Object.freeze({ from: 0, through: 0 }), retries: 0, cost: Object.freeze({ completedRuns: 0, total: 0 }), coverage: Object.freeze({ required: true as const, total: 0, truncated: false, detectors: Object.freeze([]) }), result: 'unavailable' as const });
    if (!existsSync(this.databasePath)) return empty;
    const repository = new OperationalLearningRepository(this.databasePath);
    try { return reportAnalysisQuality(repository.quality(repositoryId)); } finally { repository.close(); }
  }

  cursorCaptureDiagnostics(directory: string = process.cwd()): CursorCaptureDiagnosticsReport {
    let store: CaptureDiagnosticStore | undefined;
    try {
      const scope = resolveDiagnosticScope(directory, { dataDirectory: this.dataDirectory });
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

  sessionEvidence(sessionId: string) {
    const store = this.openStore();
    let captured;
    try {
      captured = store.loadCapturedSession(sessionId as SessionId);
    } finally {
      store.close();
    }
    if (captured === undefined) throw new DomainError('NOT_FOUND', 'Session evidence was not found.');
    const repository = new SessionEvidenceRepository(this.databasePath);
    try {
      const stored = repository.save(projectCapturedSessionEvidence(captured));
      return Object.freeze({ ...stored, capabilities: sourceEvidenceCapabilities[captured.session.source] });
    } finally {
      repository.close();
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

function configuredWorkspaceMatches(root: string | undefined, id: string): boolean {
  if (root === undefined) return false;
  try { return resolveConfiguredWorkspaceRoot(root)?.id === id; }
  catch { return false; }
}

function reportAnalysisQuality(quality: OperationalAnalysisQuality) {
  const streams = quality.streams;
  const backlog = Math.max(0, streams.desiredThrough - streams.completedThrough);
  const coverageComplete = streams.total > 0 && streams.completed > 0 && quality.coverage.uncoveredCompletedRanges === 0;
  const state = streams.total === 0 ? 'not-run'
    : streams.quarantined > 0 ? 'quarantined'
      : streams.running > 0 ? 'running'
    : streams.failed > 0 || quality.coverage.failed > 0 ? 'failed'
          : streams.pending > 0 ? 'pending'
            : !coverageComplete || quality.coverage.incomplete > 0 ? 'incomplete'
              : 'completed';
  const completed = state === 'completed';
  return Object.freeze({
    state,
    detectorVersions: quality.detectorVersions,
    desiredThrough: streams.desiredThrough,
    completedThrough: streams.completedThrough,
    backlog,
    range: Object.freeze({ from: quality.runs.firstInput, through: quality.runs.lastInput }),
    retries: quality.runs.retries,
    cost: quality.cost,
    coverage: Object.freeze({ required: true as const, total: quality.coverage.total, truncated: quality.coverage.total > quality.coverage.detectors.length, detectors: quality.coverage.detectors }),
    result: completed && coverageComplete ? (quality.findings > 0 ? 'findings' as const : 'no-findings' as const) : 'unavailable' as const
  });
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
