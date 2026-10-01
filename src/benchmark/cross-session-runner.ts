import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TextDecoder } from 'node:util';

import { attachCodexAdviceExposure, isHostAdviceExposureWitnessForChild,
  type HostAdviceExposureScope } from '../advice/codex-exposure.js';
import { bindObservedDeterministicOutcome } from '../advice/observed-outcome.js';
import { AdvisoryConfigurationStore } from '../advice/configuration.js';
import { AdvisoryUsageStore } from '../advice/usage.js';
import { codexCliJsonSourceEventId, isTrustedCodexCliJsonStream,
  observeVerifiedCodexCliJsonChild, type TrustedCodexCliJsonStream } from '../capture/adapters/codex-cli-json.js';
import { attachVerifiedCodexPassiveCapture } from '../capture/direct-cli-ingress.js';
import { runCli } from '../cli.js';
import { spawnVerifiedCodexExec } from '../host/codex-cli-launcher.js';
import { runningBuild, runningPackageRoot } from '../installation/build-manifest.js';
import { resolveRepository } from '../repository/local-repository.js';
import { assessPairedPilot, type PilotTrial } from './pilot.js';
import { buildIdentity, digest } from './manifest.js';
import { createCrossSessionRealProtocol, type CrossSessionRealProtocol } from './paired.js';
import { prepareRealAdviceScope, prepareRealAdviceSeed, realAdviceInvocation,
  realSelectionInvocation, type RealAdviceSeed } from './real-advice.js';
import { codexTrialArguments, isQualifiedPassiveTrialCapture, isPassiveAdviceAbsent,
  totalWallDistribution, verifyPublicPassiveCapture } from './real-runner.js';
import { CrossSessionCommandObserver, matchCrossSessionCommandFacts } from './cross-session-observer.js';
import { inspectCrossSessionAdviceUsage, inspectCrossSessionDataDir,
  protectedCandidateDigest } from './cross-session-safety.js';
import { checkCrossSessionTask, classifyCrossSessionDiscovery, crossSessionFixtureDigest,
  crossSessionFixtureDigestV2, crossSessionTask, prepareCrossSessionScenario,
  prepareCrossSessionScenarioV2, resetCrossSessionAfterSecond,
  resetCrossSessionWorkspace, type CrossSessionCommandFact, type CrossSessionFixture } from './cross-session-scenario.js';

export interface CrossSessionRealSeriesContext {
  readonly root: string;
  readonly seedDir: string;
  readonly seedStoreDigest: string;
  readonly protectedCandidateDigest: string;
  readonly fixture: CrossSessionFixture;
  readonly adviceSeed: RealAdviceSeed;
}

export interface CrossSessionRealTrialResult {
  readonly slotIndex: number;
  readonly protocolDigest: string;
  readonly buildId: string;
  readonly status: 'complete' | 'task-failed' | 'unsupported';
  readonly pilot: PilotTrial | null;
  readonly totalWallMilliseconds: number | null;
  readonly operationSource: 'cli-json-item' | 'unsupported';
  readonly operations: readonly { readonly session: 'B1' | 'B2'; readonly sessionId: string;
    readonly id: string; readonly kind: CrossSessionCommandFact['commandClass'];
    readonly outcome: CrossSessionCommandFact['outcome'] }[];
  readonly sessions: { readonly B1: CrossSessionSessionSummary;
    readonly B2: CrossSessionSessionSummary | null } | null;
  readonly unsupportedCode: 'source-not-qualified' | null;
  readonly adviceUseQualified: boolean;
}

export interface CrossSessionSessionSummary {
  readonly sessionId: string;
  readonly taskCorrect: boolean;
  readonly separateCheck: boolean;
  readonly exactReadCount: number;
  readonly safetyViolations: readonly string[];
}

interface ChildResult {
  readonly sessionId: string;
  readonly facts: readonly CrossSessionCommandFact[];
  readonly stream: TrustedCodexCliJsonStream;
  readonly wallMilliseconds: number;
  readonly tokens: number | null;
  readonly admitted: number;
  readonly scope: HostAdviceExposureScope | null;
  readonly safetyViolations: readonly string[];
}

