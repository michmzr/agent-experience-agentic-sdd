import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export interface LocalRepository {
  readonly id: string;
  readonly root: string;
}

export function resolveRepository(directory: string): LocalRepository | undefined {
  try {
    const workingDirectory = realpathSync(directory);
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workingDirectory,
      encoding: 'utf8'
    });
    if (result.status !== 0) return undefined;
    const root = realpathSync(result.stdout.trim());
    return Object.freeze({ id: root, root });
  } catch {
    return undefined;
  }
}
