import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AnalysisWorkerLaunchRequest {
  readonly dataDirectory: string;
  readonly onFailure?: () => void;
}

export type AnalysisWorkerScheduler = (input: AnalysisWorkerLaunchRequest) => void;

export function startAnalysisWorker(input: AnalysisWorkerLaunchRequest): void {
  try {
    const entrypoint = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    spawn(process.execPath, [entrypoint, 'analysis', 'worker', '--data-dir', input.dataDirectory], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  } catch {
    input.onFailure?.();
  }
}
