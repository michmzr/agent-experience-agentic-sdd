import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TextDecoder } from 'node:util';
import { attachCodexAdviceExposure, isHostAdviceExposureWitnessForChild,
  type HostAdviceExposureScope } from '../advice/codex-exposure.js';
import { qualifiedCodexCli, spawnVerifiedCodexExec } from '../host/codex-cli-launcher.js';
import { runningBuild, runningPackageRoot } from '../installation/build-manifest.js';
import { codexCliJsonSourceEventId, observeVerifiedCodexCliJsonChild } from '../capture/adapters/codex-cli-json.js';
import { attachVerifiedCodexPassiveCapture, isDirectCliPassiveResultForChild,
  type DirectCliPassiveResult } from '../capture/direct-cli-ingress.js';
import type { TrustedCodexCliJsonStream } from '../capture/adapters/codex-cli-json.js';
import type { NormalizedCaptureEvent } from '../capture/contracts.js';
import { AdvisoryUsageStore } from '../advice/usage.js';
import { AdvisoryConfigurationStore } from '../advice/configuration.js';
import { runCli } from '../cli.js';
import { ExperienceStore } from '../storage/experience-store.js';
import { writeFileSync } from 'node:fs';
import { buildIdentity, digest } from './manifest.js';
import { assessPairedPilot, type PilotTrial } from './pilot.js';
import { CodexTrialProjection } from './codex-trial.js';
import { createRealPairedProtocol, type RealPairedProtocol } from './paired.js';
import { checkPackageManagerScenario, gitMetadataDigest, packageManagerFixtureDigest, packageManagerTask,
  preparePackageManagerScenario, resetPackageManagerScenario } from './real-scenario.js';
import { observeRealOutcome } from './real-outcome.js';
import { prepareRealAdviceScope, prepareRealAdviceSeed, realAdviceInvocation,
  realSelectionInvocation, type RealAdviceSeed } from './real-advice.js';

export interface RealTrialResult { readonly slotIndex: number; readonly protocolDigest: string;
  readonly buildId: string; readonly status: 'complete' | 'unsupported'; readonly pilot: PilotTrial | null;
  readonly totalWallMilliseconds: number | null;
  readonly operationSource: 'cli-json-item' | 'unsupported';
  readonly operations: readonly { readonly id: string; readonly kind: string;
    readonly outcome: 'succeeded' | 'failed' | 'unknown' }[];
  readonly unsupportedCode: 'source-not-qualified' | null }

const directResults = new WeakSet<RealTrialResult>();
const contexts = new WeakSet<RealSeriesContext>();
const runningContexts = new WeakSet<RealSeriesContext>();

export interface RealSeriesContext { readonly root: string; readonly seedDir: string;
  readonly seedStoreDigest: string; readonly gitDigest: string; readonly adviceSeed: RealAdviceSeed }

/** Run two qualified A sessions once, then freeze the reviewed store before any B slot. */
export async function prepareRealSeries(binaryPath: string): Promise<RealSeriesContext> {
  const root = mkdtempSync(join(tmpdir(), 'avb-real-series-'));
  const seedDir = mkdtempSync(join(tmpdir(), 'avb-real-seed-'));
  try {
    preparePackageManagerScenario(root);
    const version = execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8', timeout: 10_000,
      maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (version !== '12.6.0') throw new TypeError('Package manager runtime differs from frozen scenario.');
    const initialGitDigest = gitMetadataDigest(root);
    const adviceSeed = await prepareRealAdviceSeed(root, seedDir, binaryPath);
    if (checkPackageManagerScenario(root, [], initialGitDigest).safetyViolations.length !== 0) {
      throw new TypeError('Session A changed the fixed scenario.');
    }
    const seedStoreDigest = storeDigest(seedDir);
    const context = Object.freeze({ root, seedDir, seedStoreDigest,
      gitDigest: gitMetadataDigest(root), adviceSeed });
    contexts.add(context);
    return context;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
    throw error;
  }
}

