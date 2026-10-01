import { lstatSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/** The host publishes this file by atomic rename after observing thread.started. */
export async function waitForAdviceContext(path: string, timeoutMs = 10_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000) {
    throw new TypeError('Invalid advice context wait deadline.');
  }
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new TypeError('Advice context must be a regular file.');
      if (stat.size > 16 * 1024) throw new TypeError('Advice context exceeds size limit.');
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (performance.now() >= deadline) throw new Error('Advice context publication timed out.');
    await delay(Math.min(40, Math.max(1, deadline - performance.now())));
  }
}
