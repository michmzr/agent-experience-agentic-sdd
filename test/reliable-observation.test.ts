import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

type ReceiptDisposition = 'accepted' | 'privacy-redaction' | 'unsupported';
type EvidenceGap = 'result-not-delivered' | 'privacy-redacted' | 'verification-not-observed';
type AnalysisState = 'completed' | 'incomplete';

interface Scenario {
  readonly id: string;
  readonly expectedDisposition: ReceiptDisposition;
  readonly expectedEvidenceGaps: readonly EvidenceGap[];
  readonly expectedRelationships: {
    readonly transportIds: readonly string[];
    readonly receiptIds: readonly string[];
    readonly resultIds: readonly string[];
  };
}

interface Fixture {
  readonly version: 1;
  readonly synthetic: true;
  readonly scenarios: readonly Scenario[];
  readonly transports: readonly { id: string; scenarioId: string; kind: 'lifecycle' | 'operation' }[];
  readonly receipts: readonly { id: string; scenarioId: string; operationId: string; disposition: ReceiptDisposition }[];
  readonly results: readonly { id: string; scenarioId: string; relatedOperationId: string; unknownReason?: EvidenceGap }[];
  readonly analysis: readonly { id: string; scenarioId: string; state: AnalysisState; costUnits: number }[];
  readonly findings: readonly { id: string; scenarioId: string }[];
  readonly abstentions: readonly { id: string; scenarioId: string; evidenceGaps: readonly EvidenceGap[] }[];
  readonly expectedQuality: QualityMeasure;
}

interface QualityMeasure {
  readonly transportRecords: number;
  readonly uniqueOperations: number;
  readonly durableReceipts: number;
  readonly linkedResults: number;
  readonly skips: Readonly<Record<string, number>>;
  readonly unknownReasons: Readonly<Record<string, number>>;
  readonly analysisStates: Readonly<Record<string, number>>;
  readonly findings: number;
  readonly abstentions: number;
  readonly cost: number;
}

interface ValidatedReceipts {
  readonly ids: ReadonlyMap<string, string>;
  readonly operationOwners: ReadonlyMap<string, string>;
  readonly dispositions: ReadonlyMap<string, readonly ReceiptDisposition[]>;
}

interface ValidatedResults {
  readonly ids: ReadonlyMap<string, string>;
  readonly evidenceGaps: ReadonlyMap<string, ReadonlySet<EvidenceGap>>;
  readonly operationLinks: readonly { id: string; scenarioId: string; relatedOperationId: string }[];
}

test('contains the six synthetic reliable-observation scenarios and their deterministic baseline', () => {
  const fixture = parseFixture(readFixture());

  assert.equal(fixture.synthetic, true);
  assert.deepEqual(fixture.scenarios.map(({ id }) => id), [
    'resume-after-run-end', 'missing-result', 'privacy-redaction',
    'expected-red', 'liquibase-to-sql', 'closure-with-verification-gap'
  ]);
  assert.deepEqual(evaluateReliableObservationFixture(fixture), fixture.expectedQuality);
});

test('rejects unsafe, incomplete, and duplicate synthetic corpus records', () => {
  const fixture = parseFixture(readFixture());
  const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['raw transcript key', { ...fixture, rawTranscript: 'synthetic-only' }, /raw transcript key/i],
    ['absolute private path', replaceFirstScenario(fixture, { id: '/private/synthetic' }), /absolute or private path/i],
    ['credential-like value', replaceFirstScenario(fixture, { expectedEvidenceGaps: ['token=synthetic-value'] }), /credential-like value/i],
    ['duplicate scenario id', { ...fixture, scenarios: [...fixture.scenarios, fixture.scenarios[0]] }, /duplicate scenario id/i],
    ['missing expected disposition', replaceFirstScenario(fixture, { expectedDisposition: undefined }), /expectedDisposition/i],
    ['missing expected evidence gaps', replaceFirstScenario(fixture, { expectedEvidenceGaps: undefined }), /expectedEvidenceGaps/i]
  ];

  for (const [name, invalid, expectation] of cases) {
    assert.throws(() => parseFixture(invalid), expectation, name);
  }
});

