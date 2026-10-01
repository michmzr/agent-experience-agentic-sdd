import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Best-effort wake-up after a durable capture admission. */
export function startCaptureDrain(dataDirectory: string): void {
  try {
    const entrypoint = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    spawn(process.execPath, [entrypoint, 'capture', 'drain', '--data-dir', dataDirectory], {
      detached: true, stdio: 'ignore'
    }).unref();
  } catch {
    // The admitted record remains durable for an explicit drain or later wake-up.
  }
}
