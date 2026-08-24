import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DIRECTORY_MODE = 0o700;
const DATABASE_TIMEOUT_MS = 5_000;

export function resolvePrivateDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.AEL_DATA_DIR) return environment.AEL_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'AgentExperience');

  return join(environment.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'agent-experience');
}

export function defaultDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePrivateDataDirectory(environment), 'experience.sqlite');
}

export function openExperienceDatabase(databasePath = defaultDatabasePath()): DatabaseSync {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(directory, DIRECTORY_MODE);

  return new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: DATABASE_TIMEOUT_MS
  });
}
