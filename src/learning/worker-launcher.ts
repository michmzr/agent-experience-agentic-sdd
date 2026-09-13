import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AnalysisWorkerLaunchRequest {
  readonly dataDirectory: string;
  readonly onFailure?: () => void;
}

export type AnalysisWorkerScheduler = (input: AnalysisWorkerLaunchRequest) => void;

interface DetachedAnalysisWorkerProcess {
  once(event: 'error', listener: (error: Error) => void): this;
  unref(): void;
}

export interface AnalysisWorkerLauncherDependencies {
  readonly spawn?: (executable: string, args: string[], options: { readonly detached: true; readonly stdio: 'ignore' }) => DetachedAnalysisWorkerProcess;
}

export function startAnalysisWorker(input: AnalysisWorkerLaunchRequest, dependencies: AnalysisWorkerLauncherDependencies = {}): void {
  let failureReported = false;
  const reportFailure = (): void => {
    if (failureReported) return;
    failureReported = true;
    input.onFailure?.();
  };
  try {
    const entrypoint = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    const spawnWorker = dependencies.spawn ?? spawn;
    const child = spawnWorker(process.execPath, [entrypoint, 'analysis', 'worker', '--data-dir', input.dataDirectory], {
      detached: true,
      stdio: 'ignore'
    });
    child.once('error', reportFailure);
    child.unref();
  } catch {
    reportFailure();
  }
}
