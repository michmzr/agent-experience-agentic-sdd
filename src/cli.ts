#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { compareBaseline, currentBuildIdentity, runBaseline } from './benchmark/runner.js';
import { AdvisoryConfigurationStore } from './advice/configuration.js';
import { retrieveLocalAdvice, type AdviceRequest } from './advice/service.js';
import { CandidateRepository, type CandidateRecord } from './knowledge/candidate-repository.js';

import { defaultDatabasePath } from './storage/database.js';
import { importTypedEvidence } from './evidence/import.js';
import { applyRecoveryPlan, createRecoveryPlan, type RecoveryPlan } from './capture/recovery.js';
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createAlignmentPlan, applyAlignmentPlan } from './installation/alignment.js';
import { qualifyInstallation } from './installation/qualification.js';
import { inspectInstallation, registeredInstallationRoots } from './installation/inspection.js';
import { DomainError, errorMessage, ExperienceService } from './application/experience-service.js';
import { MAX_HOOK_INPUT_BYTES, type PassiveHookSource } from './capture/hook-adapters/contracts.js';
import type { HookIngressResult } from './capture/hook-ingress.js';
import { isBuiltInRuntimeProfileId, RuntimeServiceError, type BuiltInRuntimeProfileId } from './application/runtime-service.js';
import type { KnowledgeState, RepositoryId } from './domain/types.js';
import type { KnowledgeScope } from './storage/experience-store.js';
import { discoverReviewSessions, runManualReview, runManualReviewExecution, type ManualReviewDependencies } from './review/review-service.js';
import type { SessionIngestionDiagnostic } from './review/ingestion.js';
import { createProcessDebriefTerminalHost, runSessionDebrief, type DebriefTerminalHost } from './review/debrief-terminal.js';
import { createProcessTerminalHost, TerminalReviewSelectionPrompt, type TerminalHost } from './review/terminal-prompt.js';
import { verifyHookReadiness } from './cli/hook-readiness.js';
import { parseArguments, type ParsedArguments } from './cli/arguments.js';
import { resolveCliContext } from './cli/context.js';
import { createProcessContextPrompt, prepareContextArguments, type CliContextPrompt } from './cli/context-prompt.js';
import { renderCommandResult, type CommandPresentationContext } from './cli/human-presentations.js';
import { renderHumanError, type HumanRenderOptions } from './cli/human-renderer.js';
import { resolveRepository, resolveRepositoryRoot } from './repository/local-repository.js';
import { DiagnosticWorkspaceConfigurationError, resolveConfiguredWorkspaceRoot } from './capture/diagnostic-scope.js';
import { installHooks, parseHookSelection, type HookSelectionPrompt, verifyInstalledHooks } from './cli/hook-installation.js';
import { AelSkillError, inspectAelSkill, installAelSkill, uninstallAelSkill, updateAelSkill, validateAelSkill, type AelSkillLocation, type AelSkillScope } from './skill/ael-skill.js';
import { OperationalLearningRepository, type AnalysisWorkerSlotFence } from './learning/repository.js';
import { createProductionAnalysisWatchdogHost, createProductionAnalysisWorkerHost, runAnalysisCoordinator, runAnalysisWorkerWatchdog } from './learning/worker.js';
import { loadAnalysisWorkerSettings } from './learning/worker-settings.js';

export interface CliResult { exitCode: number; stdout: string; stderr: string; }
export interface RunCliAsyncOptions {
  readonly terminal?: TerminalHost;
  readonly debriefTerminal?: DebriefTerminalHost;
  readonly hookSelectionPrompt?: HookSelectionPrompt;
  readonly workingDirectory?: string;
  readonly cliEntrypoint?: string;
  readonly skillSourceDirectory?: string;
  readonly homeDirectory?: string;
  readonly reviewDependencies?: ManualReviewDependencies;
  readonly hookInput?: string;
  readonly now?: () => string;
  readonly ingestionDiagnosticWrite?: (line: string) => void | Promise<void>;
  readonly contextPrompt?: CliContextPrompt;
  readonly humanOutput?: HumanRenderOptions;
}

const scopes = new Set(['global', 'repo'] as const);
const initScopes = new Set(['global', 'repo', 'workspace'] as const);
const states = new Set<KnowledgeState>(['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired']);
const reviewSources = new Set(['codex', 'claude-code', 'cursor'] as const);
const knownCommands = new Set(['init', 'unregister', 'experience', 'validate', 'inspect', 'lessons', 'retrieve', 'export', 'list', 'stats', 'status', 'status-global', 'review', 'runtime', 'knowledge', 'hooks', 'skill', 'evidence', 'capture', 'analysis', 'installation', 'benchmark', 'advice', 'candidates']);

export function runCli(args: string[], options: Pick<RunCliAsyncOptions, 'workingDirectory' | 'cliEntrypoint' | 'skillSourceDirectory' | 'homeDirectory' | 'humanOutput'> = {}): CliResult {
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0, stdout: `${usage()}\n`, stderr: '' };
  try {
    const parsed = parseArguments(args);
    const json = parsed.options.has('json');
    if (parsed.positionals[0] === 'installation') return { exitCode: 0, stdout: JSON.stringify(executeInstallation(parsed, options)) + '\n', stderr: '' };
    if (parsed.positionals[0] === 'benchmark') return success(executeBenchmark(parsed), json, parsed.positionals, options.humanOutput);
    if (parsed.positionals[0] === 'advice') return success(executeAdvice(parsed, options.workingDirectory), json, parsed.positionals, options.humanOutput);
    if (parsed.positionals[0] === 'candidates') return success(executeCandidates(parsed), json, parsed.positionals, options.humanOutput);
    const service = new ExperienceService({ dataDir: optionalString(parsed.options, 'data-dir') });
    const value = execute(service, parsed, options);
    return success(value, json, parsed.positionals, options.humanOutput,
      json ? undefined : commandPresentationContext(parsed, options.workingDirectory));
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    const diagnostic = toDiagnostic(error, syntax ? 'INVALID_SYNTAX' : 'STORAGE_ERROR');
    return args.includes('--json')
      ? { exitCode: syntax ? 2 : 1, stdout: `${JSON.stringify({ error: diagnostic })}\n`, stderr: '' }
      : { exitCode: syntax ? 2 : 1, stdout: '', stderr: `${renderHumanError(diagnostic, nextStep(diagnostic.code, args), options.humanOutput)}\n` };
  }
}

