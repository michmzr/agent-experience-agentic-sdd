import { findConfiguredWorkspaceRoot } from '../capture/diagnostic-scope.js';
import { resolveRepository } from '../repository/local-repository.js';

export interface CliContext {
  readonly scope: 'workspace' | 'repository';
  readonly id: string;
  readonly root: string;
}

export function resolveCliContext(directory: string): CliContext | undefined {
  const workspace = findConfiguredWorkspaceRoot(directory);
  if (workspace !== undefined) {
    return Object.freeze({ scope: 'workspace', id: workspace.id, root: workspace.root });
  }
  const repository = resolveRepository(directory);
  if (repository === undefined) return undefined;
  return Object.freeze({ scope: 'repository', id: repository.id, root: repository.root });
}
