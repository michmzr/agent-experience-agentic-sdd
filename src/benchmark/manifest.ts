import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

interface ManifestBase {
  role: 'baseline' | 'candidate';
  label: string;
  buildId: string;
  corpusVersion: string;
  environment: { nodeMajor: number; platform: string; arch: string };
  budgets: { runMilliseconds: number };
  telemetry: { tokens: 'available' | 'unavailable'; wallTime: 'available' | 'unavailable' };
}

export type RunManifest = ManifestBase & (
  { schemaVersion: 1; scenarios: { id: 'codex-resume-matcher'; revision: 1; kind: 'synthetic' }[] }
  | { schemaVersion: 2; sourceVersions: { codexHook: 1; typedAnnotation: 1; aclReview: 'unsupported' }; seed: 1;
      scenarios: { id: 'resume' | 'unknown-result' | 'recovery' | 'scoped-convention' | 'typed-verification'; revision: 1; kind: 'pipeline' }[] }
);

const b1ScenarioIds = ['resume', 'unknown-result', 'recovery', 'scoped-convention', 'typed-verification'];

export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function buildIdentity(root: string): string {
  const files: { path: string; hash: string }[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(join(root, path)).sort()) {
      const child = `${path}/${name}`;
      const state = lstatSync(join(root, child));
      if (state.isSymbolicLink()) throw new Error('Shipped artifact symlink is unsupported.');
      if (state.isDirectory()) walk(child);
      else if (state.isFile() && (path.startsWith('skills') || name.endsWith('.js'))) files.push({ path: child, hash: digest(readFileSync(join(root, child))) });
    }
  };
  walk('dist/src');
  try { walk('skills'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!files.some(file => file.path === 'dist/src/cli.js')) throw new Error('Built CLI missing.');
  return digest(JSON.stringify(files.sort((a, b) => a.path.localeCompare(b.path))));
}

export function validateRunManifest(input: unknown, actualBuildId: string): RunManifest {
  const m = input as RunManifest;
  if (!exactKeys(m, m.schemaVersion === 2
    ? ['schemaVersion', 'role', 'label', 'buildId', 'corpusVersion', 'environment', 'budgets', 'telemetry', 'sourceVersions', 'seed', 'scenarios']
    : ['schemaVersion', 'role', 'label', 'buildId', 'corpusVersion', 'environment', 'budgets', 'telemetry', 'scenarios'])
    || !exactKeys(m.environment, ['nodeMajor', 'platform', 'arch']) || !exactKeys(m.budgets, ['runMilliseconds'])
    || !exactKeys(m.telemetry, ['tokens', 'wallTime']) || !Array.isArray(m.scenarios)
    || m.scenarios.some(s => !exactKeys(s, ['id', 'revision', 'kind']))
    || (m.schemaVersion !== 1 && m.schemaVersion !== 2) || !['baseline', 'candidate'].includes(m.role) || typeof m.label !== 'string' || !/^[a-z0-9-]{1,80}$/.test(m.label)
    || !/^[a-f0-9]{64}$/.test(m.buildId) || m.buildId !== actualBuildId || typeof m.corpusVersion !== 'string' || !/^[a-z0-9-]{1,80}$/.test(m.corpusVersion)
    || m.environment?.nodeMajor !== Number(process.versions.node.split('.')[0]) || m.environment.platform !== process.platform || m.environment.arch !== process.arch
    || !Number.isSafeInteger(m.budgets?.runMilliseconds) || m.budgets.runMilliseconds < 1 || m.budgets.runMilliseconds > 60000
    || m.telemetry?.tokens !== 'unavailable' || m.telemetry?.wallTime !== 'available'
    || (m.schemaVersion === 1
      ? m.scenarios.length !== 1 || m.scenarios[0]?.id !== 'codex-resume-matcher' || m.scenarios[0].revision !== 1 || m.scenarios[0].kind !== 'synthetic' || m.corpusVersion !== 'b0-1'
      : m.corpusVersion !== 'b1-1' || m.seed !== 1 || !exactKeys(m.sourceVersions, ['codexHook', 'typedAnnotation', 'aclReview'])
        || m.sourceVersions.codexHook !== 1 || m.sourceVersions.typedAnnotation !== 1 || m.sourceVersions.aclReview !== 'unsupported'
        || JSON.stringify(m.scenarios.map(s => s.id)) !== JSON.stringify(b1ScenarioIds)
        || m.scenarios.some(s => s.revision !== 1 || s.kind !== 'pipeline'))) {
    throw new Error('Invalid or substituted benchmark manifest.');
  }
  return m;
}

export function assertComparable(baseline: RunManifest, candidate: RunManifest): void {
  if (baseline.role !== 'baseline' || candidate.role !== 'candidate'
    || baseline.schemaVersion !== candidate.schemaVersion
    || baseline.corpusVersion !== candidate.corpusVersion
    || JSON.stringify(baseline.scenarios) !== JSON.stringify(candidate.scenarios)
    || JSON.stringify(baseline.environment) !== JSON.stringify(candidate.environment)
    || JSON.stringify(baseline.budgets) !== JSON.stringify(candidate.budgets)
    || JSON.stringify(baseline.telemetry) !== JSON.stringify(candidate.telemetry)
    || (baseline.schemaVersion === 2 && candidate.schemaVersion === 2 &&
      (JSON.stringify(baseline.sourceVersions) !== JSON.stringify(candidate.sourceVersions) || baseline.seed !== candidate.seed))) throw new Error('Incompatible benchmark contexts.');
}
