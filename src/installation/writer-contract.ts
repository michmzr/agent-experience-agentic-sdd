import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CAPABILITIES, type BuildManifest, writerCompatible } from './build-manifest.js';

export class IncompatibleWriterError extends Error {
  constructor() { super('INCOMPATIBLE_WRITER: Passive capture disabled for this artifact.'); }
}
export function minimumWriter(databasePath: string): number {
  if (!existsSync(databasePath)) return 1;
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 125 });
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ael_writer_contract'").get();
    if (!table) return 1;
    const row = database.prepare('SELECT minimum_writer FROM ael_writer_contract WHERE id = 1').get() as { minimum_writer?: number } | undefined;
    if (!Number.isSafeInteger(row?.minimum_writer) || row!.minimum_writer! < 1) throw new IncompatibleWriterError();
    return row!.minimum_writer!;
  } finally { database.close(); }
}
export function assertWriterCompatible(databasePaths: readonly string[], manifest?: BuildManifest): void {
  for (const path of databasePaths) {
    const minimum = minimumWriter(path);
    if (manifest ? !writerCompatible(manifest, minimum) : CAPABILITIES.writer < minimum) throw new IncompatibleWriterError();
  }
}