function executeAdvice(parsed: ParsedArguments, workingDirectory?: string): unknown {
  const [command, subcommand, ...rest] = parsed.positionals;
  if (command !== 'advice' || rest.length !== 0) throw invalidCommand(command);
  const dataDir = optionalString(parsed.options, 'data-dir') ?? dirname(defaultDatabasePath());
  const store = new AdvisoryConfigurationStore(join(dataDir, 'advice.sqlite'));
  if (subcommand === 'status') {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id']);
    return store.status(requiredString(parsed.options, 'repository-id'));
  }
  if (subcommand === 'configure') {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'enabled']);
    const enabled = requiredString(parsed.options, 'enabled');
    if (enabled !== 'true' && enabled !== 'false') throw new SyntaxError('--enabled must be true or false.');
    return store.setEnabled(requiredString(parsed.options, 'repository-id'), enabled === 'true');
  }
  if (subcommand === 'retrieve') {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'input']);
    const context = readAdviceContext(requiredString(parsed.options, 'input'));
    return retrieveLocalAdvice(dataDir, workingDirectory ?? process.cwd(), context);
  }
  throw invalidCommand(command);
}

function readAdviceContext(path: string): AdviceRequest {
  const value = JSON.parse(readBoundedAdviceInput(path)) as Record<string, unknown>;
  const required = ['repositoryId', 'sessionId', 'operationSignature', 'contextRevision', 'conditions', 'retrievalRef'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => ![...required, 'subproject'].includes(key))
    || required.some(key => !(key in value))
    || ['repositoryId', 'sessionId', 'operationSignature', 'contextRevision', 'retrievalRef'].some(key =>
      typeof value[key] !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(value[key] as string))
    || value.subproject !== undefined && (typeof value.subproject !== 'string'
      || !/^[A-Za-z0-9._/-]{1,160}$/.test(value.subproject))
    || !Array.isArray(value.conditions) || value.conditions.length > 32
    || value.conditions.some(condition => typeof condition !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(condition))) {
    throw new SyntaxError('Advice context is invalid.');
  }
  return value as unknown as AdviceRequest;
}

function readBoundedAdviceInput(path: string): string {
  const maximumBytes = 16 * 1024;
  const descriptor = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximumBytes) throw new SyntaxError('Advice context exceeds 16 KiB.');
    return bytes.toString('utf8', 0, length);
  } finally { closeSync(descriptor); }
}

function executeCandidates(parsed: ParsedArguments): unknown {
  const [, subcommand, ...rest] = parsed.positionals;
  const repositoryId = requiredString(parsed.options, 'repository-id');
  const dataDir = optionalString(parsed.options, 'data-dir') ?? dirname(defaultDatabasePath());
  const databasePath = join(dataDir, 'experience.sqlite');
  if (subcommand === 'list' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'state']);
    if (!existsSync(databasePath)) return Object.freeze([]);
    const repository = new CandidateRepository(databasePath);
    try {
      const state = optionalString(parsed.options, 'state');
      if (state !== undefined && !states.has(state as KnowledgeState)) throw new SyntaxError('Knowledge state is unsupported.');
      return Object.freeze(repository.list(repositoryId).filter(candidate => state === undefined || candidate.state === state)
        .map(candidate => publicCandidate(candidate)));
    } finally { repository.close(); }
  }
  if (subcommand === 'inspect' && rest.length === 1) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id']);
    if (!existsSync(databasePath)) throw new DomainError('NOT_FOUND', 'Candidate was not found.');
    const repository = new CandidateRepository(databasePath);
    try {
      const candidate = repository.inspect(repositoryId, rest[0]!);
      if (!candidate) throw new DomainError('NOT_FOUND', 'Candidate was not found.');
      const history = repository.history(repositoryId, candidate.id).map(review => Object.freeze({
        from: review.from, to: review.to, evidenceKey: opaquePublicKey(review.evidenceId),
        actorKey: opaquePublicKey(review.actorId), reviewedAt: review.reviewedAt
      }));
      return Object.freeze({ ...publicCandidate(candidate), history: Object.freeze(history) });
    } finally { repository.close(); }
  }
  throw invalidCommand('candidates');
}

function publicCandidate(candidate: CandidateRecord) {
  return Object.freeze({
    id: candidate.id, repositoryId: candidate.repositoryId, state: candidate.state, kind: candidate.kind,
    statement: candidate.statement, applicability: candidate.applicability, revision: candidate.revision,
    contradictionState: candidate.contradictionState,
    origins: Object.freeze(candidate.origins.map(origin => Object.freeze({
      source: origin.source, originKey: opaquePublicKey(origin.originId), evidenceCount: origin.evidenceEventIds.length
    })))
  });
}