export function closeRealSeries(context: RealSeriesContext): void {
  if (!contexts.has(context) || runningContexts.has(context)) throw new TypeError('Real series context is unavailable.');
  contexts.delete(context);
  rmSync(context.root, { recursive: true, force: true });
  rmSync(context.seedDir, { recursive: true, force: true });
}

export function codexTrialArguments(agent: RealPairedProtocol['agent'], root: string, prompt: string): string[] {
  if (agent.model !== 'gpt-6-sol' || `codex-cli ${agent.cliVersion}` !== qualifiedCodexCli.version
    || agent.binarySha256 !== qualifiedCodexCli.sha256
    || agent.sandbox !== 'workspace-write'
    || agent.approval !== 'never') throw new TypeError('Codex trial agent configuration changed.');
  return ['-a', 'never', 'exec', '--json', '--ephemeral', '--ignore-user-config',
    '-m', agent.model, '-C', root, '-s', agent.sandbox, prompt];
}

export function realTrialPrompt(condition: RealPairedProtocol['order'][number]['condition'],
  retrievalInvocation: string, selectionInvocation: string): string {
  return condition === 'advice'
    ? `First run this exact retrieval command: ${retrievalInvocation}\nWhen its JSON status is ready, run a separate echo command containing the literal deliveryChallenge value. Then run this exact selection command: ${selectionInvocation}\nAfter selection, complete this task: ${packageManagerTask}`
    : packageManagerTask;
}

export function isQualifiedPassiveTrialCapture(result: DirectCliPassiveResult | null,
  child: ChildProcess, stream: TrustedCodexCliJsonStream): boolean {
  return result !== null && isDirectCliPassiveResultForChild(result, child)
    && result.source === 'cli-json-item' && result.status === 'captured'
    && result.stream === stream && result.stream.sessionId === stream.sessionId
    && result.admitted === stream.events.length + 2;
}