const contexts = new WeakSet<CrossSessionRealSeriesContext>();
const running = new WeakSet<CrossSessionRealSeriesContext>();
const poisoned = new WeakSet<CrossSessionRealSeriesContext>();
const directResults = new WeakSet<CrossSessionRealTrialResult>();

/** Two real A source sessions establish one reviewed seed for all paired slots. */
export async function prepareCrossSessionRealSeries(binaryPath: string,
  revision: 1 | 2 = 1): Promise<CrossSessionRealSeriesContext> {
  if (revision !== 1 && revision !== 2) throw new TypeError('Cross-session fixture revision is invalid.');
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-series-'));
  const seedDir = mkdtempSync(join(tmpdir(), 'avb-cross-seed-'));
  try {
    const fixture = revision === 2 ? prepareCrossSessionScenarioV2(root)
      : prepareCrossSessionScenario(root);
    const version = execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8', timeout: 10_000,
      maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (version !== '12.6.0') throw new TypeError('Frozen package manager runtime is unavailable.');
    const adviceSeed = await prepareRealAdviceSeed(root, seedDir, binaryPath);
    if (adviceSeed.repositoryId !== fixture.repositoryId
      || checkCrossSessionTask(root, fixture, 1).safetyViolations.length !== 0) {
      throw new TypeError('A source changed the cross-session fixture.');
    }
    const context = Object.freeze({ root, seedDir, fixture, adviceSeed, seedStoreDigest: storeDigest(seedDir),
      protectedCandidateDigest: protectedCandidateDigest(join(seedDir, 'experience.sqlite')) });
    contexts.add(context);
    return context;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
    throw error;
  }
}

export function closeCrossSessionRealSeries(context: CrossSessionRealSeriesContext): void {
  if (!contexts.has(context) || running.has(context)) throw new TypeError('Cross-session series context is unavailable.');
  contexts.delete(context);
  rmSync(context.root, { recursive: true, force: true });
  rmSync(context.seedDir, { recursive: true, force: true });
}

export function crossSessionTrialPrompt(task: 1 | 2,
  condition: CrossSessionRealProtocol['order'][number]['condition'],
  retrievalInvocation: string, selectionInvocation: string): string {
  if (task !== 1 && task !== 2) throw new TypeError('Cross-session task is invalid.');
  return condition === 'advice' && task === 2
    ? `First run this exact retrieval command: ${retrievalInvocation}\nWhen its JSON status is ready, run a separate echo command containing the literal deliveryChallenge value. Then run this exact selection command: ${selectionInvocation}\nAfter selection, complete this task: ${crossSessionTask(task)}`
    : crossSessionTask(task);
}