function opaquePublicKey(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export async function runCliAsync(args: string[], options: RunCliAsyncOptions = {}): Promise<CliResult> {
  const positionals = routingPositionals(args);
  if (isCaptureHookCommand(positionals)) return runCaptureHookCli(args, options);
  if (positionals[0] === 'hooks' && positionals[1] === 'verify') return runHookReadinessCli(args, options.humanOutput);
  if (isInternalAnalysisWorkerCommand(positionals)) return runInternalAnalysisWorkerCli(args, options);
  if (positionals[0] !== 'review') {
    const prepared = await prepareContextArguments(args, {
      workingDirectory: options.workingDirectory ?? process.cwd(),
      ...(options.contextPrompt === undefined ? {} : { prompt: options.contextPrompt })
    });
    if (prepared.status === 'cancelled') return { exitCode: 130, stdout: '', stderr: '' };
    if (prepared.status === 'invalid') return contextRequiredResult(args, options.humanOutput);
    return runCli([...prepared.args], options);
  }
  try {
    const parsed = parseArguments(args); const json = parsed.options.has('json');
    const request = parseReviewRequest(parsed);
    const baseDependencies = options.ingestionDiagnosticWrite
      ? {
          ...options.reviewDependencies,
          ingestionDiagnosticSink: async (diagnostic: SessionIngestionDiagnostic) => {
            await options.reviewDependencies?.ingestionDiagnosticSink?.(diagnostic);
            await options.ingestionDiagnosticWrite!(formatIngestionDiagnostic(diagnostic));
          }
        }
      : options.reviewDependencies;
    const reviewDependencies = request.kind === 'review' && request.interactive
      ? { ...baseDependencies, prompt: baseDependencies?.prompt ?? new TerminalReviewSelectionPrompt(options.terminal ?? createProcessTerminalHost()) }
      : baseDependencies;
    if (request.kind === 'discover') {
      const value = (await discoverReviewSessions(request)).map(({ source, id, updatedAt }) => ({ source, id, updatedAt }));
      return success(value, json, parsed.positionals, options.humanOutput);
    }
    if (!request.interactive || json) return success(await runManualReview(request, reviewDependencies), json, parsed.positionals, options.humanOutput);

    const execution = await runManualReviewExecution(request, reviewDependencies);
    const terminal = options.debriefTerminal ?? createProcessDebriefTerminalHost();
    if (!terminal.interactive) return success(execution.result, false, parsed.positionals, options.humanOutput);
    const debrief = await runSessionDebrief(execution.debrief, terminal);
    if (debrief.status === 'completed') return { exitCode: 0, stdout: '', stderr: '' };
    if (debrief.status === 'interrupted') return { exitCode: 130, stdout: '', stderr: '' };
    const fallback = success(execution.result, false, parsed.positionals, options.humanOutput);
    return { ...fallback, stderr: 'REVIEW_TUI_UNAVAILABLE: Interactive debrief unavailable; printed text fallback.\n' };
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    const diagnostic = syntax ? toDiagnostic(error, 'INVALID_SYNTAX') : { code: 'REVIEW_ERROR', message: 'Review failed.' };
    return args.includes('--json') ? { exitCode: syntax ? 2 : 1, stdout: `${JSON.stringify({ error: diagnostic })}\n`, stderr: '' } : { exitCode: syntax ? 2 : 1, stdout: '', stderr: `${renderHumanError(diagnostic, nextStep(diagnostic.code, args), options.humanOutput)}\n` };
  }
}

function isInternalAnalysisWorkerCommand(args: readonly string[]): boolean {
  return args[0] === 'analysis' && ['worker', 'worker-watchdog', 'worker-child'].includes(args[1] ?? '');
}

function routingPositionals(args: readonly string[]): readonly string[] {
  try { return parseArguments(args).positionals; }
  catch { return args; }
}

async function runInternalAnalysisWorkerCli(args: string[], options: RunCliAsyncOptions): Promise<CliResult> {
  let repository: OperationalLearningRepository | undefined;
  try {
    const parsed = parseArguments(args);
    const [, subcommand, ...rest] = parsed.positionals;
    if (rest.length !== 0) throw new SyntaxError('Analysis worker arguments are invalid.');
    const dataDirectory = internalDataDirectory(parsed.options);
    const entrypoint = options.cliEntrypoint ?? fileURLToPath(import.meta.url);
    if (subcommand === 'worker') {
      assertNoUnknownOptions(parsed.options, ['data-dir']);
      let settings;
      try { settings = loadAnalysisWorkerSettings(dataDirectory); }
      catch { return internalFailure(1, 'ANALYSIS_CONFIGURATION_ERROR', 'Analysis worker configuration is invalid.'); }
      repository = new OperationalLearningRepository(join(dataDirectory, 'experience.sqlite'));
      await runAnalysisCoordinator(dataDirectory, settings, repository, createProductionAnalysisWorkerHost(entrypoint));
      return internalSuccess();
    }
    assertNoUnknownOptions(parsed.options, ['data-dir', 'worker-slot-id', 'worker-slot-owner', 'worker-slot-attempt']);
    const slot = internalWorkerSlot(parsed.options);
    if (subcommand === 'worker-watchdog') {
      repository = new OperationalLearningRepository(join(dataDirectory, 'experience.sqlite'));
      const result = await runAnalysisWorkerWatchdog(dataDirectory, { ...slot, leaseExpiresAt: '', jobId: null }, repository,
        createProductionAnalysisWatchdogHost(entrypoint));
      if (result.status === 'completed' && result.exitCode === 0) return internalSuccess();
      return internalFailure(1, 'ANALYSIS_WORKER_FAILED', 'Analysis worker failed.');
    }
    if (subcommand === 'worker-child') {
      const result = new ExperienceService({ dataDir: dataDirectory }).runNextOperationalAnalysis(slot);
      return result.status === 'idle' || result.status === 'completed'
        ? internalSuccess()
        : internalFailure(1, 'ANALYSIS_WORKER_FAILED', 'Analysis worker failed.');
    }
    throw new SyntaxError('Analysis worker arguments are invalid.');
  } catch (error) {
    if (error instanceof SyntaxError) return internalFailure(2, 'INVALID_SYNTAX', 'Analysis worker arguments are invalid.');
    return internalFailure(1, 'ANALYSIS_WORKER_ERROR', 'Analysis worker failed.');
  } finally {
    try { repository?.close(); } catch { /* Preserve the bounded command result. */ }
  }
}

function internalDataDirectory(options: Map<string, string | true>): string {
  const value = requiredString(options, 'data-dir');
  if (!isAbsolute(value) || value.length > 4_096 || value.includes('\0')) throw new SyntaxError('Analysis worker arguments are invalid.');
  return value;
}

function internalWorkerSlot(options: Map<string, string | true>): AnalysisWorkerSlotFence {
  const slotId = requiredString(options, 'worker-slot-id');
  const ownerId = requiredString(options, 'worker-slot-owner');
  const rawAttempt = requiredString(options, 'worker-slot-attempt');
  const attempt = Number(rawAttempt);
  const validIdentity = (value: string) => /^[A-Za-z0-9._:@/-]{1,512}$/.test(value);
  if (!validIdentity(slotId) || !validIdentity(ownerId) || !/^[1-9][0-9]*$/.test(rawAttempt) || !Number.isSafeInteger(attempt)) {
    throw new SyntaxError('Analysis worker arguments are invalid.');
  }
  return Object.freeze({ slotId, ownerId, attempt });
}

function internalSuccess(): CliResult { return { exitCode: 0, stdout: '', stderr: '' }; }
function internalFailure(exitCode: number, code: string, message: string): CliResult {
  return { exitCode, stdout: '', stderr: `${code}: ${message}\n` };
}

function formatIngestionDiagnostic(value: SessionIngestionDiagnostic): string {
  return `${JSON.stringify(value)}\n`;
}

async function runHookReadinessCli(args: string[], humanOutput?: HumanRenderOptions): Promise<CliResult> {
  try {
    const parsed = parseArguments(args);
    assertNoUnknownOptions(parsed.options, ['worktree', 'json']);
    if (parsed.positionals.length !== 2) throw new SyntaxError('Unknown command form for hooks.');
    return success(await verifyHookReadiness({ worktreePath: requiredString(parsed.options, 'worktree') }), parsed.options.has('json'), parsed.positionals, humanOutput);
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    const diagnostic = toDiagnostic(error, syntax ? 'INVALID_SYNTAX' : 'STORAGE_ERROR');
    return args.includes('--json')
      ? { exitCode: syntax ? 2 : 1, stdout: `${JSON.stringify({ error: diagnostic })}\n`, stderr: '' }
      : { exitCode: syntax ? 2 : 1, stdout: '', stderr: `${renderHumanError(diagnostic, nextStep(diagnostic.code, args), humanOutput)}\n` };
  }
}

async function runCaptureHookCli(args: string[], options: RunCliAsyncOptions): Promise<CliResult> {
  try {
    const parsed = parseArguments(args);
    if (parsed.positionals.length !== 2) throw new SyntaxError('Unknown command form for capture.');
    assertNoUnknownOptions(parsed.options, ['source', 'data-dir', 'repository-id']);
    const source = requiredString(parsed.options, 'source');
    if (source !== 'codex' && source !== 'cursor') throw new SyntaxError('Unsupported passive hook source.');
    const input = options.hookInput === undefined ? await readBoundedStdin() : { input: options.hookInput, oversized: false };
    if (input.oversized) return hookCliResult({ status: 'degraded', code: 'INVALID_INPUT' });
    const service = new ExperienceService({ dataDir: optionalString(parsed.options, 'data-dir') });
    return hookCliResult(service.captureHook(source as PassiveHookSource, input.input, options.now, options.workingDirectory, optionalCaptureRepositoryId(parsed.options)));
  } catch (error) {
    return hookCliResult({ status: 'degraded', code: hookErrorCode(error) });
  }
}

function hookErrorCode(error: unknown): 'INVALID_INPUT' | 'PERSISTENCE_FAILED' {
  return error instanceof Error && /sqlite|database|directory|file|path|permission|busy|locked|constraint/i.test(error.message)
    ? 'PERSISTENCE_FAILED'
    : 'INVALID_INPUT';
}

function isCaptureHookCommand(args: readonly string[]): boolean {
  return args[0] === 'capture' && args[1] === 'hook';
}

function hookCliResult(result: HookIngressResult): CliResult {
  if (result.status !== 'degraded') return { exitCode: 0, stdout: '', stderr: '' };
  return {
    exitCode: 0,
    stdout: '',
    stderr: `AEL_CAPTURE_${result.code}: Passive capture skipped.\n`
  };
}

function contextRequiredResult(args: readonly string[], humanOutput?: HumanRenderOptions): CliResult {
  const diagnostic = {
    code: 'CONTEXT_REQUIRED',
    message: 'A repository or workspace is required. Pass an explicit context option or run the command inside a configured AEL workspace.'
  };
  return args.includes('--json')
    ? { exitCode: 1, stdout: `${JSON.stringify({ error: diagnostic })}\n`, stderr: '' }
    : { exitCode: 1, stdout: '', stderr: `${renderHumanError(diagnostic, nextStep(diagnostic.code, args), humanOutput)}\n` };
}

async function readBoundedStdin(): Promise<{ readonly input: string; readonly oversized: boolean }> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    const remaining = MAX_HOOK_INPUT_BYTES + 1 - byteLength;
    if (remaining <= 0) return { input: '', oversized: true };
    if (value.byteLength > remaining) return { input: '', oversized: true };
    chunks.push(value);
    byteLength += value.byteLength;
    if (byteLength > MAX_HOOK_INPUT_BYTES) return { input: '', oversized: true };
  }
  return { input: Buffer.concat(chunks).toString('utf8'), oversized: false };
}

