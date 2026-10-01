import { execFileSync } from 'node:child_process';
import { closeSync, constants, createReadStream, fstatSync, fsyncSync, linkSync, openSync, readSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';

import { qualifiedCodexCli } from '../host/codex-cli-launcher.js';
import { runningBuild, runningPackageRoot } from '../installation/build-manifest.js';
import { containsCredentialMaterial } from '../privacy/structured-arguments.js';
import { buildIdentity, digest } from './manifest.js';
import { createCrossSessionRealProtocol, createRealPairedProtocol, type PairedSlot } from './paired.js';
import { type CrossSessionRealProtocol } from './paired.js';
import { closeCrossSessionRealSeries,
  prepareCrossSessionRealSeries, runCrossSessionRealTrial,
  type CrossSessionRealTrialResult } from './cross-session-runner.js';
import { crossSessionFixtureDigest, crossSessionFixtureDigestV2 } from './cross-session-scenario.js';
import { packageManagerFixtureDigest } from './real-scenario.js';

const maximumPlanBytes = 1024 * 1024;
const publicCommandKinds = new Set(['exact-manifest-read', 'required-validation',
  'package-manager-check', 'advice-selection', 'other']);
type FrozenLegacyPlan = Omit<ReturnType<typeof createRealPairedProtocol>,
  'schemaVersion' | 'seedStoreDigest' | 'protocolDigest'> & {
  readonly schemaVersion: 1;
  readonly planDigest: string;
};
type FrozenCrossSessionPlan = Omit<ReturnType<typeof createCrossSessionRealProtocol>,
  'schemaVersion' | 'seedStoreDigest' | 'protocolDigest'> & {
  readonly schemaVersion: 2;
  readonly planDigest: string;
};
type FrozenRealRunPlan = FrozenLegacyPlan | FrozenCrossSessionPlan;

export interface RealBenchmarkCommandInput {
  readonly planPath: string;
  readonly codexBinary: string;
  readonly baselineRoot: string;
  readonly candidateRoot: string;
  readonly output: string;
}

interface ExploratorySessionCheck {
  readonly taskCorrect: boolean;
  readonly separateCheck: boolean;
  readonly exactReadCount: number;
  readonly safetyViolations: readonly string[];
}
interface ExploratoryTrialCheck {
  readonly status: 'complete' | 'unsupported' | 'task-failed';
  readonly adviceUseQualified?: boolean;
  readonly pilot: { readonly taskCorrect: boolean; readonly redundantOperationIds: readonly string[];
    readonly safetyViolations: readonly string[] } | null;
  readonly sessions: { readonly B1: ExploratorySessionCheck;
    readonly B2: ExploratorySessionCheck | null } | null;
}

/** Local pre-freeze gate; provenance must already be established by the direct child runner. */
export function qualifiesCrossSessionProbe(result: ExploratoryTrialCheck,
  condition: 'disabled' | 'advice'): boolean {
  const sessions = result.sessions;
  return result.status === 'complete' && result.pilot?.taskCorrect === true
    && result.pilot.safetyViolations.length === 0 && sessions !== null
    && sessions.B1.taskCorrect && sessions.B1.separateCheck && sessions.B1.safetyViolations.length === 0
    && sessions.B2 !== null && sessions.B2.taskCorrect && sessions.B2.separateCheck
    && sessions.B2.safetyViolations.length === 0
    && (condition === 'advice' ? result.adviceUseQualified === true
      : sessions.B1.exactReadCount >= 1 && sessions.B2.exactReadCount >= 1
        && result.pilot.redundantOperationIds.length >= 1);
}

/** Exploratory results are excluded from the five-pair series even when all gates pass. */
export async function runCrossSessionExploration(protocol: CrossSessionRealProtocol,
  runTrial: (slotIndex: number) => Promise<CrossSessionRealTrialResult>,
  onTrial?: (trial: CrossSessionRealTrialResult) => void) {
  const expected: readonly { pair: number; condition: 'disabled' | 'advice' }[] = [
    { pair: 0, condition: 'disabled' }, { pair: 1, condition: 'disabled' },
    { pair: 0, condition: 'advice' }
  ];
  const trials: CrossSessionRealTrialResult[] = [];
  for (const item of expected) {
    const slotIndex = protocol.order.findIndex(slot => slot.pair === item.pair
      && slot.condition === item.condition);
    if (slotIndex < 0) throw new TypeError('Frozen exploratory slot is unavailable.');
    const result = await runTrial(slotIndex);
    trials.push(result);
    onTrial?.(result);
    if (!qualifiesCrossSessionProbe(result, item.condition)) {
      return Object.freeze({ status: 'rejected' as const,
        qualified: false as const, trials: Object.freeze(trials) });
    }
  }
  return Object.freeze({ status: 'qualified-awaiting-freeze' as const,
    qualified: true as const, trials: Object.freeze(trials) });
}

interface PublicTrialInput extends ExploratoryTrialCheck {
  readonly slotIndex: number;
  readonly buildId: string;
  readonly operationSource: 'cli-json-item' | 'unsupported';
  readonly unsupportedCode: 'source-not-qualified' | null;
  readonly totalWallMilliseconds: number | null;
  readonly pilot: (NonNullable<ExploratoryTrialCheck['pilot']> & {
    readonly wallMilliseconds: number | null;
    readonly aelOverheadMilliseconds: number | null;
    readonly tokens: number | null;
  }) | null;
  readonly operations: readonly { readonly session: 'B1' | 'B2'; readonly id: string;
    readonly kind: string; readonly outcome: 'succeeded' | 'failed' | 'unknown' }[];
}

/** Whitelist the direct runner's evidence fields before any persistent report write. */
export function publicCrossSessionTrial(slot: PairedSlot, result: PublicTrialInput) {
  const safeId = (value: string) => /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
  const safeViolations = (values: readonly string[]) => values.length <= 1000
    && values.every(value => /^[a-z-]{1,80}$/.test(value));
  if (result.operations.length > 1000 || result.operations.some(operation =>
    !safeId(operation.id) || !publicCommandKinds.has(operation.kind)
      || !['B1', 'B2'].includes(operation.session)
      || !['succeeded', 'failed', 'unknown'].includes(operation.outcome))
    || (result.pilot?.redundantOperationIds.length ?? 0) > 1000
    || result.pilot?.redundantOperationIds.some(id => !safeId(id))
    || !safeViolations(result.pilot?.safetyViolations ?? [])
    || (result.sessions !== null && (!safeViolations(result.sessions.B1.safetyViolations)
      || result.sessions.B2 !== null && !safeViolations(result.sessions.B2.safetyViolations)))) {
    throw new TypeError('Cross-session public operation evidence is invalid.');
  }
  const session = (value: ExploratorySessionCheck | null) => value === null ? null : Object.freeze({
    taskCorrect: value.taskCorrect, separateCheck: value.separateCheck,
    exactReadCount: value.exactReadCount, safetyViolations: [...value.safetyViolations]
  });
  return Object.freeze({ slotIndex: result.slotIndex, slot, buildId: result.buildId,
    status: result.status, reason: result.unsupportedCode,
    operationSource: result.operationSource,
    operations: Object.freeze(result.operations.map(operation => Object.freeze({
      session: operation.session, id: operation.id, kind: operation.kind, outcome: operation.outcome
    }))),
    redundantOperationIds: Object.freeze([...(result.pilot?.redundantOperationIds ?? [])]),
    adviceUseQualified: result.adviceUseQualified === true,
    taskCorrect: result.pilot?.taskCorrect ?? null,
    safetyViolations: Object.freeze([...(result.pilot?.safetyViolations ?? [])]),
    sessions: result.sessions === null ? null : Object.freeze({
      B1: session(result.sessions.B1), B2: session(result.sessions.B2)
    }),
    totalWallMilliseconds: result.totalWallMilliseconds,
    wallMilliseconds: result.pilot?.wallMilliseconds ?? null,
    aelOverheadMilliseconds: result.pilot?.aelOverheadMilliseconds ?? null,
    tokens: result.pilot?.tokens ?? null });
}

/** Create once, then replace each checkpoint atomically; never persist raw runner objects. */
export function writeRealBenchmarkCheckpoint(output: string, body: Record<string, unknown>, create: boolean) {
  if (!isAbsolute(output)) throw new TypeError('Real benchmark output must be absolute.');
  const report = { ...body, reportDigest: digest(JSON.stringify(body)) };
  assertSafeReport(report);
  if (create) writeNewReport(output, report);
  else {
    if (!statSync(output).isFile()) throw new TypeError('Real benchmark checkpoint is unavailable.');
    const temporary = join(dirname(output), `.${randomUUID()}.avb-report.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const descriptor = openSync(temporary, 'r');
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, output);
      syncReportDirectory(output);
    } finally {
      try { unlinkSync(temporary); } catch { /* Renamed or never created. */ }
    }
  }
  return report;
}

/** Historical v2 preflight remains incomplete. V3 performs gated direct-host trials. */
export async function runRealBenchmarkCommand(input: RealBenchmarkCommandInput) {
  if (![input.codexBinary, input.baselineRoot, input.candidateRoot, input.output].every(isAbsolute)) {
    throw new TypeError('Real benchmark paths must be absolute.');
  }
  const frozenPlan = readFrozenPlan(input.planPath);
  if (buildIdentity(input.baselineRoot) !== frozenPlan.baselineBuildId
    || buildIdentity(input.candidateRoot) !== frozenPlan.candidateBuildId) {
    throw new TypeError('Real benchmark build differs from frozen plan.');
  }
  await verifyBinaryIdentity(input.codexBinary);
  // Neither revision has a baseline-qualified B1 command criterion. Keep both
  // closed before source seeding or exploratory provider calls.
  if (frozenPlan.schemaVersion === 2
    && (frozenPlan.corpusVersion === 'b2-2' || frozenPlan.corpusVersion === 'b2-3')) {
    return reportRejectedCrossSessionScenario(input.output, frozenPlan);
  }
  if (frozenPlan.schemaVersion === 2) return runCrossSessionBenchmark(input, frozenPlan);
  const slots = frozenPlan.order.map((slot, slotIndex) => ({ slotIndex, slot,
    buildId: slot.condition === 'disabled' ? frozenPlan.baselineBuildId : frozenPlan.candidateBuildId,
    status: 'unsupported' as const, reason: 'source-not-qualified' as const,
    operationSource: 'unsupported' as const, operationIds: [] as string[],
    redundantOperationIds: [] as string[], taskCorrect: null, safetyViolations: [] as string[],
    wallMilliseconds: null, aelOverheadMilliseconds: null, tokens: null }));
  const body = { schemaVersion: 1 as const, kind: 'real-host-series' as const,
    status: 'incomplete' as const, conclusion: 'performance-not-established' as const,
    frozenPlan, protocol: null, protocolDigest: null,
    baselineBuildId: frozenPlan.baselineBuildId, candidateBuildId: frozenPlan.candidateBuildId,
    slots, assessment: { status: 'incomplete' as const, observedTrials: 0,
      requiredTrials: frozenPlan.order.length, scenarios: [] as unknown[] },
    provenance: { host: 'codex-cli', binaryVersion: qualifiedCodexCli.version,
      binarySha256: qualifiedCodexCli.sha256, buildVerification: 'matched' as const,
      binaryVerification: 'matched' as const, invocation: 'not-started' as const } };
  const report = { ...body, reportDigest: digest(JSON.stringify(body)) };
  assertSafeReport(report);
  writeNewReport(input.output, report);
  return { status: report.status, conclusion: report.conclusion,
    planDigest: frozenPlan.planDigest, reportDigest: report.reportDigest,
    observedTrials: 0, requiredTrials: slots.length, externalProviderInvoked: false };
}

function reportRejectedCrossSessionScenario(output: string, frozenPlan: FrozenCrossSessionPlan) {
  const slots = frozenPlan.order.map((slot, slotIndex) => ({ slotIndex, slot,
    buildId: slot.condition === 'disabled' ? frozenPlan.baselineBuildId : frozenPlan.candidateBuildId,
    status: 'unsupported' as const, reason: 'scenario-rejected' as const,
    operationSource: 'unsupported' as const, operations: [] as unknown[],
    redundantOperationIds: [] as string[], adviceUseQualified: false, taskCorrect: null,
    safetyViolations: [] as string[], sessions: null, totalWallMilliseconds: null,
    wallMilliseconds: null, aelOverheadMilliseconds: null, tokens: null }));
  const body = { schemaVersion: 2 as const, kind: 'cross-session-real-host-series' as const,
    status: 'incomplete' as const, conclusion: 'performance-not-established' as const,
    frozenPlan, protocol: null, protocolDigest: null,
    baselineBuildId: frozenPlan.baselineBuildId, candidateBuildId: frozenPlan.candidateBuildId,
    exploratory: { status: 'rejected' as const, reason: 'scenario-rejected' as const, trials: [] },
    slots, assessment: { status: 'incomplete' as const, observedTrials: 0,
      requiredTrials: slots.length, scenarios: [] as unknown[] },
    provenance: { host: 'codex-cli', binaryVersion: qualifiedCodexCli.version,
      binarySha256: qualifiedCodexCli.sha256, buildVerification: 'matched' as const,
      binaryVerification: 'matched' as const, invocation: 'not-started' as const,
      commandProvenanceLimit: 'command-text-and-output-only' as const } };
  const report = writeRealBenchmarkCheckpoint(output, body, true);
  return { status: body.status, conclusion: body.conclusion,
    planDigest: frozenPlan.planDigest, reportDigest: report.reportDigest,
    observedTrials: 0, requiredTrials: slots.length, externalProviderInvoked: false };
}

async function runCrossSessionBenchmark(input: RealBenchmarkCommandInput, frozenPlan: FrozenCrossSessionPlan) {
  // The direct runner imports this process's AEL artifact for passive/advice. Verify it
  // before the first paid child so a mismatched candidate cannot consume the source probe.
  if (!runningBuild() || buildIdentity(runningPackageRoot) !== frozenPlan.candidateBuildId) {
    throw new TypeError('Running AEL artifact differs from frozen candidate build.');
  }
  const emptySlot = (slot: PairedSlot, slotIndex: number) => ({ slotIndex, slot,
    buildId: slot.condition === 'disabled' ? frozenPlan.baselineBuildId : frozenPlan.candidateBuildId,
    status: 'unsupported' as const, reason: 'not-started' as const,
    operationSource: 'unsupported' as const, operations: [] as unknown[],
    redundantOperationIds: [] as string[], taskCorrect: null, safetyViolations: [] as string[],
    sessions: null, totalWallMilliseconds: null, wallMilliseconds: null,
    aelOverheadMilliseconds: null, tokens: null });
  const slots: readonly unknown[] = frozenPlan.order.map(emptySlot);
  let exploratory: Record<string, unknown> = { status: 'not-started', trials: [] };
  let protocol: CrossSessionRealProtocol | null = null;
  const assessment = { status: 'incomplete', observedTrials: 0,
    requiredTrials: frozenPlan.order.length, scenarios: [] };
  let phase = 'not-started';
  let created = false;
  const checkpoint = () => {
    const body = { schemaVersion: 2 as const, kind: 'cross-session-real-host-series' as const,
      status: 'incomplete' as const, conclusion: 'performance-not-established' as const,
      frozenPlan, protocol, protocolDigest: protocol?.protocolDigest ?? null,
      baselineBuildId: frozenPlan.baselineBuildId, candidateBuildId: frozenPlan.candidateBuildId,
      exploratory, slots, assessment,
      provenance: { host: 'codex-cli', binaryVersion: qualifiedCodexCli.version,
        binarySha256: qualifiedCodexCli.sha256, buildVerification: 'matched',
        binaryVerification: 'matched', invocation: phase,
        commandProvenanceLimit: 'command-text-and-output-only' } };
    const report = writeRealBenchmarkCheckpoint(input.output, body, !created);
    created = true;
    return report;
  };
  checkpoint();
  let context: Awaited<ReturnType<typeof prepareCrossSessionRealSeries>> | null = null;
  try {
    phase = 'source-attempted';
    checkpoint();
    context = await prepareCrossSessionRealSeries(input.codexBinary,
      frozenPlan.scenarios[0]!.revision);
    const { schemaVersion: _schemaVersion, planDigest: _planDigest, pairs: _pairs,
      order: _order, ...protocolInput } = frozenPlan;
    protocol = createCrossSessionRealProtocol({ ...protocolInput,
      seedStoreDigest: context.seedStoreDigest });
    phase = 'exploratory';
    exploratory = { status: 'running', trials: [] };
    checkpoint();
    const run = (slotIndex: number) => runCrossSessionRealTrial(protocol!, slotIndex,
      protocol!.order[slotIndex]!.condition === 'disabled' ? input.baselineRoot : input.candidateRoot,
      input.codexBinary, context!);
    const probe = await runCrossSessionExploration(protocol, run, trial => {
      exploratory = { status: 'running', trials: [...(exploratory.trials as unknown[]),
        publicCrossSessionTrial(protocol!.order[trial.slotIndex]!, trial)] };
      checkpoint();
    });
    exploratory = { ...exploratory, status: probe.status,
      ...(probe.qualified ? {} : { reason: 'pre-freeze-gate-failed' }) };
    phase = 'stopped-before-series';
    const report = checkpoint();
    return { status: 'incomplete' as const, conclusion: 'performance-not-established' as const,
      planDigest: frozenPlan.planDigest,
      protocolDigest: protocol.protocolDigest, reportDigest: report.reportDigest,
      observedTrials: 0, requiredTrials: slots.length, externalProviderInvoked: true };
  } catch {
    phase = 'source-or-runner-error';
    if (exploratory.status === 'running') exploratory = { ...exploratory,
      status: 'rejected', reason: 'source-not-qualified' };
    const report = checkpoint();
    return { status: 'incomplete' as const, conclusion: 'performance-not-established' as const,
      planDigest: frozenPlan.planDigest, protocolDigest: protocol?.protocolDigest ?? null,
      reportDigest: report.reportDigest, observedTrials: 0, requiredTrials: slots.length,
      externalProviderAttempted: true, externalProviderInvoked: null };
  } finally {
    if (context) closeCrossSessionRealSeries(context);
  }
}

async function verifyBinaryIdentity(binaryPath: string): Promise<void> {
  const executable = realpathSync(binaryPath);
  if (!statSync(executable).isFile() || await sha256File(executable) !== qualifiedCodexCli.sha256) {
    throw new TypeError('Codex binary digest differs from qualified host.');
  }
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 4_096, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  if (version !== qualifiedCodexCli.version || await sha256File(executable) !== qualifiedCodexCli.sha256) {
    throw new TypeError('Codex binary identity changed during preflight.');
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function readFrozenPlan(path: string): FrozenRealRunPlan {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let parsed: Record<string, unknown>;
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile() || state.size > maximumPlanBytes) throw new TypeError('Real benchmark plan is invalid or too large.');
    const bytes = Buffer.allocUnsafe(maximumPlanBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximumPlanBytes) throw new TypeError('Real benchmark plan is too large.');
    parsed = JSON.parse(bytes.toString('utf8', 0, length)) as Record<string, unknown>;
  } finally { closeSync(descriptor); }
  if (!exactKeys(parsed, ['schemaVersion', 'corpusVersion', 'baselineBuildId', 'candidateBuildId',
    'sourceVersions', 'environment', 'seed', 'scenarios', 'budgets', 'agent', 'fixtureDigest', 'planDigest'])) {
    throw new TypeError('Real benchmark plan is invalid.');
  }
  const { schemaVersion, planDigest, ...input } = parsed;
  if ((schemaVersion !== 1 && schemaVersion !== 2) || typeof planDigest !== 'string'
    || planDigest !== digest(JSON.stringify({ schemaVersion, ...input }))) {
    throw new TypeError('Real benchmark plan was modified.');
  }
  // Validate all frozen values with the qualified protocol factory. A seed-store digest
  // exists only after A; this placeholder is never reported as a qualified protocol.
  const checked = schemaVersion === 1
    ? createRealPairedProtocol({ ...input, seedStoreDigest: '0'.repeat(64) } as
      Parameters<typeof createRealPairedProtocol>[0])
    : createCrossSessionRealProtocol({ ...input, seedStoreDigest: '0'.repeat(64) } as
      Parameters<typeof createCrossSessionRealProtocol>[0]);
  const expectedFixtureDigest = schemaVersion === 1 ? packageManagerFixtureDigest
    : input.corpusVersion === 'b2-3' ? crossSessionFixtureDigestV2 : crossSessionFixtureDigest;
  if (checked.fixtureDigest !== expectedFixtureDigest) {
    throw new TypeError('Real benchmark fixture differs from frozen scenario.');
  }
  const { seedStoreDigest: _seedStoreDigest, protocolDigest: _protocolDigest,
    schemaVersion: _protocolSchemaVersion, pairs: _pairs, order, ...validatedInput } = checked;
  return Object.freeze({ schemaVersion, ...validatedInput, pairs: 5, order,
    planDigest }) as FrozenRealRunPlan;
}

function writeNewReport(output: string, value: unknown): void {
  const temporary = join(dirname(output), `.${randomUUID()}.avb-report.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    linkSync(temporary, output);
    syncReportDirectory(output);
  } finally {
    try { unlinkSync(temporary); } catch { /* No temporary file was created. */ }
  }
}

function syncReportDirectory(output: string): void {
  const descriptor = openSync(dirname(output), 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function assertSafeReport(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (containsCredentialMaterial(current)) throw new TypeError('Real benchmark report contains private material.');
    } else if (Array.isArray(current)) pending.push(...current);
    else if (current !== null && typeof current === 'object') pending.push(...Object.values(current));
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
