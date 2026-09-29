import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readBuildManifest, runningBuild, verifyBuild } from './build-manifest.js';
import { configurationPath, managedEventSupported, renderManagedWrapper } from '../cli/hook-installation.js';
import { resolveRepository } from '../repository/local-repository.js';

export type InstallationState = 'current' | 'outdated' | 'missing' | 'modified' | 'unmanaged' | 'unknown';
export function resolveManagedTarget(root: string): { state: InstallationState; target?: string } {
  const path = join(root, '.agents/hooks/ael-passive-capture.sh');
  if (!existsSync(path)) return { state: 'missing' };
  const content = readFileSync(path, 'utf8');
  return parseManagedWrapper(root, content);
}
export function parseManagedWrapper(root: string, content: string): { state: InstallationState; target?: string } {
  const literal = /^cli="([^"$`\n]+)"$/m.exec(content)?.[1];
  const id = / --repository-id "([a-z0-9]+(?:-[a-z0-9]+)*)"/.exec(content)?.[1];
  if (literal && isAbsolute(literal) && content === renderManagedWrapper(literal, id)) return { state: 'current', target: literal };
  const target = join(root, 'dist/src/cli.js');
  const development = renderManagedWrapper(target).replace(`cli="${target}"`, 'repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0\ncli="$repository_root/dist/src/cli.js"');
  if (content === development) return { state: 'current', target };
  return { state: content.includes('cli=') ? 'unknown' : 'unmanaged' };
}
export function inspectHookContract(root: string, source: 'codex' | 'cursor'): InstallationState {
  const path = configurationPath(root, source);
  if (!existsSync(path)) return 'missing';
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const hooks = config.hooks;
    if (!hooks || typeof hooks !== 'object') return 'unmanaged';
    if (source === 'cursor') {
      const command = '.agents/hooks/ael-passive-capture.sh cursor';
      return ['sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse'].every(name => Array.isArray(hooks[name]) && hooks[name].some((h: { command?: string }) => h?.command === command)) ? 'current' : 'outdated';
    }
    const commands = [`"${join(root, '.agents/hooks/ael-passive-capture.sh')}" codex`, '"$(git rev-parse --show-toplevel)/.agents/hooks/ael-passive-capture.sh" codex'];
    return commands.some(command => managedEventSupported(hooks.SessionStart, command, 'startup') && managedEventSupported(hooks.SessionStart, command, 'resume') && ['SessionEnd', 'PreToolUse', 'PostToolUse'].every(name => managedEventSupported(hooks[name], command, name === 'SessionEnd' ? 'end' : 'Bash'))) ? 'current' : 'outdated';
  } catch { return 'unknown'; }
}
export function inspectInstallation(root: string, repositoryId?: string) {
  const wrapper = resolveManagedTarget(root);
  let status: InstallationState = wrapper.state;
  let buildId: string | undefined;
  if (wrapper.target) {
    if (!existsSync(wrapper.target)) status = 'missing';
    else {
      const packageRoot = resolve(dirname(wrapper.target), '../..');
      if (!existsSync(join(packageRoot, 'build-manifest.json'))) status = 'unknown';
      else try {
        const manifest = readBuildManifest(packageRoot);
        verifyBuild(packageRoot, manifest);
        buildId = manifest.buildId;
        status = runningBuild()?.buildId === buildId ? 'current' : 'outdated';
      } catch { status = 'modified'; }
    }
  }
  return { schemaVersion: 1, repositoryId: repositoryId ?? resolveRepository(root)?.id,
    artifact: { status, ...(buildId ? { buildId } : {}) }, hooks: { codex: inspectHookContract(root, 'codex'), cursor: inspectHookContract(root, 'cursor') }, qualification: 'unqualified' };
}

export function registeredInstallationRoots(databasePath: string, repositoryId?: string): readonly { id: string; root: string }[] {
  if (!existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repositories'").get()) return [];
    const rows = repositoryId === undefined
      ? database.prepare('SELECT repository_id AS id, repository_root AS root FROM repositories ORDER BY repository_id').all()
      : database.prepare('SELECT repository_id AS id, repository_root AS root FROM repositories WHERE repository_id = ?').all(repositoryId);
    return rows as { id: string; root: string }[];
  } finally { database.close(); }
}