function execute(service: ExperienceService, parsed: ParsedArguments, options: Pick<RunCliAsyncOptions, 'workingDirectory' | 'cliEntrypoint' | 'skillSourceDirectory' | 'homeDirectory'>): unknown {
  const [command, subcommand, ...rest] = parsed.positionals;
  if (command === 'init' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope', 'hooks', 'workspace-id']);
    const scope = optionalInitScope(parsed.options);
    if (scope === undefined) {
      if (parsed.options.has('hooks')) throw new SyntaxError('--hooks requires --scope repo.');
      return service.initWorkspace(options.workingDirectory ?? process.cwd(), optionalString(parsed.options, 'workspace-id'));
    }
    if (scope === 'global') {
      if (parsed.options.has('hooks')) throw new SyntaxError('--hooks may be used only with --scope repo or workspace.');
      if (parsed.options.has('workspace-id')) throw new SyntaxError('--workspace-id may be used only with --scope workspace.');
      return service.init();
    }
    const sources = parseHookSelection(requiredString(parsed.options, 'hooks'));
    const directory = options.workingDirectory ?? process.cwd();
    const repository = scope === 'repo'
      ? resolveRepositoryRoot(directory)
      : (() => {
          service.initWorkspace(directory, optionalString(parsed.options, 'workspace-id'));
          return resolveConfiguredWorkspaceRoot(directory);
        })();
    if (!repository) throw new DomainError('REPOSITORY_ROOT_REQUIRED', 'Repository initialization requires a Git top-level directory.');
    if (scope === 'repo' && parsed.options.has('workspace-id')) throw new SyntaxError('--workspace-id may be used only with --scope workspace.');
    const entrypoint = options.cliEntrypoint ?? fileURLToPath(import.meta.url);
    installHooks({ repositoryRoot: repository.root, sources, cliEntrypoint: entrypoint, repositoryId: repository.id });
    const verified = verifyInstalledHooks({ repositoryRoot: repository.root, sources, cliEntrypoint: entrypoint });
    if (verified.status !== 'ready') throw new DomainError('HOOKS_NOT_READY', 'Selected hooks could not be verified.');
    return service.initRepository({ id: repository.id, root: repository.root, sources, observedAt: new Date().toISOString() });
  }
  if (command === 'unregister' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id']);
    return service.unregisterRepository(contextualRepositoryId(parsed.options, options.workingDirectory));
  }
  if (command === 'experience' && subcommand === 'add' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'input']); return service.add(requiredString(parsed.options, 'input'));
  }
  if (command === 'capture' && subcommand === 'drain' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json']); return service.captureDrain();
  }
  if (command === 'capture' && subcommand === 'status' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json']); return service.captureStatus();
  }
  if (command === 'capture' && subcommand === 'recovery' && rest.length === 1 && rest[0] === 'plan') {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'output', 'limit', 'cursor']);
    const dataDir = optionalString(parsed.options, 'data-dir') ?? dirname(defaultDatabasePath());
    const limitInput = optionalString(parsed.options, 'limit');
    const limit = limitInput === undefined ? undefined : Number(limitInput);
    const plan = createRecoveryPlan({ spoolPath: join(dataDir, 'capture-spool.sqlite'),
      experiencePath: join(dataDir, 'experience.sqlite'), repositoryId: requiredString(parsed.options, 'repository-id'),
      now: new Date().toISOString(), ...(limit === undefined ? {} : { limit }),
      ...(optionalString(parsed.options, 'cursor') === undefined ? {} : { cursor: optionalString(parsed.options, 'cursor') }) });
    writeFileSync(requiredString(parsed.options, 'output'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { schemaVersion: 1, planHash: plan.planHash, selected: plan.selections.length, ineligible: plan.ineligible.length,
      ...(plan.nextCursor === undefined ? {} : { nextCursor: plan.nextCursor }) };
  }
  if (command === 'capture' && subcommand === 'recovery' && rest.length === 1 && rest[0] === 'apply') {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'input']);
    const dataDir = optionalString(parsed.options, 'data-dir') ?? dirname(defaultDatabasePath());
    const plan = JSON.parse(readBoundedRecoveryPlan(requiredString(parsed.options, 'input'))) as RecoveryPlan;
    return applyRecoveryPlan({ spoolPath: join(dataDir, 'capture-spool.sqlite'), experiencePath: join(dataDir, 'experience.sqlite'),
      plan, now: new Date().toISOString() });
  }
  if (command === 'analysis' && subcommand === 'run' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id']);
    return service.runOperationalAnalysis(contextualRepositoryId(parsed.options, options.workingDirectory));
  }
  if (command === 'analysis' && subcommand === 'reconcile' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'apply', 'after-session']);
    return service.reconcileOperationalAnalysis(requiredString(parsed.options, 'repository-id'), {
      ...(parsed.options.has('apply') ? { apply: true } : {}),
      ...(optionalString(parsed.options, 'after-session') === undefined ? {} : { afterSession: optionalString(parsed.options, 'after-session') })
    });
  }
  if (command === 'analysis' && subcommand === 'report' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'session', 'schema-version']);
    const schemaVersion = optionalSchemaVersion(parsed.options);
    return schemaVersion === 3
      ? service.operationalAnalysisReportV3(contextualRepositoryId(parsed.options, options.workingDirectory))
      : schemaVersion === 2
        ? service.operationalAnalysisReportV2(contextualRepositoryId(parsed.options, options.workingDirectory))
        : service.operationalAnalysisReport(contextualRepositoryId(parsed.options, options.workingDirectory), optionalString(parsed.options, 'session'));
  }
  if (command === 'analysis' && subcommand === 'status' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'session']);
    return service.operationalAnalysisStatus({
      ...(optionalString(parsed.options, 'repository-id') === undefined ? {} : { repositoryId: optionalString(parsed.options, 'repository-id') }),
      ...(optionalString(parsed.options, 'session') === undefined ? {} : { sessionId: optionalString(parsed.options, 'session') })
    });
  }
  if (command === 'experience' && subcommand === 'inspect' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository']);
    return service.cursorCaptureDiagnostics(diagnosticDirectory(parsed.options, options.workingDirectory));
  }
  if (command === 'validate' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope']); optionalScope(parsed.options); return service.validate();
  }
  if (command === 'inspect' && typeof subcommand === 'string' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json']); const entry = service.inspect(subcommand);
    if (!entry) throw new DomainError('NOT_FOUND', `Knowledge entry not found: ${subcommand}.`); return entry;
  }
  if (command === 'lessons' && subcommand === 'list' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope', 'repository-id', 'state', 'tag']);
    return service.list(filterOptions(parsed.options, options.workingDirectory));
  }
  if (command === 'retrieve' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope', 'repository-id', 'path', 'tool', 'tag', 'state']);
    const tag = optionalString(parsed.options, 'tag');
    return service.retrieve({ ...filterOptions(parsed.options, options.workingDirectory), path: optionalString(parsed.options, 'path'), tool: optionalString(parsed.options, 'tool'), ...(tag ? { tags: [tag] } : {}) });
  }
  if (command === 'export' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'scope', 'repository-id', 'state', 'tag', 'format']);
    const format = optionalString(parsed.options, 'format'); if (format && format !== 'json') throw new SyntaxError('Export format must be json.');
    return service.export(filterOptions(parsed.options, options.workingDirectory));
  }
  if (command === 'list' && subcommand === 'records' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'repository']); return service.listRecords(repositoryId(parsed.options, options.workingDirectory));
  }
  if (command === 'stats' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'repository']); return service.stats(repositoryId(parsed.options, options.workingDirectory));
  }
  if (command === 'evidence' && subcommand === 'session' && rest.length === 1) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json']);
    return service.sessionEvidence(rest[0]);
  }
  if (command === 'evidence' && subcommand === 'import' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'input']);
    const databasePath = parsed.options.has('data-dir')
      ? join(requiredString(parsed.options, 'data-dir'), 'experience.sqlite') : defaultDatabasePath();
    return importTypedEvidence(databasePath, requiredString(parsed.options, 'repository-id'), requiredString(parsed.options, 'input'));
  }
  if (command === 'status-global' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'repository', 'schema-version']);
    const schemaVersion = optionalSchemaVersion(parsed.options); const repository = optionalRepositoryId(parsed.options);
    return schemaVersion === 3 ? service.statusGlobalV3(repository?.id)
      : schemaVersion === 2 ? service.statusGlobalV2(repository?.id) : service.statusGlobal(repository?.id);
  }
  if (command === 'status' && subcommand === undefined && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository-id', 'repository', 'schema-version']);
    const schemaVersion = optionalSchemaVersion(parsed.options); const repository = repositorySelection(parsed.options, options.workingDirectory);
    return schemaVersion === 3 ? service.statusV3(repository)
      : schemaVersion === 2 ? service.statusV2(repository) : service.status(repository);
  }
  if (command === 'runtime' && subcommand === 'evaluate' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'input', 'json', 'profile', 'refresh']);
    return service.runtimeEvaluate(requiredString(parsed.options, 'input'), optionalRuntimeProfile(parsed.options), parsed.options.has('refresh'));
  }
  if (command === 'runtime' && subcommand === 'status' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json']); return service.runtimeStatus();
  }
  if (command === 'runtime' && subcommand === 'config' && rest.length === 1 && rest[0] === 'explain') {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'remote', 'workspace']);
    return service.runtimeConfigExplain(contextualRoot(parsed.options, 'workspace', options.workingDirectory), optionalString(parsed.options, 'remote'));
  }
  if (command === 'knowledge' && subcommand === 'validate' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository', 'trusted-ref']);
    return service.knowledgeValidate(contextualRoot(parsed.options, 'repository', options.workingDirectory), optionalString(parsed.options, 'trusted-ref'));
  }
  if (command === 'knowledge' && subcommand === 'refresh-runtime' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository', 'repository-id', 'trusted-ref']);
    const trustedRef = requiredString(parsed.options, 'trusted-ref');
    return service.knowledgeRefreshRuntime(
      contextualRoot(parsed.options, 'repository', options.workingDirectory),
      contextualRepositoryId(parsed.options, options.workingDirectory),
      trustedRef
    );
  }
  if (command === 'knowledge' && subcommand === 'promote' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'input', 'json', 'repository']);
    const input = requiredString(parsed.options, 'input');
    return service.knowledgePromote(contextualRoot(parsed.options, 'repository', options.workingDirectory), input);
  }
  if (command === 'hooks' && subcommand === 'verify' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['worktree', 'json']);
    throw new SyntaxError('Hook verification requires asynchronous CLI execution.');
  }
  if (command === 'hooks' && subcommand === 'diagnostics' && rest.length === 0) {
    assertNoUnknownOptions(parsed.options, ['data-dir', 'json', 'repository']);
    return service.cursorCaptureDiagnostics(diagnosticDirectory(parsed.options, options.workingDirectory));
  }
  if (command === 'skill') return executeSkill(parsed, options);
  throw invalidCommand(command);
}