/** A trial is created only from this process's direct Codex child, never imported JSONL. */
export async function runRealTrial(protocol: RealPairedProtocol, slotIndex: number, buildRoot: string,
  binaryPath: string, context: RealSeriesContext): Promise<RealTrialResult> {
  const fixed = verifyProtocol(protocol);
  if (!contexts.has(context) || runningContexts.has(context) || context.seedStoreDigest !== fixed.seedStoreDigest
    || storeDigest(context.seedDir) !== fixed.seedStoreDigest) throw new TypeError('Real series seed is unavailable or changed.');
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= fixed.order.length) throw new TypeError('Trial slot is invalid.');
  const slot = fixed.order[slotIndex]!;
  const expectedBuild = slot.condition === 'disabled' ? fixed.baselineBuildId : fixed.candidateBuildId;
  if (buildIdentity(buildRoot) !== expectedBuild) throw new TypeError('Trial build differs from frozen protocol.');
  if (slot.condition !== 'disabled' && (!runningBuild()
    || buildIdentity(runningPackageRoot) !== expectedBuild)) {
    throw new TypeError('Running AEL artifact differs from frozen candidate build.');
  }
  runningContexts.add(context);
  const root = context.root;
  const dataDir = mkdtempSync(join(tmpdir(), 'avb-real-ael-'));
  const unsupported = (): RealTrialResult => bind(Object.freeze({ slotIndex, protocolDigest: fixed.protocolDigest,
    buildId: expectedBuild, status: 'unsupported', pilot: null, operationSource: 'unsupported',
    totalWallMilliseconds: null, operations: Object.freeze([]), unsupportedCode: 'source-not-qualified' }));
  try {
    resetPackageManagerScenario(root, context.gitDigest);
    if (slot.condition !== 'disabled') {
      copyFileSync(join(context.seedDir, 'experience.sqlite'), join(dataDir, 'experience.sqlite'));
      copyFileSync(join(context.seedDir, 'advice.sqlite'), join(dataDir, 'advice.sqlite'));
      if (slot.condition === 'passive') {
        const configured = runCli(['advice', 'configure', '--repository-id', context.adviceSeed.repositoryId,
          '--enabled', 'false', '--data-dir', dataDir, '--json'], { workingDirectory: root });
        if (configured.exitCode !== 0 || new AdvisoryConfigurationStore(join(dataDir, 'advice.sqlite'))
          .status(context.adviceSeed.repositoryId).enabled) return unsupported();
      } else if (!new AdvisoryConfigurationStore(join(dataDir, 'advice.sqlite'))
        .status(context.adviceSeed.repositoryId).enabled) return unsupported();
    }
    const retrievalInvocation = slot.condition === 'advice' ? realAdviceInvocation(buildRoot, dataDir) : '';
    const selectionInvocation = slot.condition === 'advice' ? realSelectionInvocation(buildRoot, dataDir) : '';
    const prompt = realTrialPrompt(slot.condition, retrievalInvocation, selectionInvocation);
    const child = await spawnVerifiedCodexExec({ binaryPath, cwd: root,
      args: codexTrialArguments(fixed.agent, root, prompt) });
    const passiveCapture = slot.condition === 'disabled' ? null
      : attachVerifiedCodexPassiveCapture(child, { databasePath: join(dataDir, 'experience.sqlite'),
        repositoryId: context.adviceSeed.repositoryId as never, workingDirectory: root })
        .then(value => value, () => null);
    const trustedStream = slot.condition === 'disabled'
      ? observeVerifiedCodexCliJsonChild(child).then(value => value, () => null)
      : passiveCapture!.then(value => value?.stream ?? null);
    let adviceScope: HostAdviceExposureScope | undefined;
    const exposure = slot.condition === 'advice' ? attachCodexAdviceExposure(child, (threadId: string) => {
      adviceScope = prepareRealAdviceScope(root, dataDir, buildRoot, context.adviceSeed,
        threadId, `avb-real-retrieval-${slotIndex}`);
      return adviceScope;
    }) : Promise.resolve(null);
    const projection = new CodexTrialProjection(fixed.agent.cliVersion, slot.scenarioId,
      slot.condition === 'advice' ? selectionInvocation : undefined);
    const started = process.hrtime.bigint();
    const decoder = new TextDecoder();
    let pending = '';
    let bytes = 0;
    let invalid = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (invalid) return;
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { invalid = true; child.kill(); return; }
      pending += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(pending, 'utf8') > 128 * 1024) { invalid = true; child.kill(); return; }
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        try { projection.accept(JSON.parse(pending.slice(0, newline)) as unknown, new Date().toISOString()); }
        catch { invalid = true; child.kill(); return; }
        pending = pending.slice(newline + 1);
      }
    });
    child.stderr?.resume();
    const timer = setTimeout(() => child.kill(), fixed.budgets.wallMilliseconds);
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => resolve({ code: null, signal: null }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    const childWallMilliseconds = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const stream = await trustedStream;
    const passiveResult = await passiveCapture;
    const observedExposure = await exposure;
    if (pending && !invalid) {
      try { projection.accept(JSON.parse(pending + decoder.decode()) as unknown, new Date().toISOString()); }
      catch { invalid = true; }
    }
    const projected = invalid ? null : projection.finish();
    const trustedStarts = stream?.events.filter(event => event.phase === 'pre-action') ?? [];
    const trustedResults = stream?.events.filter(event => event.phase === 'post-result') ?? [];
    if (closed.code !== 0 || closed.signal !== null || !stream || projected?.status !== 'observed'
      || trustedStarts.length !== projected.operations.length || trustedResults.length !== projected.operations.length
      || projected.operations.some((operation, index) => trustedStarts[index]?.sourceEventId !== operation.id
        || trustedResults[index]?.relatedEventId !== operation.id || trustedResults[index]?.outcome !== operation.outcome)
      || (fixed.budgets.tokens !== null && (projected.tokens === null || projected.tokens > fixed.budgets.tokens))) return unsupported();
    if (slot.condition !== 'disabled' && (!isQualifiedPassiveTrialCapture(passiveResult, child, stream)
      || !await verifyPublicPassiveCapture(dataDir, context.adviceSeed.repositoryId, stream, passiveResult!.admitted)
      || (slot.condition === 'passive' && !isPassiveAdviceAbsent(dataDir,
        context.adviceSeed.repositoryId, stream.sessionId)))) {
      return unsupported();
    }
    if (slot.condition === 'advice') {
      if (!adviceScope || stream.sessionId !== adviceScope.sessionId
        || !observedExposure || !isHostAdviceExposureWitnessForChild(observedExposure, child)) return unsupported();
      const echoId = codexCliJsonSourceEventId(stream.sessionId, observedExposure.echoItemId, 'start');
      const echoIndex = projected.operations.findIndex(operation => operation.id === echoId);
      const selectionIndex = projected.operations.findIndex(operation => operation.kind === 'advice-selection'
        && operation.outcome === 'succeeded');
      const checkIndex = projected.operations.findIndex(operation => operation.kind === 'package-manager-check'
        && operation.outcome === 'succeeded');
      if (echoIndex < 0 || selectionIndex <= echoIndex || checkIndex <= selectionIndex
        || projected.operations.filter(operation => operation.kind === 'advice-selection').length !== 1) return unsupported();
      const usage = new AdvisoryUsageStore(join(dataDir, 'advice.sqlite'));
      if (!usage.facts(adviceScope.bundleId).some(fact => fact.kind === 'selected'
        && fact.origin === 'agent-selection')) return unsupported();
      const appliedPath = join(dataDir, 'applied.json');
      writeFileSync(appliedPath, JSON.stringify({ repositoryId: adviceScope.repositoryId,
        lessonId: adviceScope.lessonId, lessonRevision: adviceScope.lessonRevision,
        sessionId: adviceScope.sessionId, contextRevision: adviceScope.contextRevision,
        bundleId: adviceScope.bundleId, kind: 'applied',
        origin: 'operation-evidence', witnessRef: projected.operations[checkIndex]!.id }), { flag: 'wx' });
      const applied = runCli(['advice', 'record', '--input', appliedPath, '--data-dir', dataDir, '--json'],
        { workingDirectory: root });
      if (applied.exitCode !== 0 || !usage.facts(adviceScope.bundleId).some(fact => fact.kind === 'applied'
        && fact.origin === 'operation-evidence' && fact.witnessRef === projected.operations[checkIndex]!.id)) return unsupported();
    }
    const checked = checkPackageManagerScenario(root, projected.operations, context.gitDigest);
    if (slot.condition === 'advice' && checked.taskCorrect) {
      if (!adviceScope) return unsupported();
      const usage = new AdvisoryUsageStore(join(dataDir, 'advice.sqlite'));
      const bundle = usage.bundle(adviceScope.bundleId);
      const appliedEventId = projected.operations.find(operation => operation.kind === 'package-manager-check'
        && operation.outcome === 'succeeded')?.id;
      if (!bundle || !appliedEventId) return unsupported();
      const outcome = observeRealOutcome({ root, expectedGitDigest: context.gitDigest,
        protocolDigest: fixed.protocolDigest, bundle, appliedEventId,
        operations: projected.operations, stream });
      if (!outcome) return unsupported();
      usage.recordObservedDeterministicOutcome(outcome, stream);
    }
    if (childWallMilliseconds > fixed.budgets.wallMilliseconds
      || Number((process.hrtime.bigint() - started) / 1_000_000n) > fixed.budgets.wallMilliseconds) {
      return unsupported();
    }
    const pilot: PilotTrial = Object.freeze({ scenarioId: slot.scenarioId, condition: slot.condition, pair: slot.pair,
      taskCorrect: checked.taskCorrect, redundantOperationIds: projected.redundantOperationIds,
      safetyViolations: checked.safetyViolations,
      wallMilliseconds: slot.condition === 'disabled' ? childWallMilliseconds : null,
      aelOverheadMilliseconds: null, tokens: projected.tokens });
    return bind(Object.freeze({ slotIndex, protocolDigest: fixed.protocolDigest, buildId: expectedBuild,
      status: 'complete', pilot, operationSource: 'cli-json-item',
      totalWallMilliseconds: childWallMilliseconds,
      operations: Object.freeze([...projected.operations]), unsupportedCode: null }));
  } finally {
    runningContexts.delete(context);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Public drain/status must account for every direct child event before a passive slot qualifies. */
export async function verifyPublicPassiveCapture(dataDir: string, repositoryId: string,
  stream: TrustedCodexCliJsonStream, admitted: number,
  cumulativeAdmitted = admitted): Promise<boolean> {
  const drain = runCli(['capture', 'drain', '--data-dir', dataDir, '--json']);
  if (drain.exitCode !== 0) return false;
  const run = runCli(['analysis', 'run', '--repository-id', repositoryId,
    '--data-dir', dataDir, '--json']);
  if (run.exitCode !== 0) return false;
  const deadline = Date.now() + 10_000;
  let analysisStatus: Record<string, unknown> | undefined;
  do {
    const analysis = runCli(['analysis', 'status', '--repository-id', repositoryId,
      '--session', stream.sessionId, '--data-dir', dataDir, '--json']);
    if (analysis.exitCode !== 0) return false;
    try { analysisStatus = JSON.parse(analysis.stdout) as Record<string, unknown>; }
    catch { return false; }
    const jobs = analysisStatus.jobs as Record<string, unknown> | undefined;
    if (jobs?.completed && jobs.pending === 0 && jobs.running === 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  const status = runCli(['capture', 'status', '--data-dir', dataDir, '--json']);
  if (status.exitCode !== 0 || !analysisStatus) return false;
  try {
    const spool = JSON.parse(status.stdout) as Record<string, unknown>;
    const store = new ExperienceStore(join(dataDir, 'experience.sqlite'));
    try {
      const persisted = readPersistedPassiveEvents(store, stream.sessionId);
      return hasCompletePassiveState(spool, analysisStatus, persisted, stream, cumulativeAdmitted);
    } finally { store.close(); }
  } catch { return false; }
}

/** Direct CLI spool uses the legacy session event table, not capture-run conversation events. */
export function readPersistedPassiveEvents(store: ExperienceStore,
  sessionId: string): readonly NormalizedCaptureEvent[] {
  return store.loadCapturedSession(sessionId as never)?.events ?? [];
}

export function isPassiveAdviceAbsent(dataDir: string, repositoryId: string, sessionId: string): boolean {
  try {
    if (new AdvisoryConfigurationStore(join(dataDir, 'advice.sqlite')).status(repositoryId).enabled) return false;
    const database = new DatabaseSync(join(dataDir, 'advice.sqlite'), { readOnly: true, timeout: 125 });
    try {
      const usageTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'advice_usage_bundles'").get();
      if (!usageTable) return true;
      const row = database.prepare(`SELECT COUNT(*) AS count FROM advice_usage_bundles
        WHERE repository_id = ? AND session_id = ?`).get(repositoryId, sessionId) as { count: number };
      return row.count === 0;
    } finally { database.close(); }
  } catch { return false; }
}

/** Structural check only. Direct-child provenance is established separately. */
export function hasCompletePassiveState(spool: Record<string, unknown>, analysisStatus: Record<string, unknown>,
  persisted: readonly NormalizedCaptureEvent[], stream: Pick<TrustedCodexCliJsonStream, 'sessionId' | 'events'>,
  admitted: number): boolean {
  const jobs = analysisStatus.jobs as Record<string, unknown> | undefined;
  if (spool.version !== 1 || spool.admitted !== admitted || spool.committed !== admitted
    || spool.pending !== 0 || spool.claimed !== 0 || spool.quarantined !== 0
    || spool.failedAdmission !== 0 || analysisStatus.version !== 1 || !jobs
    || !['pending', 'running', 'completed', 'retryable-failure', 'quarantined-input']
      .every(key => Number.isSafeInteger(jobs[key]) && (jobs[key] as number) >= 0)
    || jobs.pending !== 0 || jobs.running !== 0 || (jobs.completed as number) < 1
    || jobs['retryable-failure'] !== 0 || jobs['quarantined-input'] !== 0
    || !Number.isSafeInteger(analysisStatus.uniqueAcknowledgedEvents)
    || (analysisStatus.uniqueAcknowledgedEvents as number) < stream.events.length
    || persisted.length !== stream.events.length) return false;
  const retained = new Map(persisted.map(event => [event.sourceEventId, event]));
  return retained.size === stream.events.length && stream.events.every(event => {
    const row = retained.get(event.sourceEventId);
    return row?.id === event.id && row.phase === event.phase && row.sessionId === stream.sessionId
      && row.outcome === event.outcome && row.exitStatus === event.exitStatus
      && row.relatedEventId === event.relatedEventId;
  });
}

export function assessRealSeries(protocol: RealPairedProtocol, trials: readonly RealTrialResult[]) {
  const fixed = verifyProtocol(protocol);
  if (!Array.isArray(trials) || trials.length > fixed.order.length) throw new TypeError('Real trial series exceeds slots.');
  const seen = new Set<number>();
  const qualified: PilotTrial[] = [];
  for (const result of trials) {
    if (!directResults.has(result) || result.protocolDigest !== fixed.protocolDigest
      || !Number.isSafeInteger(result.slotIndex) || result.slotIndex < 0 || result.slotIndex >= fixed.order.length
      || seen.has(result.slotIndex)) throw new TypeError('Trial is not bound to this direct runner and protocol.');
    seen.add(result.slotIndex);
    const slot = fixed.order[result.slotIndex]!;
    const expectedBuild = slot.condition === 'disabled' ? fixed.baselineBuildId : fixed.candidateBuildId;
    if (result.buildId !== expectedBuild) throw new TypeError('Trial build differs from frozen protocol.');
    if (result.status === 'complete' && result.pilot) qualified.push(result.pilot);
  }
  const assessed = assessPairedPilot(qualified);
  return Object.freeze({ ...assessed, status: qualified.length === fixed.order.length
    || assessed.status === 'safety-fail' || assessed.status === 'correctness-fail' ? assessed.status : 'incomplete',
    conclusion: qualified.length === fixed.order.length ? assessed.conclusion : 'performance-not-established',
    observedTrials: qualified.length, requiredTrials: fixed.order.length,
    totalWallMilliseconds: totalWallDistribution(trials, fixed.order) });
}

/** Exact observed total child times by condition; null telemetry is omitted, never coerced to zero. */
export function totalWallDistribution(trials: readonly Pick<RealTrialResult,
  'slotIndex' | 'totalWallMilliseconds'>[], order: readonly Pick<RealPairedProtocol['order'][number], 'condition'>[]) {
  const values: { disabled: number[]; passive: number[]; advice: number[] } = {
    disabled: [], passive: [], advice: []
  };
  for (const trial of trials) {
    const condition = order[trial.slotIndex]?.condition;
    if (condition && trial.totalWallMilliseconds !== null
      && Number.isSafeInteger(trial.totalWallMilliseconds) && trial.totalWallMilliseconds >= 0) {
      values[condition].push(trial.totalWallMilliseconds);
    }
  }
  return Object.freeze({ disabled: Object.freeze(values.disabled.sort((a, b) => a - b)),
    passive: Object.freeze(values.passive.sort((a, b) => a - b)),
    advice: Object.freeze(values.advice.sort((a, b) => a - b)) });
}

function verifyProtocol(protocol: RealPairedProtocol): RealPairedProtocol {
  const { schemaVersion, pairs, order, protocolDigest, ...input } = protocol;
  const fixed = createRealPairedProtocol(input);
  if (schemaVersion !== 2 || pairs !== 5 || protocolDigest !== fixed.protocolDigest
    || JSON.stringify(order) !== JSON.stringify(fixed.order)
    || fixed.fixtureDigest !== packageManagerFixtureDigest) throw new TypeError('Real trial protocol changed.');
  return fixed;
}

function bind<T extends RealTrialResult>(result: T): T { directResults.add(result); return result; }

function storeDigest(dataDir: string): string {
  return digest(Buffer.concat([readFileSync(join(dataDir, 'experience.sqlite')),
    readFileSync(join(dataDir, 'advice.sqlite'))]));
}
