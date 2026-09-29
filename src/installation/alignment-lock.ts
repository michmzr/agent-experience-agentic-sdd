import { chmodSync, existsSync, lstatSync, statSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const OWNED_LOCK_APPLICATION_ID = 0x41454c01;

/** A process-held SQLite write transaction releases its lock even after SIGKILL. */
export function acquireAlignmentLock(directory: string): () => void {
  const path = join(directory, 'lock.sqlite');
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('Invalid alignment lock path.');
  const existingBytes = existsSync(path) ? statSync(path).size : 0;
  const database = new DatabaseSync(path, { timeout: 0 });
  try {
    database.exec('BEGIN IMMEDIATE');
    const header = database.prepare('PRAGMA application_id').get() as { application_id: number };
    if (existingBytes > 0 && header.application_id !== OWNED_LOCK_APPLICATION_ID) throw new Error('Unrecognized alignment lock.');
    if (header.application_id === 0 && existingBytes === 0) {
      database.exec(`PRAGMA application_id = ${OWNED_LOCK_APPLICATION_ID}; COMMIT; BEGIN IMMEDIATE;`);
    } else if (header.application_id !== OWNED_LOCK_APPLICATION_ID) throw new Error('Unrecognized alignment lock.');
    chmodSync(path, 0o600);
    checkLegacyLock(directory);
  } catch (error) {
    database.close();
    if (error instanceof Error && /locked|busy/i.test(error.message)) throw new Error('Alignment is already running.');
    throw error;
  }
  return () => {
    try { database.exec('ROLLBACK'); }
    finally { database.close(); }
  };
}

function checkLegacyLock(directory: string): void {
  const path = join(directory, 'lock');
  if (!existsSync(path)) return;
  if (!lstatSync(path).isDirectory()) throw new Error('Unrecognized legacy alignment lock.');
  const entries = readdirSync(path);
  if (entries.length !== 1 || entries[0] !== 'owner.json' || !lstatSync(join(path, 'owner.json')).isFile()) throw new Error('Unrecognized legacy alignment lock.');
  const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.planId !== 'string' || !/^[a-f0-9]{64}$/.test(owner.planId)) throw new Error('Unrecognized legacy alignment lock.');
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { rmSync(path, { recursive: true }); return; }
    throw error;
  }
  throw new Error('Alignment is already running.');
}