function readBoundedRecoveryPlan(path: string): string {
  const maximumBytes = 256 * 1024;
  const descriptor = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximumBytes) throw new RangeError('Recovery plan exceeds 256 KiB.');
    return bytes.toString('utf8', 0, length);
  } finally { closeSync(descriptor); }
}

function diagnosticDirectory(options: Map<string, string | true>, workingDirectory?: string): string {
  const selected = optionalString(options, 'repository') ?? workingDirectory ?? process.cwd();
  return resolveCliContext(selected)?.root ?? selected;
}

function executeSkill(parsed: ParsedArguments, options: Pick<RunCliAsyncOptions, 'workingDirectory' | 'cliEntrypoint' | 'skillSourceDirectory' | 'homeDirectory'>): unknown {
  const [, subcommand, ...rest] = parsed.positionals;
  if (subcommand === 'validate' && rest.length === 1) {
    assertNoUnknownOptions(parsed.options, ['json']);
    return validateAelSkill(rest[0]);
  }
  if (!['install', 'update', 'status', 'uninstall'].includes(subcommand ?? '') || rest.length !== 0) throw invalidCommand('skill');
  const scope = requiredSkillScope(parsed.options);
  const mutation = subcommand !== 'status';
  assertNoUnknownOptions(parsed.options, skillOptions(scope, mutation));
  if (scope === 'global' && mutation && !parsed.options.has('yes')) throw new SyntaxError('Global skill mutations require --yes.');
  const location = skillLocation(scope, options, parsed.options);
  if (subcommand === 'status') return inspectAelSkill(location);
  const confirmed = parsed.options.has('yes');
  if (subcommand === 'install') return installAelSkill({ ...location, confirmed });
  if (subcommand === 'update') return updateAelSkill({ ...location, confirmed });
  return uninstallAelSkill({ scope: location.scope, workspace: location.workspace, home: location.home, confirmed });
}

