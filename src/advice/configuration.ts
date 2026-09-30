import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { containsCredentialMaterial } from '../privacy/structured-arguments.js';
import { openExperienceDatabase } from '../storage/database.js';

const migration = `CREATE TABLE IF NOT EXISTS advice_configuration (
  repository_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
) STRICT`;

export class AdvisoryConfigurationStore {
  constructor(readonly path: string) {}

  status(repositoryId: string): { readonly enabled: boolean } {
    validateRepositoryId(repositoryId);
    if (!existingRegularFile(this.path)) return Object.freeze({ enabled: false });
    const database = new DatabaseSync(this.path, { readOnly: true, timeout: 125 });
    try {
      const row = database.prepare('SELECT enabled FROM advice_configuration WHERE repository_id = ?').get(repositoryId) as { enabled: number } | undefined;
      return Object.freeze({ enabled: row?.enabled === 1 });
    } finally { database.close(); }
  }

  setEnabled(repositoryId: string, enabled: boolean): { readonly enabled: boolean } {
    validateRepositoryId(repositoryId);
    if (typeof enabled !== 'boolean') throw new TypeError('Advice enablement must be explicit.');
    existingRegularFile(this.path);
    const database = openExperienceDatabase(this.path, { timeoutMs: 125 });
    try {
      database.exec(migration);
      database.prepare(`INSERT INTO advice_configuration (repository_id, enabled) VALUES (?, ?)
        ON CONFLICT(repository_id) DO UPDATE SET enabled = excluded.enabled`).run(repositoryId, enabled ? 1 : 0);
      return Object.freeze({ enabled });
    } finally { database.close(); }
  }
}

function validateRepositoryId(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value) || containsCredentialMaterial(value)) {
    throw new TypeError('Advice repository ID is invalid.');
  }
}

function existingRegularFile(path: string): boolean {
  try {
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink()) throw new TypeError('Advice store must be a regular file.');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
