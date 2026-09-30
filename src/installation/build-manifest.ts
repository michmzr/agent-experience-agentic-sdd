import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const MANIFEST_NAME = 'build-manifest.json';
export const CAPABILITIES = Object.freeze({ captureSchema: 1, resultSchema: 1, reader: 1, writer: 2 });
export interface BuildManifest {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly sourceRevision?: string;
  readonly buildId: string;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
  readonly capabilities: typeof CAPABILITIES;
}
export function sha256(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }
export function safeArtifact(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error('Invalid artifact path.');
  const target = resolve(root, path);
  const boundary = relative(realpathSync(root), realpathSync(target));
  if (boundary === '..' || boundary.startsWith('../') || isAbsolute(boundary)) throw new Error('Artifact symlink crosses installation boundary.');
  if (!lstatSync(target).isFile()) throw new Error('Artifact must be a regular file.');
  return target;
}
function artifactPaths(root: string): string[] {
  const paths: string[] = [];
  function walk(prefix: string): void {
    const directory = join(root, prefix);
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).sort()) {
      const path = `${prefix}/${name}`;
      const entry = lstatSync(join(root, path));
      if (entry.isSymbolicLink()) throw new Error('Symlink in shipped artifact tree.');
      if (entry.isDirectory()) walk(path);
      else if (prefix.startsWith('skills') || name.endsWith('.js')) paths.push(path);
    }
  }
  walk('dist/src'); walk('skills');
  return paths.sort();
}
export function createBuildManifest(root: string): BuildManifest {
  const artifacts = artifactPaths(root).map(path => ({ path, sha256: sha256(readFileSync(safeArtifact(root, path))) }));
  if (!artifacts.some(a => a.path === 'dist/src/cli.js')) throw new Error('Missing shipped CLI.');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return { schemaVersion: 1, packageVersion: version,
    ...(revision.status === 0 ? { sourceRevision: revision.stdout.trim() } : {}),
    buildId: sha256(JSON.stringify(artifacts)), artifacts, capabilities: CAPABILITIES };
}
export function validateManifest(value: unknown): BuildManifest {
  const m = value as BuildManifest;
  if (!m || m.schemaVersion !== 1 || typeof m.packageVersion !== 'string' || !/^[a-f0-9]{64}$/.test(m.buildId) || !Array.isArray(m.artifacts) || !m.artifacts.length) throw new Error('Invalid build manifest.');
  const paths = m.artifacts.map(a => a.path);
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw new Error('Duplicate or noncanonical artifact paths.');
  for (const a of m.artifacts) {
    if (typeof a.path !== 'string' || !/^(dist\/src\/.*\.js|skills\/.*)$/.test(a.path) || a.path.split('/').some((p: string) => !p || p === '..' || p === '.') || a.path.includes('\\') || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error('Invalid artifact entry.');
  }
  if (!paths.includes('dist/src/cli.js') || sha256(JSON.stringify(m.artifacts)) !== m.buildId) throw new Error('Build digest mismatch.');
  for (const key of Object.keys(CAPABILITIES) as (keyof typeof CAPABILITIES)[]) {
    if (!Number.isSafeInteger(m.capabilities?.[key]) || m.capabilities[key] < 1) throw new Error('Invalid build capabilities.');
  }
  return m;
}
export function readBuildManifest(root: string): BuildManifest { return validateManifest(JSON.parse(readFileSync(safeArtifact(root, MANIFEST_NAME), 'utf8'))); }
export function verifyBuild(root: string, manifest = readBuildManifest(root)): void {
  if (JSON.stringify(artifactPaths(root)) !== JSON.stringify(manifest.artifacts.map(a => a.path))) throw new Error('Modified shipped artifact set.');
  for (const artifact of manifest.artifacts) if (sha256(readFileSync(safeArtifact(root, artifact.path))) !== artifact.sha256) throw new Error('Modified shipped artifact.');
}
export function writerCompatible(manifest: BuildManifest, minimum: number): boolean { return manifest.capabilities.writer >= minimum && manifest.capabilities.writer === CAPABILITIES.writer; }
export const runningPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export function runningBuild(): BuildManifest | undefined {
  if (!existsSync(join(runningPackageRoot, MANIFEST_NAME))) return undefined;
  const manifest = readBuildManifest(runningPackageRoot);
  verifyBuild(runningPackageRoot, manifest);
  if (JSON.stringify(manifest.capabilities) !== JSON.stringify(CAPABILITIES)) throw new Error('Build capabilities differ from running writer.');
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? runningPackageRoot);
  writeFileSync(join(root, MANIFEST_NAME), JSON.stringify(createBuildManifest(root), null, 2) + '\n');
}
