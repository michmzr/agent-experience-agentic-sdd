import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { buildIdentity, digest, validateRunManifest } from './manifest.js';
import { createPairedProtocol, type PairedProtocol } from './paired.js';
import { containsCredentialMaterial } from '../privacy/structured-arguments.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const maxInputBytes = 1024 * 1024;

function readJson(path: string): unknown {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile()) throw new TypeError('Benchmark trial input must be a regular file.');
    if (state.size > maxInputBytes) throw new TypeError('Benchmark trial input exceeds size bound.');
    const buffer = Buffer.allocUnsafe(maxInputBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > maxInputBytes) throw new TypeError('Benchmark trial input exceeds size bound.');
    return JSON.parse(buffer.toString('utf8', 0, bytes)) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function fixedProtocol(value: unknown): PairedProtocol {
  if (!exactKeys(value, ['schemaVersion', 'corpusVersion', 'baselineBuildId', 'candidateBuildId', 'sourceVersions',
    'environment', 'seed', 'pairs', 'scenarios', 'budgets', 'order', 'protocolDigest'])) {
    throw new TypeError('Paired benchmark protocol is invalid.');
  }
  const { schemaVersion, pairs, order, protocolDigest, ...input } = value;
  const fixed = createPairedProtocol(input as Parameters<typeof createPairedProtocol>[0]);
  if (schemaVersion !== 1 || pairs !== 5 || protocolDigest !== fixed.protocolDigest
    || JSON.stringify(order) !== JSON.stringify(fixed.order)) throw new TypeError('Paired benchmark protocol was substituted.');
  return fixed;
}

function sanitizedDeclaration(value: unknown) {
  if (!exactKeys(value, ['taskCorrect', 'redundantOperationIds', 'safetyViolations', 'wallMilliseconds',
    'aelOverheadMilliseconds', 'tokens']) || typeof value.taskCorrect !== 'boolean'
    || !Array.isArray(value.redundantOperationIds) || value.redundantOperationIds.length > 1000
    || value.redundantOperationIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id))
    || !Array.isArray(value.safetyViolations) || value.safetyViolations.length > 100
    || value.safetyViolations.some(code => typeof code !== 'string' || !/^[a-z-]{1,80}$/.test(code))
    || ['wallMilliseconds', 'aelOverheadMilliseconds', 'tokens'].some(key => {
      const number = value[key];
      return number !== null && (!Number.isSafeInteger(number) || (number as number) < 0);
    })) throw new TypeError('Benchmark trial declaration must contain bounded sanitized measurements.');
  return value;
}

function assertReportStringsSafe(...values: unknown[]): void {
  const pending = [...values];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (containsCredentialMaterial(value)) throw new TypeError('Benchmark trial input contains private material.');
    } else if (Array.isArray(value)) pending.push(...value);
    else if (value !== null && typeof value === 'object') pending.push(...Object.values(value));
  }
}

export function stageTrial(protocolPath: string, slotIndexText: string, manifestPath: string,
  declarationPath: string, output: string): { readonly status: 'incomplete'; readonly reportDigest: string; readonly protocolDigest: string } {
  const protocol = fixedProtocol(readJson(protocolPath));
  const slotIndex = Number(slotIndexText);
  if (!/^(0|[1-9]\d*)$/.test(slotIndexText) || !Number.isSafeInteger(slotIndex) || slotIndex >= protocol.order.length) {
    throw new TypeError('Paired benchmark slot index is invalid.');
  }
  const slot = protocol.order[slotIndex]!;
  const manifest = validateRunManifest(readJson(manifestPath), buildIdentity(packageRoot));
  const expectedBuild = slot.condition === 'disabled' ? protocol.baselineBuildId : protocol.candidateBuildId;
  if (manifest.schemaVersion !== 2 || manifest.buildId !== expectedBuild
    || manifest.role !== (slot.condition === 'disabled' ? 'baseline' : 'candidate')
    || manifest.corpusVersion !== protocol.sourceVersions.runnerCorpus
    || JSON.stringify(manifest.environment) !== JSON.stringify(protocol.environment)
    || manifest.budgets.runMilliseconds > protocol.budgets.wallMilliseconds
    || !manifest.scenarios.some(scenario => scenario.id === slot.scenarioId && scenario.revision === 1)) {
    throw new TypeError('Paired benchmark trial context is incompatible.');
  }
  const declaration = sanitizedDeclaration(readJson(declarationPath));
  if (manifest.telemetry.tokens === 'unavailable' && declaration.tokens !== null) {
    throw new TypeError('Unavailable token telemetry cannot be declared as measured.');
  }
  assertReportStringsSafe(protocol, manifest, declaration);
  const body = { schemaVersion: 1, status: 'incomplete' as const, protocol, protocolDigest: protocol.protocolDigest,
    slotIndex, slot, buildId: manifest.buildId, manifest, declaration,
    actualHost: { status: 'unsupported' as const, reason: 'Independent host delivery and operation witnesses are not qualified.' },
    conclusion: 'performance-not-established' as const };
  const reportDigest = digest(JSON.stringify(body));
  writeFileSync(output, JSON.stringify({ ...body, reportDigest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'incomplete', reportDigest, protocolDigest: protocol.protocolDigest };
}
