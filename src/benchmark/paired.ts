import { readFileSync, statSync } from 'node:fs';
import { digest, assertComparable, type RunManifest } from './manifest.js';
import { assessPairedPilot, type PilotTrial } from './pilot.js';

const conditions = ['disabled', 'passive', 'advice'] as const;
const maximumReports = 300;
const maximumReportBytes = 4 * 1024 * 1024;
export interface PairedSlot { readonly scenarioId: string; readonly pair: number; readonly condition: 'disabled' | 'passive' | 'advice' }
export interface PairedProtocol {
  readonly schemaVersion: 1; readonly corpusVersion: string; readonly baselineBuildId: string; readonly candidateBuildId: string;
  readonly sourceVersions: { readonly runnerCorpus: string; readonly aap: string };
  readonly environment: { readonly nodeMajor: number; readonly platform: string; readonly arch: string };
  readonly seed: number; readonly pairs: 5; readonly scenarios: readonly { readonly id: string; readonly revision: 1 }[];
  readonly budgets: { readonly wallMilliseconds: number; readonly aelOverheadMilliseconds: number; readonly tokens: number | null };
  readonly order: readonly PairedSlot[]; readonly protocolDigest: string;
}

type PairedInput = Omit<PairedProtocol, 'schemaVersion' | 'pairs' | 'order' | 'protocolDigest'>;

export function createPairedProtocol(input: PairedInput): PairedProtocol {
  const key = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9@._-]{0,79}$/.test(value);
  if (!exactKeys(input, ['corpusVersion', 'baselineBuildId', 'candidateBuildId', 'sourceVersions', 'environment', 'seed', 'scenarios', 'budgets'])
    || !exactKeys(input.sourceVersions, ['runnerCorpus', 'aap']) || !exactKeys(input.environment, ['nodeMajor', 'platform', 'arch'])
    || !exactKeys(input.budgets, ['wallMilliseconds', 'aelOverheadMilliseconds', 'tokens'])
    || input.corpusVersion !== 'b2-1' || !hex(input.baselineBuildId) || !hex(input.candidateBuildId)
    || !key(input.sourceVersions?.runnerCorpus) || !key(input.sourceVersions?.aap)
    || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff
    || input.environment?.nodeMajor !== Number(process.versions.node.split('.')[0])
    || input.environment.platform !== process.platform || input.environment.arch !== process.arch
    || !Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > 20
    || new Set(input.scenarios.map(scenario => scenario.id)).size !== input.scenarios.length
    || input.scenarios.some(scenario => !exactKeys(scenario, ['id', 'revision']) || !key(scenario.id) || scenario.revision !== 1)
    || !Number.isSafeInteger(input.budgets?.wallMilliseconds) || input.budgets.wallMilliseconds < 1 || input.budgets.wallMilliseconds > 3_600_000
    || !Number.isSafeInteger(input.budgets.aelOverheadMilliseconds) || input.budgets.aelOverheadMilliseconds < 0
    || input.budgets.aelOverheadMilliseconds > input.budgets.wallMilliseconds
    || input.budgets.tokens !== null && (!Number.isSafeInteger(input.budgets.tokens) || input.budgets.tokens < 0)) {
    throw new TypeError('Paired benchmark protocol is invalid.');
  }
  const order: PairedSlot[] = input.scenarios.flatMap(scenario => Array.from({ length: 5 }, (_, pair) =>
    conditions.map(condition => ({ scenarioId: scenario.id, pair, condition })))).flat();
  let state = input.seed || 1;
  for (let index = order.length - 1; index > 0; index--) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const target = (state >>> 0) % (index + 1);
    [order[index], order[target]] = [order[target]!, order[index]!];
  }
  const body = { schemaVersion: 1 as const, ...input, pairs: 5 as const, order };
  return Object.freeze({ ...body, protocolDigest: digest(JSON.stringify(body)) });
}

function validatedProtocol(protocol: PairedProtocol): PairedProtocol {
  const { schemaVersion, pairs, order, protocolDigest, ...input } = protocol;
  const expected = createPairedProtocol(input);
  if (schemaVersion !== 1 || pairs !== 5 || protocolDigest !== expected.protocolDigest
    || JSON.stringify(order) !== JSON.stringify(expected.order)) throw new TypeError('Paired benchmark protocol was substituted.');
  return expected;
}