export async function runCrossSessionRealTrial(protocol: CrossSessionRealProtocol, slotIndex: number,
  buildRoot: string, binaryPath: string, context: CrossSessionRealSeriesContext): Promise<CrossSessionRealTrialResult> {
  const fixed = verifyProtocol(protocol);
  if (!contexts.has(context) || running.has(context) || poisoned.has(context)
    || context.seedStoreDigest !== fixed.seedStoreDigest || storeDigest(context.seedDir) !== fixed.seedStoreDigest
    || context.fixture.repositoryId !== resolveRepository(context.root)?.id
    || context.fixture.revision !== fixed.scenarios[0]?.revision) {
    throw new TypeError('Cross-session series seed is unavailable or changed.');
  }
  const slot = fixed.order[slotIndex];
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || !slot) throw new TypeError('Cross-session slot is invalid.');
  const buildId = slot.condition === 'disabled' ? fixed.baselineBuildId : fixed.candidateBuildId;
  if (buildIdentity(buildRoot) !== buildId) throw new TypeError('Cross-session build differs from protocol.');
  if (slot.condition !== 'disabled' && (!runningBuild()
    || buildIdentity(runningPackageRoot) !== buildId)) {
    throw new TypeError('Running AEL artifact differs from candidate build.');
  }
  running.add(context);
  const dataDir = mkdtempSync(join(tmpdir(), 'avb-cross-slot-'));
  let reusable = false;
  const unsupported = (): CrossSessionRealTrialResult => bind(Object.freeze({ slotIndex,
    protocolDigest: fixed.protocolDigest, buildId, status: 'unsupported', pilot: null,
    totalWallMilliseconds: null, operationSource: 'unsupported', operations: Object.freeze([]),
    sessions: null, adviceUseQualified: false,
    unsupportedCode: 'source-not-qualified' }));
  try {
    if (slot.condition !== 'disabled') {
      copyFileSync(join(context.seedDir, 'experience.sqlite'), join(dataDir, 'experience.sqlite'));
      copyFileSync(join(context.seedDir, 'advice.sqlite'), join(dataDir, 'advice.sqlite'));
      if (slot.condition === 'passive') {
        const configured = runCli(['advice', 'configure', '--repository-id', context.fixture.repositoryId,
          '--enabled', 'false', '--data-dir', dataDir, '--json'], { workingDirectory: context.root });
        if (configured.exitCode !== 0 || new AdvisoryConfigurationStore(join(dataDir, 'advice.sqlite'))
          .status(context.fixture.repositoryId).enabled) return unsupported();
      } else if (!new AdvisoryConfigurationStore(join(dataDir, 'advice.sqlite'))
        .status(context.fixture.repositoryId).enabled) return unsupported();
    }
    const started = process.hrtime.bigint();
    const firstLimit = remainingCrossSessionWallBudget(fixed.budgets.wallMilliseconds, 0);
    const first = await runChild(fixed, slotIndex, context, dataDir, buildRoot, binaryPath, 1,
      slot.condition, 0, firstLimit);
    if (!first) return unsupported();
    const check1 = first.facts.find(fact => fact.commandClass === 'package-manager-check'
      && fact.outcome === 'succeeded');
    const result1 = checkCrossSessionTask(context.root, context.fixture, 1, check1);
    const summary1 = summarizeSession(first, result1, first.safetyViolations);
    const firstOperations = sanitize(first.facts, 'B1');
    if (!withinCrossSessionBudget(fixed.budgets, first.wallMilliseconds, first.tokens)) return unsupported();
    const firstSafety = Object.freeze([...result1.safetyViolations, ...first.safetyViolations]);
    if (!result1.taskCorrect || firstSafety.length > 0) {
      return failed(slotIndex, fixed, buildId, firstOperations, first.wallMilliseconds,
        first.tokens, firstSafety, summary1);
    }
    resetCrossSessionWorkspace(context.root, context.fixture, check1);
    const secondLimit = remainingCrossSessionWallBudget(fixed.budgets.wallMilliseconds,
      Number((process.hrtime.bigint() - started) / 1_000_000n));
    if (secondLimit === 0) return unsupported();
    const second = await runChild(fixed, slotIndex, context, dataDir, buildRoot, binaryPath, 2,
      slot.condition, first.admitted, secondLimit);
    if (!second || second.sessionId === first.sessionId) return unsupported();
    const check2 = second.facts.find(fact => fact.commandClass === 'package-manager-check'
      && fact.outcome === 'succeeded');
    const result2 = checkCrossSessionTask(context.root, context.fixture, 2, check2);
    const summary2 = summarizeSession(second, result2, second.safetyViolations);
    const operations = Object.freeze([...firstOperations, ...sanitize(second.facts, 'B2')]);
    if (slot.condition === 'advice' && second.safetyViolations.length === 0 && (!second.scope || !check2
      || !recordAdviceUse(context.root, dataDir, fixed, context.fixture, second, check2, result2))) {
      return unsupported();
    }
    const redundant = classifyCrossSessionDiscovery(first.facts, second.facts).candidateRedundantOperationIds;
    const totalWallMilliseconds = first.wallMilliseconds + second.wallMilliseconds;
    if (!withinCrossSessionBudget(fixed.budgets, totalWallMilliseconds,
      first.tokens === null || second.tokens === null ? null : first.tokens + second.tokens)
      || Number((process.hrtime.bigint() - started) / 1_000_000n) > fixed.budgets.wallMilliseconds) {
      return unsupported();
    }
    const tokens = first.tokens === null || second.tokens === null ? null : first.tokens + second.tokens;
    const afterUseSafety = slot.condition === 'advice' && second.safetyViolations.length === 0
      ? [...inspectCrossSessionDataDir(dataDir, slot.condition, 2, true,
        context.protectedCandidateDigest),
        ...inspectCrossSessionAdviceUsage(dataDir, 'advice', 2, context.fixture.repositoryId,
          second.sessionId, second.scope?.bundleId ?? null, true, result2.taskCorrect)] : [];
    const safetyViolations = Object.freeze([...result1.safetyViolations, ...result2.safetyViolations,
      ...second.safetyViolations, ...afterUseSafety]);
    const pilot: PilotTrial = Object.freeze({ scenarioId: slot.scenarioId, condition: slot.condition,
      pair: slot.pair, taskCorrect: result1.taskCorrect && result2.taskCorrect,
      redundantOperationIds: redundant, safetyViolations,
      wallMilliseconds: slot.condition === 'disabled' ? totalWallMilliseconds : null,
      aelOverheadMilliseconds: null, tokens });
    if (result2.taskCorrect) resetCrossSessionAfterSecond(context.root, context.fixture, check2!);
    reusable = result2.taskCorrect && safetyViolations.length === 0;
    return bind(Object.freeze({ slotIndex, protocolDigest: fixed.protocolDigest, buildId,
      status: result2.taskCorrect && safetyViolations.length === 0 ? 'complete' : 'task-failed',
      pilot, totalWallMilliseconds, operationSource: 'cli-json-item', operations,
      sessions: Object.freeze({ B1: summary1, B2: summary2 }), unsupportedCode: null,
      adviceUseQualified: slot.condition === 'advice' && result2.taskCorrect
        && safetyViolations.length === 0 }));
  } finally {
    if (!reusable) poisoned.add(context);
    running.delete(context);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

export function withinCrossSessionBudget(budgets: CrossSessionRealProtocol['budgets'],
  wallMilliseconds: number, tokens: number | null): boolean {
  return Number.isSafeInteger(wallMilliseconds) && wallMilliseconds >= 0
    && wallMilliseconds <= budgets.wallMilliseconds
    && (budgets.tokens === null || tokens !== null && Number.isSafeInteger(tokens)
      && tokens >= 0 && tokens <= budgets.tokens);
}

export function remainingCrossSessionWallBudget(limitMilliseconds: number,
  elapsedMilliseconds: number): number {
  if (!Number.isSafeInteger(limitMilliseconds) || limitMilliseconds <= 0
    || !Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0) return 0;
  return Math.max(0, limitMilliseconds - elapsedMilliseconds);
}

function failed(slotIndex: number, protocol: CrossSessionRealProtocol, buildId: string,
  operations: CrossSessionRealTrialResult['operations'], wall: number, tokens: number | null,
  safetyViolations: readonly string[], summary1: CrossSessionSessionSummary): CrossSessionRealTrialResult {
  const slot = protocol.order[slotIndex]!;
  const pilot: PilotTrial = Object.freeze({ scenarioId: slot.scenarioId, condition: slot.condition,
    pair: slot.pair, taskCorrect: false, redundantOperationIds: Object.freeze([]),
    safetyViolations, wallMilliseconds: slot.condition === 'disabled' ? wall : null,
    aelOverheadMilliseconds: null, tokens });
  return bind(Object.freeze({ slotIndex, protocolDigest: protocol.protocolDigest, buildId,
    status: 'task-failed', pilot, totalWallMilliseconds: wall, operationSource: 'cli-json-item',
    operations, sessions: Object.freeze({ B1: summary1, B2: null }), unsupportedCode: null,
    adviceUseQualified: false }));
}

export function summarizeSession(child: Pick<ChildResult, 'sessionId' | 'facts'>,
  checked: ReturnType<typeof checkCrossSessionTask>, extraSafety: readonly string[] = []): CrossSessionSessionSummary {
  return Object.freeze({ sessionId: child.sessionId, taskCorrect: checked.taskCorrect,
    separateCheck: checked.checkObserved,
    exactReadCount: child.facts.filter(fact => fact.commandClass === 'exact-manifest-read'
      && fact.outcome === 'succeeded').length,
    safetyViolations: Object.freeze([...checked.safetyViolations, ...extraSafety]) });
}

function sanitize(facts: readonly CrossSessionCommandFact[], session: 'B1' | 'B2') {
  return Object.freeze(facts.map(fact => Object.freeze({ session, sessionId: fact.sessionId,
    id: fact.operationId, kind: fact.commandClass, outcome: fact.outcome })));
}

async function runChild(protocol: CrossSessionRealProtocol, slotIndex: number,
  context: CrossSessionRealSeriesContext, dataDir: string, buildRoot: string, binaryPath: string,
  task: 1 | 2, condition: CrossSessionRealProtocol['order'][number]['condition'],
  admittedBefore: number, wallLimitMilliseconds: number): Promise<ChildResult | null> {
  if (wallLimitMilliseconds <= 0) return null;
  const withAdvice = condition === 'advice' && task === 2;
  const retrievalInvocation = withAdvice ? realAdviceInvocation(buildRoot, dataDir) : '';
  const selectionInvocation = withAdvice ? realSelectionInvocation(buildRoot, dataDir) : '';
  const prompt = crossSessionTrialPrompt(task, condition, retrievalInvocation, selectionInvocation);
  const started = process.hrtime.bigint();
  const child = await spawnVerifiedCodexExec({ binaryPath, cwd: context.root,
    args: codexTrialArguments(protocol.agent, context.root, prompt) });
  const passive = condition === 'disabled' ? null
    : attachVerifiedCodexPassiveCapture(child, { databasePath: join(dataDir, 'experience.sqlite'),
      repositoryId: context.fixture.repositoryId as never, workingDirectory: context.root })
      .then(value => value, () => null);
  const trusted = condition === 'disabled'
    ? observeVerifiedCodexCliJsonChild(child).then(value => value, () => null)
    : passive!.then(value => value?.stream ?? null);
  let scope: HostAdviceExposureScope | null = null;
  const exposure = withAdvice ? attachCodexAdviceExposure(child, threadId => {
    scope = prepareRealAdviceScope(context.root, dataDir, buildRoot, context.adviceSeed,
      threadId, `avb-real-retrieval-${slotIndex}`);
    return scope;
  }) : Promise.resolve(null);
  const observer = new CrossSessionCommandObserver(context.root, context.fixture,
    withAdvice ? selectionInvocation : undefined);
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
      try { observer.accept(JSON.parse(pending.slice(0, newline)) as unknown, new Date().toISOString()); }
      catch { invalid = true; child.kill(); return; }
      pending = pending.slice(newline + 1);
    }
  });
  child.stderr?.resume();
  const beforeWait = Number((process.hrtime.bigint() - started + 999_999n) / 1_000_000n);
  const timer = setTimeout(() => child.kill(), Math.max(1, wallLimitMilliseconds - beforeWait));
  if (beforeWait >= wallLimitMilliseconds) child.kill();
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', () => resolve({ code: null, signal: null }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const wallMilliseconds = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const stream = await trusted;
  const passiveResult = await passive;
  const observedExposure = await exposure;
  const observedScope = scope as HostAdviceExposureScope | null;
  if (pending && !invalid) {
    try { observer.accept(JSON.parse(pending + decoder.decode()) as unknown, new Date().toISOString()); }
    catch { invalid = true; }
  }
  const candidate = invalid ? null : observer.finish();
  const facts = candidate && stream ? matchCrossSessionCommandFacts(candidate, stream) : [];
  if (closed.code !== 0 || closed.signal !== null || !stream || !isTrustedCodexCliJsonStream(stream)
    || candidate?.status !== 'observed' || facts.length === 0
    || facts.length !== candidate.facts.length || stream.events.length !== facts.length * 2
    || wallMilliseconds > wallLimitMilliseconds) return null;
  if (condition !== 'disabled' && (!passiveResult
    || !isQualifiedPassiveTrialCapture(passiveResult, child, stream)
    || !await verifyPublicPassiveCapture(dataDir, context.fixture.repositoryId, stream,
      passiveResult.admitted, admittedBefore + passiveResult.admitted)
    || (condition === 'passive' && !isPassiveAdviceAbsent(dataDir, context.fixture.repositoryId, stream.sessionId)))) {
    return null;
  }
  if (condition === 'advice' && task === 1 && usageBundleCount(dataDir, stream.sessionId) !== 0) return null;
  if (withAdvice) {
    if (!observedScope || !observedExposure || !isHostAdviceExposureWitnessForChild(observedExposure, child)
      || observedScope.sessionId !== stream.sessionId) return null;
    const retrievalId = codexCliJsonSourceEventId(stream.sessionId, observedExposure.retrievalItemId, 'start');
    const echoId = codexCliJsonSourceEventId(stream.sessionId, observedExposure.echoItemId, 'start');
    if (!qualifiesAdviceOperationOrder(facts, retrievalId, echoId)) return null;
    const usage = new AdvisoryUsageStore(join(dataDir, 'advice.sqlite'));
    if (!usage.facts(observedScope.bundleId).some(fact => fact.kind === 'selected' && fact.origin === 'agent-selection')) return null;
  }
  const check = facts.find(fact => fact.commandClass === 'package-manager-check'
    && fact.outcome === 'succeeded');
  if (withAdvice && !check) return null;
  const safetyViolations = [...inspectCrossSessionDataDir(dataDir, condition, task, false,
    context.protectedCandidateDigest),
    ...(condition === 'disabled' ? [] : inspectCrossSessionAdviceUsage(dataDir, condition,
      task, context.fixture.repositoryId, stream.sessionId, observedScope?.bundleId ?? null, false))];
  return Object.freeze({ sessionId: stream.sessionId, facts, stream, wallMilliseconds,
    tokens: candidate.tokens, admitted: passiveResult?.admitted ?? 0, scope: observedScope,
    safetyViolations });
}