function requiredSkillScope(options: Map<string, string | true>): AelSkillScope {
  const scope = requiredString(options, 'scope');
  if (scope !== 'workspace' && scope !== 'global') throw new SyntaxError('Skill scope must be workspace or global.');
  return scope;
}
function skillOptions(scope: AelSkillScope, mutation: boolean): readonly string[] {
  if (scope === 'workspace') return ['scope', 'workspace', 'json'];
  return mutation ? ['scope', 'yes', 'json'] : ['scope', 'json'];
}
function skillLocation(scope: AelSkillScope, options: Pick<RunCliAsyncOptions, 'workingDirectory' | 'cliEntrypoint' | 'skillSourceDirectory' | 'homeDirectory'>, parsed: Map<string, string | true>): AelSkillLocation {
  const workspace = optionalString(parsed, 'workspace') ?? options.workingDirectory ?? process.cwd();
  const home = options.homeDirectory ?? process.env.HOME;
  if (scope === 'global' && !home) throw new SyntaxError('Global skill operations require a home directory.');
  const entrypoint = options.cliEntrypoint ?? fileURLToPath(import.meta.url);
  return {
    source: options.skillSourceDirectory ?? join(dirname(entrypoint), '..', '..', 'skills', 'ael'),
    scope,
    workspace,
    home: home ?? workspace
  };
}

function parseReviewRequest(parsed: ParsedArguments) {
  const [command, subcommand, ...rest] = parsed.positionals;
  if (command !== 'review' || !['session', 'sessions'].includes(subcommand ?? '') || rest.length !== 0) throw invalidCommand(command);
  assertNoUnknownOptions(
    parsed.options,
    subcommand === 'sessions'
      ? ['json', 'source', 'root', 'project']
      : ['json', 'source', 'session', 'root', 'project', 'repository', 'profile', 'interactive', 'allow-expensive-checks']
  );
  const source = requiredReviewSource(parsed.options); const root = requiredString(parsed.options, 'root'); const project = optionalString(parsed.options, 'project');
  if (subcommand === 'sessions') return { kind: 'discover' as const, source, root, project };
  const session = optionalString(parsed.options, 'session');
  const repository = optionalString(parsed.options, 'repository');
  const interactive = parsed.options.has('interactive');
  if (session === 'latest' && (!interactive || !repository)) throw new SyntaxError('Interactive repository scope is required for session selection.');
  return { kind: 'review' as const, source, session, root, project, repository, interactive, profile: optionalReviewProfile(parsed.options), allowExpensiveChecks: parsed.options.has('allow-expensive-checks') };
}