export function assessPairedReports(protocol: PairedProtocol, reports: readonly { readonly slot: PairedSlot; readonly path: string }[]) {
  const fixed = validatedProtocol(protocol);
  if (!Array.isArray(reports) || reports.length > maximumReports) throw new TypeError('Paired report set exceeds bounds.');
  const slots = new Set(fixed.order.map(slotKey));
  const seen = new Set<string>();
  const trials: PilotTrial[] = [];
  let baselineManifest: RunManifest | undefined;
  let candidateManifest: RunManifest | undefined;
  let context: string | undefined;
  for (const entry of reports) {
    const key = slotKey(entry.slot);
    if (!slots.has(key) || seen.has(key)) throw new TypeError('Paired report slot is invalid or repeated.');
    seen.add(key);
    const report = readReport(entry.path);
    const expectedBuild = entry.slot.condition === 'disabled' ? fixed.baselineBuildId : fixed.candidateBuildId;
    const manifest = report.manifest as RunManifest;
    if (report.buildId !== expectedBuild || manifest.buildId !== expectedBuild
      || manifest.role !== (entry.slot.condition === 'disabled' ? 'baseline' : 'candidate')
      || manifest.corpusVersion !== fixed.sourceVersions.runnerCorpus
      || JSON.stringify(manifest.environment) !== JSON.stringify(fixed.environment)
      || manifest.budgets.runMilliseconds > fixed.budgets.wallMilliseconds
      || !manifest.scenarios.some(scenario => scenario.id === entry.slot.scenarioId && scenario.revision === 1)) {
      throw new TypeError('Paired report context is incompatible.');
    }
    const { role: _role, label: _label, buildId: _buildId, ...sharedContext } = manifest;
    const serializedContext = JSON.stringify(sharedContext);
    if (context !== undefined && context !== serializedContext) throw new TypeError('Paired report context changed within series.');
    context = serializedContext;
    if (entry.slot.condition === 'disabled') baselineManifest ??= manifest;
    else candidateManifest ??= manifest;
    if (baselineManifest && candidateManifest) assertComparable(baselineManifest, candidateManifest);
    const host = report.actualHost as { status?: string; qualification?: string } | undefined;
    const observation = report.pilot as (PilotTrial & { readonly integrationVersion?: string }) | undefined;
    if (fixed.sourceVersions.aap === 'unsupported' || host?.status !== 'observed' || host.qualification !== 'verified'
      || observation?.integrationVersion !== fixed.sourceVersions.aap) continue;
    if (observation.scenarioId !== entry.slot.scenarioId || observation.pair !== entry.slot.pair
      || observation.condition !== entry.slot.condition) throw new TypeError('Paired observation slot conflicts with report.');
    const wall = observation.wallMilliseconds;
    const overhead = observation.aelOverheadMilliseconds;
    const measuredTokens = manifest.telemetry.tokens === 'available' && fixed.budgets.tokens !== null ? observation.tokens : null;
    const exceeded = wall !== null && overhead !== null && wall + overhead > fixed.budgets.wallMilliseconds
      || overhead !== null && overhead > fixed.budgets.aelOverheadMilliseconds
      || measuredTokens !== null && fixed.budgets.tokens !== null && measuredTokens > fixed.budgets.tokens;
    trials.push({ ...observation, tokens: measuredTokens,
      safetyViolations: exceeded ? [...observation.safetyViolations, 'budget-exceeded'] : observation.safetyViolations });
  }
  const assessed = assessPairedPilot(trials);
  const complete = seen.size === fixed.order.length && trials.length === fixed.order.length;
  const status = !complete && assessed.status !== 'safety-fail' && assessed.status !== 'correctness-fail'
    ? 'incomplete' as const : assessed.status;
  return Object.freeze({ status, conclusion: complete ? assessed.conclusion : 'performance-not-established' as const,
    observedTrials: trials.length, requiredTrials: fixed.order.length, missingSlots: fixed.order.length - trials.length,
    telemetry: Object.freeze({ wallTime: trials.length > 0 && trials.every(trial => trial.wallMilliseconds !== null) ? 'available' as const : 'unavailable' as const,
      aelOverhead: trials.length > 0 && trials.every(trial => trial.aelOverheadMilliseconds !== null) ? 'available' as const : 'unavailable' as const,
      tokens: trials.length > 0 && trials.every(trial => trial.tokens !== null) ? 'available' as const : 'unavailable' as const }),
    scenarios: assessed.scenarios });
}

function readReport(path: string): Record<string, unknown> {
  if (statSync(path).size > maximumReportBytes) throw new TypeError('Paired report exceeds size bound.');
  const report = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const { reportDigest, ...body } = report;
  if (typeof reportDigest !== 'string' || digest(JSON.stringify(body)) !== reportDigest || report.status !== 'complete'
    || typeof report.manifest !== 'object' || report.manifest === null) throw new TypeError('Paired report was modified.');
  return report;
}

function hex(value: string): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function slotKey(slot: PairedSlot): string { return `${slot.scenarioId}:${slot.pair}:${slot.condition}`; }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