/** Ordering check only; caller also verifies the direct host and persisted AAP witnesses. */
export function qualifiesAdviceOperationOrder(facts: readonly CrossSessionCommandFact[],
  retrievalId: string, echoId: string): boolean {
  if (retrievalId === echoId || facts.length < 4
    || facts[0]?.operationId !== retrievalId || facts[0].outcome !== 'succeeded'
    || facts[0].commandClass !== 'other'
    || facts[1]?.operationId !== echoId || facts[1].outcome !== 'succeeded'
    || facts[1].commandClass !== 'other'
    || facts[2]?.commandClass !== 'advice-selection' || facts[2].outcome !== 'succeeded') return false;
  const checkIndex = facts.findIndex(fact => fact.commandClass === 'package-manager-check'
    && fact.outcome === 'succeeded');
  return checkIndex > 2
    && facts.filter(fact => fact.commandClass === 'advice-selection').length === 1
    && !facts.some((fact, index) => fact.commandClass === 'exact-manifest-read' && index <= 2);
}

function recordAdviceUse(root: string, dataDir: string, protocol: CrossSessionRealProtocol,
  fixture: CrossSessionFixture, second: ChildResult, check: CrossSessionCommandFact,
  result: ReturnType<typeof checkCrossSessionTask>): boolean {
  const scope = second.scope;
  if (!scope) return false;
  const usage = new AdvisoryUsageStore(join(dataDir, 'advice.sqlite'));
  const appliedPath = join(dataDir, 'applied.json');
  writeFileSync(appliedPath, JSON.stringify({ repositoryId: scope.repositoryId,
    lessonId: scope.lessonId, lessonRevision: scope.lessonRevision, sessionId: scope.sessionId,
    contextRevision: scope.contextRevision, bundleId: scope.bundleId, kind: 'applied',
    origin: 'operation-evidence', witnessRef: check.operationId }), { flag: 'wx' });
  const applied = runCli(['advice', 'record', '--input', appliedPath, '--data-dir', dataDir, '--json'],
    { workingDirectory: root });
  if (applied.exitCode !== 0 || !usage.facts(scope.bundleId).some(fact => fact.kind === 'applied'
    && fact.origin === 'operation-evidence' && fact.witnessRef === check.operationId)) return false;
  if (!result.taskCorrect || result.safetyViolations.length !== 0) return true;
  const bundle = usage.bundle(scope.bundleId);
  if (!bundle || !isTrustedCodexCliJsonStream(second.stream)
    || second.stream.sessionId !== bundle.sessionId) return false;
  const witness = bindObservedDeterministicOutcome({ bundle, appliedEventId: check.operationId,
    fixtureDigest: protocol.fixtureDigest, protocolDigest: protocol.protocolDigest,
    sourceDigest: fixture.gitDigest, stream: second.stream });
  if (!witness) return false;
  usage.recordObservedDeterministicOutcome(witness, second.stream);
  return usage.facts(scope.bundleId).some(fact => fact.kind === 'outcome-observed'
    && fact.origin === 'deterministic-check');
}