function assertNoUnknownOptions(options: Map<string, string | true>, allowed: readonly string[]): void {
  for (const name of options.keys()) if (!allowed.includes(name)) throw new SyntaxError(`Unsupported option: --${name}.`);
}
function optionalString(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name); if (value === undefined) return undefined; if (value === true) throw new SyntaxError(`Option requires a value: --${name}.`); return value;
}
function optionalSchemaVersion(options: Map<string, string | true>): 2 | 3 | undefined {
  const version = optionalString(options, 'schema-version');
  if (version === undefined) return undefined;
  if (version !== '2' && version !== '3') throw new SyntaxError('Schema version must be 2 or 3.');
  return version === '2' ? 2 : 3;
}
function requiredString(options: Map<string, string | true>, name: string): string {
  const value = optionalString(options, name); if (value === undefined) throw new SyntaxError(`Option is required: --${name}.`); return value;
}
function requiredReviewSource(options: Map<string, string | true>): typeof reviewSources extends Set<infer Value> ? Value : never {
  const source = requiredString(options, 'source');
  if (!reviewSources.has(source as typeof reviewSources extends Set<infer Value> ? Value : never)) {
    throw new SyntaxError('Source must be codex, claude-code, or cursor.');
  }
  return source as typeof reviewSources extends Set<infer Value> ? Value : never;
}
function optionalReviewProfile(options: Map<string, string | true>): { id: string; version: string } | undefined {
  const value = optionalString(options, 'profile');
  if (value === undefined) return undefined;
  const [id, version, ...extra] = value.split('@');
  if (!id || !version || extra.length !== 0) throw new SyntaxError('Profile must be specified as id@version.');
  return { id, version };
}
function optionalRuntimeProfile(options: Map<string, string | true>): BuiltInRuntimeProfileId | undefined {
  const value = optionalString(options, 'profile');
  if (value === undefined) return undefined;
  if (!isBuiltInRuntimeProfileId(value)) throw new SyntaxError('Runtime profile must be normal, learning, or observe-only.');
  return value;
}
function optionalScope(options: Map<string, string | true>): KnowledgeScope | undefined {
  const scope = optionalString(options, 'scope'); if (scope === undefined) return undefined; if (!scopes.has(scope as typeof scopes extends Set<infer Value> ? Value : never)) throw new SyntaxError('Scope must be global or repo.'); return scope === 'repo' ? 'repository' : 'global';
}
function optionalInitScope(options: Map<string, string | true>): 'global' | 'repo' | 'workspace' | undefined {
  const scope = optionalString(options, 'scope');
  if (scope === undefined) return undefined;
  if (!initScopes.has(scope as 'global' | 'repo' | 'workspace')) throw new SyntaxError('Scope must be global, repo, or workspace.');
  return scope as 'global' | 'repo' | 'workspace';
}
function optionalCaptureRepositoryId(options: Map<string, string | true>): RepositoryId | undefined {
  const repositoryId = optionalString(options, 'repository-id');
  if (repositoryId === undefined) return undefined;
  if (repositoryId.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(repositoryId)) {
    throw new SyntaxError('Capture repository identifier is invalid.');
  }
  return repositoryId as RepositoryId;
}
function optionalState(options: Map<string, string | true>): KnowledgeState | undefined {
  const state = optionalString(options, 'state'); if (state === undefined) return undefined; if (!states.has(state as KnowledgeState)) throw new SyntaxError('Knowledge state is unsupported.'); return state as KnowledgeState;
}
function filterOptions(options: Map<string, string | true>, workingDirectory?: string) {
  const scope = optionalScope(options);
  const state = optionalState(options);
  const explicitRepositoryId = optionalString(options, 'repository-id');
  const repositoryId = explicitRepositoryId ?? (scope === 'repository' ? contextualRepositoryId(options, workingDirectory) : undefined);
  return { scope, repositoryId, state, tag: optionalString(options, 'tag') };
}
function optionalRepositoryId(options: Map<string, string | true>): { readonly id: string; readonly root?: string } | undefined {
  const explicit = optionalString(options, 'repository-id'); const path = optionalString(options, 'repository');
  if (explicit !== undefined && path !== undefined) throw new SyntaxError('Repository id and repository path cannot be combined.');
  if (path === undefined) return explicit === undefined ? undefined : { id: explicit };
  const repository = resolveRepositoryRoot(path);
  if (repository === undefined) throw new DomainError('REPOSITORY_ROOT_REQUIRED', 'Repository path must be a Git top-level directory.');
  return repository;
}
function repositorySelection(options: Map<string, string | true>, workingDirectory?: string): { readonly id: string; readonly root?: string } {
  const selected = optionalRepositoryId(options);
  if (selected !== undefined) return selected;
  const context = resolveCliContext(workingDirectory ?? process.cwd());
  if (context === undefined) return requiredContext('repository or workspace', '--repository-id');
  return { id: context.id, root: context.root };
}
function repositoryId(options: Map<string, string | true>, workingDirectory?: string): string {
  return repositorySelection(options, workingDirectory).id;
}
function contextualRepositoryId(options: Map<string, string | true>, workingDirectory?: string): string {
  const explicit = optionalString(options, 'repository-id');
  if (explicit !== undefined) return explicit;
  const selectedRoot = optionalString(options, 'repository');
  const context = resolveCliContext(selectedRoot ?? workingDirectory ?? process.cwd());
  return context?.id ?? requiredContext('repository or workspace', '--repository-id');
}
function contextualRoot(options: Map<string, string | true>, option: 'repository' | 'workspace', workingDirectory?: string): string {
  const explicit = optionalString(options, option);
  if (explicit !== undefined) return explicit;
  const context = resolveCliContext(workingDirectory ?? process.cwd());
  return context?.root ?? requiredContext('repository or workspace', `--${option}`);
}
function requiredContext(kind: string, option: string): never {
  throw new DomainError('CONTEXT_REQUIRED', `A ${kind} is required. Pass ${option} or run the command inside a configured AEL workspace.`);
}
function success(value: unknown, json: boolean, positionals: readonly string[], humanOutput?: HumanRenderOptions, context?: CommandPresentationContext): CliResult {
  const version2 = value as { schemaVersion?: number; installation?: { state?: string } };
  const exitCode = (positionals[0] === 'runtime' && positionals[1] === 'evaluate' && (value as { outcome?: string }).outcome === 'BLOCK')
    || (positionals[0] === 'status' && (version2.schemaVersion === 2 || version2.schemaVersion === 3 ? version2.installation?.state !== 'ready' : (value as { status?: string }).status !== 'ready'))
    || (positionals[0] === 'hooks' && positionals[1] === 'verify' && (value as { status?: string }).status !== 'ready') ? 1 : 0;
  return json ? { exitCode, stdout: `${JSON.stringify(value)}\n`, stderr: '' } : { exitCode, stdout: `${renderCommandResult(value, positionals, humanOutput, context)}\n`, stderr: '' };
}

function commandPresentationContext(parsed: ParsedArguments, workingDirectory?: string): CommandPresentationContext | undefined {
  if (parsed.positionals[0] !== 'init') return undefined;
  const scope = optionalString(parsed.options, 'scope');
  if (scope !== 'global' && scope !== 'repo' && scope !== 'workspace') return undefined;
  if (scope === 'global') return { initialization: { scope } };
  const resolved = scope === 'repo'
    ? resolveRepositoryRoot(workingDirectory ?? process.cwd())
    : resolveCliContext(workingDirectory ?? process.cwd());
  return {
    initialization: {
      scope,
      ...(resolved === undefined ? {} : { id: resolved.id, root: resolved.root })
    }
  };
}
function invalidCommand(command: string | undefined): SyntaxError {
  return new SyntaxError(command !== undefined && knownCommands.has(command)
    ? `Unknown command form for ${command}.`
    : 'Unknown command.');
}
function usage(): string {
  return [
    'Usage: ael <command> [options]',
    '',
    'Setup',
    '  init [--workspace-id <slug>]',
    '  init --scope global',
    '  init --scope repo --hooks <codex,cursor>',
    '  init --scope workspace --hooks <codex,cursor> [--workspace-id <slug>]',
    '  installation qualify --repository <path> [--json]',
    '  installation plan --repository <path> --manifest <build-manifest.json> --output <plan.json>',
    '  installation apply --input <plan.json> [--json]',
    '  installation rollback --input <plan.json> [--json]',
    '  installation inspect [--repository <path>|--repository-id <id>] [--json]',
    '  benchmark identity [--json]',
    '  benchmark run --manifest <run.json> --output <report.json>',
    '  benchmark compare --baseline <report.json> --candidate <report.json> --output <comparison.json>',
    '  advice configure --repository-id <id> --enabled true|false --json',
    '  advice status --repository-id <id> --json',
    '  advice retrieve --input <context.json> --json',
    '  candidates list --repository-id <id> [--state <state>] --json',
    '  candidates inspect <id> --repository-id <id> --json',
    '  unregister [--repository-id <id>]',
    '  status [--repository <path>|--repository-id <id>] [--schema-version <2|3>]',
    '  status-global [--repository <path>|--repository-id <id>] [--schema-version <2|3>]',
    '  hooks verify --worktree <path>',
    '  hooks diagnostics [--repository <path>]',
    '',
    'Observation',
    '  experience add --input <path>',
    '  experience inspect [--repository <path>]',
    '  validate [--scope <global|repo>]',
    '  inspect <knowledge-id>',
    '  list records [--repository <path>|--repository-id <id>]',
    '  stats [--repository <path>|--repository-id <id>]',
    '  evidence session <session-id>',
    '  evidence import --repository-id <id> --input <artifact.json> --json',
    '  capture drain',
    '  capture status',
    '  capture recovery plan --repository-id <id> --output <plan.json> [--limit <1..100>] [--cursor <id>]',
    '  capture recovery apply --input <plan.json> --json',
    '  analysis run [--repository-id <id>]',
    '  analysis reconcile --repository-id <id> [--apply] [--after-session <id>] --json',
    '  analysis report [--repository-id <id>] [--session <id>] [--schema-version <2|3>]',
    '  analysis status [--repository-id <id>] [--session <id>]',
    '  analysis worker',
    '',
    'Review',
    '  review sessions --source <codex|claude-code|cursor> --root <path> [--project <path>]',
    '  review session --source <codex|claude-code|cursor> --root <path> [--session <id|latest>] [--repository <id>] [--interactive]',
    '',
    'Runtime',
    '  runtime evaluate --input <path> [--profile <normal|learning|observe-only>] [--refresh]',
    '  runtime status',
    '  runtime config explain [--workspace <path>] [--remote <url>]',
    '',
    'Knowledge',
    '  lessons list [--scope <global|repo>] [--repository-id <id>] [--state <state>] [--tag <tag>]',
    '  retrieve [--scope <global|repo>] [--repository-id <id>] [--path <path>] [--tool <tool>]',
    '  export [--scope <global|repo>] [--repository-id <id>] [--format json]',
    '  knowledge validate [--repository <path>] [--trusted-ref <ref>]',
    '  knowledge refresh-runtime [--repository <path>] [--repository-id <id>] --trusted-ref <ref>',
    '  knowledge promote [--repository <path>] --input <path>',
    '',
    'Skills',
    '  skill install|update|status|uninstall --scope <workspace|global> [--workspace <path>] [--yes]',
    '  skill validate <path>',
    '',
    'Options: --json emits the stable machine-readable protocol. --data-dir <path> selects AEL storage.',
    'Context: explicit option > nearest .ael/workspace.json > Git root > interactive prompt.'
  ].join('\n');
}
function toDiagnostic(error: unknown, fallbackCode: string): { code: string; message: string } {
  return error instanceof DomainError || error instanceof RuntimeServiceError
    ? { code: error.code, message: error.message }
    : error instanceof DiagnosticWorkspaceConfigurationError
      ? { code: error.code, message: error.message }
    : error instanceof AelSkillError
      ? { code: error.code, message: error.message.replace(`${error.code}: `, '') }
    : { code: fallbackCode, message: errorMessage(error) };
}

