import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { CandidateIdentityInput } from './candidate-identity.js';
import type { CandidateReviewWitness } from './candidate-repository.js';

type Applicability = CandidateIdentityInput['applicability'];
const MAX_PACKAGE_BYTES = 64 * 1024;
const idPattern = /^[A-Za-z0-9._:@/-]{1,512}$/;
const managerPattern = /^(?:pnpm|npm|yarn|bun)@[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/;

interface FactRow {
  readonly evidence_id: string; readonly repository_id: string; readonly session_id: string;
  readonly relative_path: string; readonly scope: string; readonly scope_path: string | null;
  readonly package_manager: string; readonly file_digest: string; readonly root_digest: string;
}

export interface PackageManagerFact {
  readonly evidenceId: string;
  readonly factKey: string;
  readonly contextRevision: string;
  readonly applicability: Applicability;
}

/** Record only the bounded, allowlisted packageManager value and a digest of its Git-tracked source. */
export function recordPackageManagerFact(databasePath: string, repositoryId: string, sessionId: string,
  applicability: Applicability): PackageManagerFact {
  if (!idPattern.test(repositoryId) || !idPattern.test(sessionId)) throw new TypeError('Fact scope is invalid.');
  const relativePath = packagePath(applicability);
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    const registered = database.prepare(`SELECT r.repository_root FROM repositories r JOIN sessions s
      ON s.repository_id = r.repository_id WHERE r.repository_id = ? AND s.id = ?`)
      .get(repositoryId, sessionId) as { repository_root: string } | undefined;
    if (!registered) throw new Error('Fact source has no registered session and repository.');
    let rootDigest: string;
    try { rootDigest = sha256(realpathSync(registered.repository_root)); }
    catch { throw new Error('Fact source is unavailable or unsupported.'); }
    const observed = readPackageManager(registered.repository_root, relativePath);
    if (!observed) throw new Error('Fact source is unavailable or unsupported.');
    const evidenceId = `package-fact:v1:${sha256(JSON.stringify([repositoryId, sessionId, relativePath,
      rootDigest, observed.digest, observed.manager]))}`;
    database.exec(`CREATE TABLE IF NOT EXISTS acl_package_manager_facts (
      evidence_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL,
      relative_path TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('repository','subproject')),
      scope_path TEXT, package_manager TEXT NOT NULL, file_digest TEXT NOT NULL, root_digest TEXT NOT NULL
    ) STRICT`);
    database.prepare(`INSERT OR IGNORE INTO acl_package_manager_facts
      (evidence_id, repository_id, session_id, relative_path, scope, scope_path, package_manager, file_digest, root_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(evidenceId, repositoryId, sessionId, relativePath,
      applicability.scope, applicability.path ?? null, observed.manager, observed.digest, rootDigest);
    return Object.freeze({ evidenceId, factKey: `package-manager:${observed.manager}`,
      contextRevision: `package-json:v1:${observed.digest}`, applicability });
  } finally { database.close(); }
}

/** Read-only verification of the snapshot against the current registered Git file. */
export function resolvePackageManagerFact(database: DatabaseSync, repositoryId: string, sessionId: string,
  evidenceId: string): CandidateReviewWitness | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'acl_package_manager_facts'").get()) return undefined;
  const row = database.prepare(`SELECT f.* FROM acl_package_manager_facts f JOIN sessions s ON s.id = f.session_id
    WHERE f.evidence_id = ? AND f.repository_id = ? AND f.session_id = ? AND s.repository_id = ?`)
    .get(evidenceId, repositoryId, sessionId, repositoryId) as unknown as FactRow | undefined;
  if (!row || !managerPattern.test(row.package_manager) || !/^[a-f0-9]{64}$/.test(row.file_digest) ||
    !/^[a-f0-9]{64}$/.test(row.root_digest)) return undefined;
  const applicability: Applicability = row.scope === 'repository' && row.scope_path === null
    ? { scope: 'repository' } : row.scope === 'subproject' && row.scope_path
      ? { scope: 'subproject', path: row.scope_path } : { scope: 'repository', path: 'invalid' };
  let relativePath: string;
  try { relativePath = packagePath(applicability); } catch { return undefined; }
  if (relativePath !== row.relative_path) return undefined;
  const registered = database.prepare('SELECT repository_root FROM repositories WHERE repository_id = ?')
    .get(repositoryId) as { repository_root: string } | undefined;
  if (!registered) return undefined;
  let rootDigest: string;
  try { rootDigest = sha256(realpathSync(registered.repository_root)); } catch { return undefined; }
  if (rootDigest !== row.root_digest) return undefined;
  const current = readPackageManager(registered.repository_root, relativePath);
  if (!current || current.digest !== row.file_digest || current.manager !== row.package_manager) return undefined;
  const expectedId = `package-fact:v1:${sha256(JSON.stringify([repositoryId, sessionId, relativePath,
    row.root_digest, row.file_digest, row.package_manager]))}`;
  if (expectedId !== evidenceId) return undefined;
  return Object.freeze({ id: evidenceId, repositoryId, originId: sessionId, kind: 'deterministic-fact',
    factKey: `package-manager:${row.package_manager}`, contextRevision: `package-json:v1:${row.file_digest}`,
    applicability });
}

function packagePath(applicability: Applicability): string {
  if (applicability.scope === 'repository' && applicability.path === undefined &&
    (applicability.conditions?.length ?? 0) === 0) return 'package.json';
  if (applicability.scope !== 'subproject' || !applicability.path || (applicability.conditions?.length ?? 0) !== 0 ||
    !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(applicability.path) ||
    applicability.path.split('/').some((part) => part === '.' || part === '..')) throw new TypeError('Package fact scope is invalid.');
  return `${applicability.path}/package.json`;
}

function readPackageManager(root: string, relativePath: string): { manager: string; digest: string } | undefined {
  let fd: number | undefined;
  try {
    const actualRoot = realpathSync(root);
    const gitRoot = execFileSync('git', ['-C', actualRoot, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (realpathSync(gitRoot) !== actualRoot) return undefined;
    execFileSync('git', ['-C', actualRoot, 'ls-files', '--error-unmatch', '--', relativePath],
      { timeout: 1500, stdio: ['ignore', 'ignore', 'ignore'] });
    let current = actualRoot;
    for (const segment of relativePath.split('/')) {
      current = join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return undefined;
      if (current !== join(actualRoot, relativePath) && !stat.isDirectory()) return undefined;
    }
    fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) return undefined;
    const bytes = Buffer.alloc(MAX_PACKAGE_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size || length > MAX_PACKAGE_BYTES || lstatSync(current).isSymbolicLink()) return undefined;
    const digest = sha256(bytes.subarray(0, length));
    const parsed = JSON.parse(bytes.toString('utf8', 0, length)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const manager = (parsed as Record<string, unknown>).packageManager;
    return typeof manager === 'string' && managerPattern.test(manager) ? { manager, digest } : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