function usageBundleCount(dataDir: string, sessionId: string): number {
  const database = new DatabaseSync(join(dataDir, 'advice.sqlite'), { readOnly: true, timeout: 125 });
  try {
    const usageTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'advice_usage_bundles'").get();
    if (!usageTable) return 0;
    return (database.prepare('SELECT COUNT(*) AS count FROM advice_usage_bundles WHERE session_id = ?')
      .get(sessionId) as { count: number }).count;
  } finally { database.close(); }
}

export function assessCrossSessionRealSeries(protocol: CrossSessionRealProtocol,
  trials: readonly CrossSessionRealTrialResult[]) {
  const fixed = verifyProtocol(protocol);
  if (!Array.isArray(trials) || trials.length > fixed.order.length) throw new TypeError('Cross-session series exceeds slots.');
  const seen = new Set<number>();
  const qualified: PilotTrial[] = [];
  for (const trial of trials) {
    const slot = fixed.order[trial.slotIndex];
    if (!directResults.has(trial) || !slot || seen.has(trial.slotIndex)
      || trial.protocolDigest !== fixed.protocolDigest
      || trial.buildId !== (slot.condition === 'disabled' ? fixed.baselineBuildId : fixed.candidateBuildId)) {
      throw new TypeError('Cross-session trial is not bound to this protocol and direct runner.');
    }
    seen.add(trial.slotIndex);
    if (trial.status !== 'unsupported' && trial.pilot) qualified.push(trial.pilot);
  }
  const assessed = assessPairedPilot(qualified);
  const complete = qualified.length === fixed.order.length;
  return Object.freeze({ ...assessed,
    status: complete || assessed.status === 'safety-fail' || assessed.status === 'correctness-fail'
      ? assessed.status : 'incomplete',
    conclusion: complete ? assessed.conclusion : 'performance-not-established',
    observedTrials: qualified.length, requiredTrials: fixed.order.length,
    totalWallMilliseconds: totalWallDistribution(trials, fixed.order) });
}

function verifyProtocol(protocol: CrossSessionRealProtocol): CrossSessionRealProtocol {
  const { schemaVersion, pairs, order, protocolDigest, ...input } = protocol;
  const fixed = createCrossSessionRealProtocol(input);
  if (schemaVersion !== 3 || pairs !== 5 || protocolDigest !== fixed.protocolDigest
    || JSON.stringify(order) !== JSON.stringify(fixed.order)
    || fixed.fixtureDigest !== (fixed.scenarios[0]?.revision === 2
      ? crossSessionFixtureDigestV2 : crossSessionFixtureDigest)) {
    throw new TypeError('Cross-session protocol changed.');
  }
  return fixed;
}

function storeDigest(dataDir: string): string {
  return digest(Buffer.concat([readFileSync(join(dataDir, 'experience.sqlite')),
    readFileSync(join(dataDir, 'advice.sqlite'))]));
}

function bind<T extends CrossSessionRealTrialResult>(result: T): T { directResults.add(result); return result; }