function nextStep(code: string, args: readonly string[] = []): string | undefined {
  if (code === 'WORKSPACE_CONFIGURATION_ERROR') {
    return 'Repair or remove the nearest `.ael/workspace.json`, then retry.';
  }
  if (code === 'CONTEXT_REQUIRED' || code === 'REPOSITORY_REQUIRED' || code === 'REPOSITORY_ROOT_REQUIRED') {
    const positionals = safePositionals(args);
    if (positionals[0] === 'init') return 'Change to a Git top-level directory or use `ael init --scope workspace --hooks <sources>`.';
    if (positionals[0] === 'runtime' && positionals[1] === 'config') return 'Run `ael init` in the workspace or pass --workspace.';
    if (positionals[0] === 'knowledge') {
      if (positionals[1] === 'refresh-runtime') return 'Run `ael init` in the workspace or pass --repository and --repository-id.';
      return 'Run `ael init` in the workspace or pass --repository.';
    }
    return 'Run `ael init` in the workspace or pass --repository-id.';
  }
  if (code === 'INVALID_SYNTAX') return 'Run `ael --help` to inspect supported command forms.';
  if (code === 'NOT_FOUND') return 'Check the requested identifier and selected repository or workspace.';
  return undefined;
}

function safePositionals(args: readonly string[]): readonly string[] {
  try { return parseArguments(args).positionals; } catch { return []; }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const result = await runCliAsync(process.argv.slice(2), {
    ingestionDiagnosticWrite: writeProcessStderr,
    contextPrompt: createProcessContextPrompt(),
    humanOutput: {
      color: Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined),
      ...(process.stdout.columns === undefined ? {} : { width: process.stdout.columns })
    }
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode;
}

function writeProcessStderr(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      process.stderr.write(line, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

function executeInstallation(parsed: ParsedArguments, options: Pick<RunCliAsyncOptions, 'workingDirectory'>): unknown {
  if (parsed.positionals.length !== 2) throw new SyntaxError('Unknown installation command.');
  const command = parsed.positionals[1];
  if (command === 'inspect') {
    assertNoUnknownOptions(parsed.options, ['repository', 'repository-id', 'json', 'data-dir']);
    const selection = optionalRepositoryId(parsed.options);
    if (selection && !selection.root) {
      const dataDir = optionalString(parsed.options, 'data-dir');
      const registrations = registeredInstallationRoots(dataDir === undefined ? defaultDatabasePath() : join(dataDir, 'experience.sqlite'), selection.id);
      if (!registrations.length) throw new SyntaxError('Repository ID is not registered.');
      return inspectInstallation(registrations[0].root, registrations[0].id);
    }
    const repository = selection ?? resolveRepository(options.workingDirectory ?? process.cwd());
    if (!repository?.root) throw new SyntaxError('Repository root required.');
    return inspectInstallation(repository.root, repository.id);
  }
  if (command === 'qualify') {
    assertNoUnknownOptions(parsed.options, ['repository', 'json']);
    const root = resolveRepositoryRoot(requiredString(parsed.options, 'repository'));
    if (!root) throw new SyntaxError('Repository root required.');
    return qualifyInstallation(root.root);
  }
  if (command === 'plan') {
    assertNoUnknownOptions(parsed.options, ['repository', 'manifest', 'output', 'json']);
    const plan = createAlignmentPlan(requiredString(parsed.options, 'repository'), requiredString(parsed.options, 'manifest'));
    writeFileSync(requiredString(parsed.options, 'output'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { status: 'planned', planId: plan.planId, buildId: plan.buildId };
  }
  if (command === 'apply' || command === 'rollback') {
    assertNoUnknownOptions(parsed.options, ['input', 'json']);
    return applyAlignmentPlan(JSON.parse(readFileSync(requiredString(parsed.options, 'input'), 'utf8')), { rollback: command === 'rollback' });
  }
  throw new SyntaxError('Unknown installation command.');
}

function executeBenchmark(parsed: ParsedArguments): unknown {
  if (parsed.positionals.length !== 2) throw new SyntaxError('Unknown benchmark command.');
  const command = parsed.positionals[1];
  if (command === 'identity') {
    assertNoUnknownOptions(parsed.options, ['json']);
    return currentBuildIdentity();
  }
  if (command === 'run') {
    assertNoUnknownOptions(parsed.options, ['manifest', 'output', 'json']);
    return runBaseline(requiredString(parsed.options, 'manifest'), requiredString(parsed.options, 'output'));
  }
  if (command === 'compare') {
    assertNoUnknownOptions(parsed.options, ['baseline', 'candidate', 'output', 'json']);
    return compareBaseline(requiredString(parsed.options, 'baseline'), requiredString(parsed.options, 'candidate'), requiredString(parsed.options, 'output'));
  }
  throw new SyntaxError('Unknown benchmark command.');
}