test('rejects cross-scenario ownership, unlinked results, and inconsistent expected evidence', () => {
  const fixture = parseFixture(readFixture());
  const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['receipt ownership', replaceRecord(fixture, 'receipts', 0, { scenarioId: 'missing-result' }), /receipt relationship ownership mismatch/i],
    ['result ownership', replaceRecord(fixture, 'results', 0, { scenarioId: 'missing-result' }), /result relationship ownership mismatch/i],
    ['result operation linkage', replaceRecord(fixture, 'results', 0, { relatedOperationId: 'operation-unlinked' }), /result operation linkage is missing/i],
    ['expected disposition', replaceRecord(fixture, 'receipts', 0, { disposition: 'unsupported' }), /expected disposition mismatch/i],
    ['expected evidence gaps', replaceFirstScenario(fixture, { expectedEvidenceGaps: ['result-not-delivered'] }), /expected evidence gaps mismatch/i]
  ];

  for (const [name, invalid, expectation] of cases) {
    assert.throws(() => parseFixture(invalid), expectation, name);
  }
});

function readFixture(): unknown {
  const path = join(process.cwd(), 'test', 'fixtures', 'reliable-observation', 'scenarios.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function replaceFirstScenario(fixture: Fixture, replacement: Record<string, unknown>): unknown {
  return {
    ...fixture,
    scenarios: [{ ...fixture.scenarios[0], ...replacement }, ...fixture.scenarios.slice(1)]
  };
}

function replaceRecord(fixture: Fixture, collection: 'receipts' | 'results', index: number, replacement: Record<string, unknown>): unknown {
  const records = fixture[collection];
  return { ...fixture, [collection]: [...records.slice(0, index), { ...records[index], ...replacement }, ...records.slice(index + 1)] };
}

function parseFixture(value: unknown): Fixture {
  assertObject(value, 'fixture');
  rejectUnsafeFixtureData(value);
  assertClosedKeys(value, ['version', 'synthetic', 'scenarios', 'transports', 'receipts', 'results', 'analysis', 'findings', 'abstentions', 'expectedQuality'], 'fixture');
  assert.equal(value.version, 1, 'fixture.version');
  assert.equal(value.synthetic, true, 'fixture.synthetic');
  for (const key of ['scenarios', 'transports', 'receipts', 'results', 'analysis', 'findings', 'abstentions'] as const) assertArray(value[key], `fixture.${key}`);
  assertObject(value.expectedQuality, 'fixture.expectedQuality');

  const scenarioIds = new Set<string>();
  const expectedTransportIds = new Map<string, readonly string[]>();
  const expectedReceiptIds = new Map<string, readonly string[]>();
  const expectedResultIds = new Map<string, readonly string[]>();
  const expectedDispositions = new Map<string, ReceiptDisposition>();
  const expectedEvidenceGaps = new Map<string, readonly EvidenceGap[]>();
  for (const scenario of value.scenarios as unknown[]) {
    assertObject(scenario, 'scenario');
    assertClosedKeys(scenario, ['id', 'expectedDisposition', 'expectedEvidenceGaps', 'expectedRelationships'], 'scenario');
    assertString(scenario.id, 'scenario.id');
    assert.ok(!scenarioIds.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    assertString(scenario.expectedDisposition, 'scenario.expectedDisposition');
    assertOneOf(scenario.expectedDisposition, ['accepted', 'privacy-redaction', 'unsupported'], 'scenario.expectedDisposition');
    assert.ok(Array.isArray(scenario.expectedEvidenceGaps), 'scenario.expectedEvidenceGaps');
    assertObject(scenario.expectedRelationships, 'scenario.expectedRelationships');
    assertClosedKeys(scenario.expectedRelationships, ['transportIds', 'receiptIds', 'resultIds'], 'scenario.expectedRelationships');
    assertStringArray(scenario.expectedRelationships.transportIds, 'scenario.expectedRelationships.transportIds');
    assertStringArray(scenario.expectedRelationships.receiptIds, 'scenario.expectedRelationships.receiptIds');
    assertStringArray(scenario.expectedRelationships.resultIds, 'scenario.expectedRelationships.resultIds');
    for (const evidenceGap of scenario.expectedEvidenceGaps) assertOneOf(evidenceGap, ['result-not-delivered', 'privacy-redacted', 'verification-not-observed'], 'scenario.expectedEvidenceGaps');
    expectedTransportIds.set(scenario.id, scenario.expectedRelationships.transportIds);
    expectedReceiptIds.set(scenario.id, scenario.expectedRelationships.receiptIds);
    expectedResultIds.set(scenario.id, scenario.expectedRelationships.resultIds);
    expectedDispositions.set(scenario.id, scenario.expectedDisposition as ReceiptDisposition);
    expectedEvidenceGaps.set(scenario.id, scenario.expectedEvidenceGaps as EvidenceGap[]);
  }

  const transportIds = validateTransports(value.transports as unknown[], scenarioIds);
  const receipts = validateReceipts(value.receipts as unknown[], scenarioIds);
  validateReferences(expectedTransportIds, transportIds, 'transport');
  validateReferences(expectedReceiptIds, receipts.ids, 'receipt');
  const results = validateResults(value.results as unknown[], scenarioIds);
  validateReferences(expectedResultIds, results.ids, 'result');
  validateResultOperationLinks(results.operationLinks, receipts.operationOwners);
  validateExpectedDispositions(expectedDispositions, receipts.dispositions);
  validateAnalysis(value.analysis as unknown[], scenarioIds);
  validateFindings(value.findings as unknown[], scenarioIds, 'findings');
  const abstentionEvidenceGaps = validateAbstentions(value.abstentions as unknown[], scenarioIds);
  validateExpectedEvidenceGaps(expectedEvidenceGaps, results.evidenceGaps, abstentionEvidenceGaps);
  validateExpectedQuality(value.expectedQuality);

  return value as unknown as Fixture;
}

function evaluateReliableObservationFixture(fixture: Fixture): QualityMeasure {
  const receipts = new Map(fixture.receipts.map((receipt) => [receipt.id, receipt]));
  const admittedOperationIds = new Set(fixture.receipts.map(({ operationId }) => operationId));
  return Object.freeze({
    transportRecords: fixture.transports.length,
    uniqueOperations: admittedOperationIds.size,
    durableReceipts: receipts.size,
    linkedResults: fixture.results.filter(({ relatedOperationId }) => admittedOperationIds.has(relatedOperationId)).length,
    skips: countBy(fixture.receipts.filter(({ disposition }) => disposition !== 'accepted'), 'disposition'),
    unknownReasons: countBy(fixture.results.filter(hasUnknownReason), 'unknownReason'),
    analysisStates: countBy(fixture.analysis, 'state'),
    findings: fixture.findings.length,
    abstentions: fixture.abstentions.length,
    cost: fixture.analysis.reduce((total, { costUnits }) => total + costUnits, 0)
  });
}

function hasUnknownReason(result: Fixture['results'][number]): result is Fixture['results'][number] & { unknownReason: EvidenceGap } {
  return result.unknownReason !== undefined;
}

function countBy<T extends Record<string, unknown>>(values: readonly T[], key: keyof T): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const name = String(value[key]);
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
}

function rejectUnsafeFixtureData(value: unknown): void {
  if (typeof value === 'string') {
    assert.ok(!/(?:^\/|^~\/|^[A-Za-z]:\\|\/Users\/|\/private\/|\/home\/)/.test(value), `absolute or private path: ${value}`);
    assert.ok(!/(?:api[_-]?key|password|secret|token|authorization|bearer|sk-[\w-]+)\s*(?:=|:|\S)/i.test(value), `credential-like value: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectUnsafeFixtureData(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      assert.ok(!/^(?:raw(?:Transcript|Output|Command|Prompt)?|transcript|output|command|arguments|prompt|cwd|path|sourceEventId)$/i.test(nestedKey), `raw transcript key: ${nestedKey}`);
      rejectUnsafeFixtureData(nestedValue);
    }
  }
}

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
}

function assertClosedKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `${name} has unexpected key: ${key}`);
}

function assertString(value: unknown, name: string): asserts value is string {
  assert.equal(typeof value, 'string', `${name} must be a string`);
}

function assertArray(value: unknown, name: string): asserts value is unknown[] {
  assert.ok(Array.isArray(value), `${name} must be an array`);
}

function assertStringArray(value: unknown, name: string): asserts value is readonly string[] {
  assert.ok(Array.isArray(value) && value.every((item) => typeof item === 'string'), `${name} must be a string array`);
}

function validateTransports(records: unknown[], scenarioIds: ReadonlySet<string>): Map<string, string> {
  const ids = new Map<string, string>();
  for (const record of records) {
    assertObject(record, 'transport');
    assertClosedKeys(record, ['id', 'scenarioId', 'kind'], 'transport');
    assertString(record.id, 'transport.id');
    assertScenarioReference(record.scenarioId, scenarioIds, 'transport.scenarioId');
    assertOneOf(record.kind, ['lifecycle', 'operation'], 'transport.kind');
    assert.ok(!ids.has(record.id), `duplicate transport id: ${record.id}`);
    ids.set(record.id, record.scenarioId);
  }
  return ids;
}

function validateReceipts(records: unknown[], scenarioIds: ReadonlySet<string>): ValidatedReceipts {
  const ids = new Map<string, string>();
  const operationOwners = new Map<string, string>();
  const dispositions = new Map<string, ReceiptDisposition[]>();
  for (const record of records) {
    assertObject(record, 'receipt');
    assertClosedKeys(record, ['id', 'scenarioId', 'operationId', 'disposition'], 'receipt');
    assertString(record.id, 'receipt.id');
    assertScenarioReference(record.scenarioId, scenarioIds, 'receipt.scenarioId');
    assertString(record.operationId, 'receipt.operationId');
    assertOneOf(record.disposition, ['accepted', 'privacy-redaction', 'unsupported'], 'receipt.disposition');
    assert.ok(!ids.has(record.id), `duplicate receipt id: ${record.id}`);
    assert.ok(!operationOwners.has(record.operationId), `duplicate operation id: ${record.operationId}`);
    ids.set(record.id, record.scenarioId);
    operationOwners.set(record.operationId, record.scenarioId);
    dispositions.set(record.scenarioId, [...(dispositions.get(record.scenarioId) ?? []), record.disposition as ReceiptDisposition]);
  }
  return { ids, operationOwners, dispositions };
}

function validateResults(records: unknown[], scenarioIds: ReadonlySet<string>): ValidatedResults {
  const ids = new Map<string, string>();
  const evidenceGaps = new Map<string, Set<EvidenceGap>>();
  const operationLinks: { id: string; scenarioId: string; relatedOperationId: string }[] = [];
  for (const record of records) {
    assertObject(record, 'result');
    assertClosedKeys(record, ['id', 'scenarioId', 'relatedOperationId', 'unknownReason'], 'result');
    assertString(record.id, 'result.id');
    assertScenarioReference(record.scenarioId, scenarioIds, 'result.scenarioId');
    assertString(record.relatedOperationId, 'result.relatedOperationId');
    if (record.unknownReason !== undefined) {
      assertOneOf(record.unknownReason, ['result-not-delivered', 'privacy-redacted', 'verification-not-observed'], 'result.unknownReason');
      evidenceGaps.set(record.scenarioId, new Set([...(evidenceGaps.get(record.scenarioId) ?? []), record.unknownReason as EvidenceGap]));
    }
    assert.ok(!ids.has(record.id), `duplicate result id: ${record.id}`);
    ids.set(record.id, record.scenarioId);
    operationLinks.push({ id: record.id, scenarioId: record.scenarioId, relatedOperationId: record.relatedOperationId });
  }
  return { ids, evidenceGaps, operationLinks };
}

function validateAnalysis(records: unknown[], scenarioIds: ReadonlySet<string>): void {
  for (const record of records) {
    assertObject(record, 'analysis');
    assertClosedKeys(record, ['id', 'scenarioId', 'state', 'costUnits'], 'analysis');
    assertString(record.id, 'analysis.id');
    assertScenarioReference(record.scenarioId, scenarioIds, 'analysis.scenarioId');
    assertOneOf(record.state, ['completed', 'incomplete'], 'analysis.state');
    assert.ok(typeof record.costUnits === 'number' && Number.isSafeInteger(record.costUnits) && record.costUnits >= 0, 'analysis.costUnits');
  }
}

function validateFindings(records: unknown[], scenarioIds: ReadonlySet<string>, name: string): void {
  for (const record of records) {
    assertObject(record, name);
    assertClosedKeys(record, ['id', 'scenarioId'], name);
    assertString(record.id, `${name}.id`);
    assertScenarioReference(record.scenarioId, scenarioIds, `${name}.scenarioId`);
  }
}

function validateAbstentions(records: unknown[], scenarioIds: ReadonlySet<string>): ReadonlyMap<string, ReadonlySet<EvidenceGap>> {
  const evidenceGaps = new Map<string, Set<EvidenceGap>>();
  for (const record of records) {
    assertObject(record, 'abstention');
    assertClosedKeys(record, ['id', 'scenarioId', 'evidenceGaps'], 'abstention');
    assertString(record.id, 'abstention.id');
    assertScenarioReference(record.scenarioId, scenarioIds, 'abstention.scenarioId');
    assertStringArray(record.evidenceGaps, 'abstention.evidenceGaps');
    for (const evidenceGap of record.evidenceGaps) {
      assertOneOf(evidenceGap, ['result-not-delivered', 'privacy-redacted', 'verification-not-observed'], 'abstention.evidenceGaps');
      evidenceGaps.set(record.scenarioId, new Set([...(evidenceGaps.get(record.scenarioId) ?? []), evidenceGap as EvidenceGap]));
    }
  }
  return evidenceGaps;
}

function validateReferences(expected: ReadonlyMap<string, readonly string[]>, actual: ReadonlyMap<string, string>, name: string): void {
  const expectedOwners = new Map<string, string>();
  for (const [scenarioId, ids] of expected) {
    for (const id of ids) {
      assert.ok(!expectedOwners.has(id), `duplicate expected ${name} relationship: ${id}`);
      expectedOwners.set(id, scenarioId);
      assert.equal(actual.get(id), scenarioId, `${name} relationship ownership mismatch: ${id}`);
    }
  }
  assert.equal(actual.size, expectedOwners.size, `unexpected ${name} relationship`);
}

function validateExpectedDispositions(expected: ReadonlyMap<string, ReceiptDisposition>, actual: ReadonlyMap<string, readonly ReceiptDisposition[]>): void {
  for (const [scenarioId, expectedDisposition] of expected) {
    const dispositions = actual.get(scenarioId);
    assert.ok(dispositions !== undefined && dispositions.length > 0 && dispositions.every((disposition) => disposition === expectedDisposition), `expected disposition mismatch: ${scenarioId}`);
  }
}

function validateResultOperationLinks(links: readonly { id: string; scenarioId: string; relatedOperationId: string }[], operationOwners: ReadonlyMap<string, string>): void {
  for (const link of links) {
    const operationOwner = operationOwners.get(link.relatedOperationId);
    assert.ok(operationOwner !== undefined, `result operation linkage is missing: ${link.relatedOperationId}`);
    assert.equal(operationOwner, link.scenarioId, `result operation linkage ownership mismatch: ${link.id}`);
  }
}

function validateExpectedEvidenceGaps(expected: ReadonlyMap<string, readonly EvidenceGap[]>, resultGaps: ReadonlyMap<string, ReadonlySet<EvidenceGap>>, abstentionGaps: ReadonlyMap<string, ReadonlySet<EvidenceGap>>): void {
  for (const [scenarioId, expectedGaps] of expected) {
    const observed = new Set<EvidenceGap>([...(resultGaps.get(scenarioId) ?? []), ...(abstentionGaps.get(scenarioId) ?? [])]);
    assert.deepEqual([...observed].sort(), [...expectedGaps].sort(), `expected evidence gaps mismatch: ${scenarioId}`);
  }
}

function validateExpectedQuality(value: Record<string, unknown>): void {
  assertClosedKeys(value, ['transportRecords', 'uniqueOperations', 'durableReceipts', 'linkedResults', 'skips', 'unknownReasons', 'analysisStates', 'findings', 'abstentions', 'cost'], 'fixture.expectedQuality');
  for (const key of ['transportRecords', 'uniqueOperations', 'durableReceipts', 'linkedResults', 'findings', 'abstentions', 'cost']) {
    assert.ok(typeof value[key] === 'number' && Number.isSafeInteger(value[key]), `fixture.expectedQuality.${key}`);
  }
  for (const key of ['skips', 'unknownReasons', 'analysisStates']) assertObject(value[key], `fixture.expectedQuality.${key}`);
}

function assertScenarioReference(value: unknown, scenarioIds: ReadonlySet<string>, name: string): asserts value is string {
  assertString(value, name);
  assert.ok(scenarioIds.has(value), `${name} must reference a scenario`);
}

function assertOneOf(value: unknown, allowed: readonly string[], name: string): void {
  assert.ok(typeof value === 'string' && allowed.includes(value), `${name} is unsupported`);
}
