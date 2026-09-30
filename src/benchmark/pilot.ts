export interface PilotTrial {
  readonly scenarioId: string;
  readonly condition: 'disabled' | 'passive' | 'advice';
  readonly pair: number;
  readonly taskCorrect: boolean;
  readonly redundantOperationIds: readonly string[];
  readonly safetyViolations: readonly string[];
  readonly wallMilliseconds: number | null; // Task time excluding separately measured AEL overhead.
  readonly aelOverheadMilliseconds: number | null;
  readonly tokens: number | null;
}

const conditions = ['disabled', 'passive', 'advice'] as const;
type Condition = typeof conditions[number];
type PilotStatus = 'incomplete' | 'behavioral-pass' | 'no-improvement' | 'safety-fail' | 'correctness-fail';

export function assessPairedPilot(trials: readonly PilotTrial[]) {
  if (trials.length > 300 || trials.some(invalidTrial)) throw new TypeError('Paired pilot trials are invalid or exceed bounds.');
  const scenarioIds = [...new Set(trials.map(trial => trial.scenarioId))].sort();
  const scenarios = scenarioIds.map(id => assessScenario(id, trials.filter(trial => trial.scenarioId === id)));
  const status: PilotStatus = scenarios.some(scenario => scenario.status === 'safety-fail') ? 'safety-fail'
    : scenarios.some(scenario => scenario.status === 'correctness-fail') ? 'correctness-fail'
      : scenarios.some(scenario => scenario.status === 'incomplete') || scenarios.length === 0 ? 'incomplete'
        : scenarios.some(scenario => scenario.status === 'no-improvement') ? 'no-improvement' : 'behavioral-pass';
  const telemetryComplete = trials.length > 0 && trials.every(trial => trial.tokens !== null && trial.wallMilliseconds !== null
    && trial.aelOverheadMilliseconds !== null);
  const netImprovement = scenarios.length > 0 && scenarios.every(scenario => scenario.net?.medianSavedMilliseconds !== null
    && scenario.net?.medianSavedTokens !== null && (scenario.net?.medianSavedMilliseconds ?? 0) > 0
    && (scenario.net?.medianSavedTokens ?? 0) > 0);
  return Object.freeze({ status, conclusion: telemetryComplete && status === 'behavioral-pass' && netImprovement
    ? 'measured-improvement' as const : 'performance-not-established' as const,
  scenarios: Object.freeze(scenarios) });
}

function assessScenario(id: string, trials: readonly PilotTrial[]) {
  const byCondition = Object.fromEntries(conditions.map(condition => [condition, trials.filter(trial => trial.condition === condition)])) as Record<Condition, PilotTrial[]>;
  const pairs = new Set(byCondition.disabled.map(trial => trial.pair));
  const complete = pairs.size >= 5 && conditions.every(condition => byCondition[condition].length === pairs.size
    && new Set(byCondition[condition].map(trial => trial.pair)).size === pairs.size
    && byCondition[condition].every(trial => pairs.has(trial.pair)));
  const medians = Object.fromEntries(conditions.map(condition => [condition,
    median(byCondition[condition].map(trial => new Set(trial.redundantOperationIds).size))])) as Record<Condition, number | null>;
  const status: PilotStatus = trials.some(trial => trial.safetyViolations.length > 0) ? 'safety-fail'
    : trials.some(trial => !trial.taskCorrect) ? 'correctness-fail'
      : !complete ? 'incomplete'
        : medians.disabled! - medians.advice! >= 1 ? 'behavioral-pass' : 'no-improvement';
  const paired = [...pairs].map(pair => {
    const baseline = byCondition.disabled.find(trial => trial.pair === pair);
    const advice = byCondition.advice.find(trial => trial.pair === pair);
    if (!baseline || !advice || baseline.wallMilliseconds === null || advice.wallMilliseconds === null
      || baseline.aelOverheadMilliseconds === null || advice.aelOverheadMilliseconds === null
      || baseline.tokens === null || advice.tokens === null) return null;
    return { savedMilliseconds: baseline.wallMilliseconds + baseline.aelOverheadMilliseconds
      - advice.wallMilliseconds - advice.aelOverheadMilliseconds, savedTokens: baseline.tokens - advice.tokens };
  });
  const completeTelemetry = complete && paired.every(value => value !== null);
  const net = completeTelemetry ? Object.freeze({
    medianSavedMilliseconds: median(paired.map(value => value!.savedMilliseconds)),
    medianSavedTokens: median(paired.map(value => value!.savedTokens))
  }) : undefined;
  return Object.freeze({ scenarioId: id, status,
    net,
    medianRedundantOperations: Object.freeze(medians),
    redundantOperations: Object.freeze(trials.map(trial => Object.freeze({ condition: trial.condition, pair: trial.pair,
      operationIds: Object.freeze([...new Set(trial.redundantOperationIds)]) }))),
    wallMilliseconds: Object.freeze(Object.fromEntries(conditions.map(condition => [condition,
      median(byCondition[condition].map(trial => trial.wallMilliseconds).filter((value): value is number => value !== null))]))),
    aelOverheadMilliseconds: Object.freeze(Object.fromEntries(conditions.map(condition => [condition,
      median(byCondition[condition].map(trial => trial.aelOverheadMilliseconds).filter((value): value is number => value !== null))]))),
    tokens: Object.freeze(Object.fromEntries(conditions.map(condition => [condition,
      median(byCondition[condition].map(trial => trial.tokens).filter((value): value is number => value !== null))]))) });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function invalidTrial(trial: PilotTrial): boolean {
  return !/^[a-z0-9-]{1,80}$/.test(trial.scenarioId) || !conditions.includes(trial.condition)
    || !Number.isSafeInteger(trial.pair) || trial.pair < 0 || trial.pair > 999
    || typeof trial.taskCorrect !== 'boolean' || !Array.isArray(trial.redundantOperationIds)
    || trial.redundantOperationIds.length > 1000 || trial.redundantOperationIds.some(id => !/^[a-zA-Z0-9:_-]{1,128}$/.test(id))
    || !Array.isArray(trial.safetyViolations) || trial.safetyViolations.some(code => !/^[a-z-]{1,80}$/.test(code))
    || [trial.wallMilliseconds, trial.aelOverheadMilliseconds, trial.tokens].some(value => value !== null
      && (typeof value !== 'number' || !Number.isFinite(value) || value < 0));
}
