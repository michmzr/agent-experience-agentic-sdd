import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertComparable, buildIdentity, digest, validateRunManifest, type RunManifest } from './manifest.js';
import { runPipeline } from './pipeline.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export function currentBuildIdentity(): { schemaVersion: 1; buildId: string } { return { schemaVersion: 1, buildId: buildIdentity(packageRoot) }; }

function resumeMatcherObservation(): { scenarioId: string; revision: 1; kind: 'synthetic'; resumeSupported: boolean; status: 'observed' } {
  // The checked-in hook configuration is the B0 synthetic fixture, not a host delivery witness.
  const config = JSON.parse(readFileSync(join(packageRoot, '.codex/hooks.json'), 'utf8'));
  const groups = config.hooks?.SessionStart;
  const resumeSupported = Array.isArray(groups) && groups.some(group => {
    const matcher = group?.matcher;
    return (matcher === undefined || matcher === '' || matcher === '*' || typeof matcher === 'string' && matcher.split('|').includes('resume'))
      && Array.isArray(group?.hooks) && group.hooks.some((hook: { command?: string }) => typeof hook?.command === 'string' && hook.command.includes('ael-passive-capture.sh'));
  });
  return { scenarioId: 'codex-resume-matcher', revision: 1, kind: 'synthetic', resumeSupported, status: 'observed' };
}

function sealed<T extends object>(body: T): T & { reportDigest: string } { return { ...body, reportDigest: digest(JSON.stringify(body)) }; }
function readSealed(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const { reportDigest, ...body } = value;
  if (typeof reportDigest !== 'string' || digest(JSON.stringify(body)) !== reportDigest) throw new Error('Benchmark report was modified.');
  return value;
}

export function runBaseline(manifestPath: string, output: string): { status: 'complete'; reportDigest: string; buildId: string } {
  const manifest = validateRunManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), currentBuildIdentity().buildId);
  if (existsSync(output)) throw new Error('Benchmark output already exists.');
  const started = Date.now();
  if (manifest.schemaVersion === 2) {
    const pipeline = runPipeline(started + manifest.budgets.runMilliseconds);
    const body = { schemaVersion: 2, status: 'complete', label: manifest.label, buildId: manifest.buildId, manifest,
      observations: pipeline.observations, aclReview: pipeline.aclReview,
      actualHost: { status: 'unsupported', reason: 'No controlled host admission witness.' },
      measurements: { wallMilliseconds: Date.now() - started, tokens: null }, conclusion: 'performance-not-established' };
    const report = sealed(body);
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: 'complete', reportDigest: report.reportDigest, buildId: report.buildId };
  }
  const body = { schemaVersion: 1, status: 'complete', label: manifest.label, buildId: manifest.buildId, manifest,
    observations: [resumeMatcherObservation()], actualHost: { status: 'unsupported', reason: 'No controlled host run in B0.' },
    measurements: { wallMilliseconds: Date.now() - started, tokens: null }, conclusion: 'performance-not-established' };
  const report = sealed(body);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'complete', reportDigest: report.reportDigest, buildId: report.buildId };
}

export function compareBaseline(baselinePath: string, candidatePath: string, output: string): { status: 'compatible-context' } {
  const baseline = readSealed(baselinePath);
  const candidate = readSealed(candidatePath);
  if (baseline.status !== 'complete' || candidate.status !== 'complete' || baseline.buildId !== (baseline.manifest as RunManifest).buildId || candidate.buildId !== (candidate.manifest as RunManifest).buildId) throw new Error('Unrecorded build substitution.');
  assertComparable(baseline.manifest as RunManifest, candidate.manifest as RunManifest);
  const report = sealed({ schemaVersion: 1, status: 'compatible-context', baselineBuildId: baseline.buildId, candidateBuildId: candidate.buildId,
    conclusion: 'performance-not-established' });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'compatible-context' };
}
