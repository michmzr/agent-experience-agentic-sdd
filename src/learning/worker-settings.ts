import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_PROCESSES = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const MIN_MAX_PROCESSES = 1;
const MAX_MAX_PROCESSES = 16;
const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 3_600_000;

export interface AnalysisWorkerSettings {
  readonly version: 1;
  readonly maxProcesses: number;
  readonly idleTimeoutMs: number;
}

export function loadAnalysisWorkerSettings(dataDirectory: string): AnalysisWorkerSettings {
  const path = join(dataDirectory, 'analysis-worker.json');
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return defaults();
    if (code === 'ELOOP') throw new TypeError('Analysis worker settings must be a regular file.');
    throw new TypeError('Analysis worker settings are invalid.');
  }
  try {
    if (!fstatSync(fileDescriptor).isFile()) throw new TypeError('Analysis worker settings must be a regular file.');
    let value: unknown;
    try { value = JSON.parse(readFileSync(fileDescriptor, 'utf8')) as unknown; }
    catch { throw new TypeError('Analysis worker settings are invalid.'); }
    return validate(value);
  } finally {
    closeSync(fileDescriptor);
  }
}

function validate(value: unknown): AnalysisWorkerSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Analysis worker settings are invalid.');

  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'idleTimeoutMs,maxProcesses,version' || record.version !== 1) {
    throw new TypeError('Analysis worker settings are invalid.');
  }
  if (!Number.isSafeInteger(record.maxProcesses)) throw new TypeError('Analysis worker settings are invalid.');
  if ((record.maxProcesses as number) < MIN_MAX_PROCESSES || (record.maxProcesses as number) > MAX_MAX_PROCESSES) {
    throw new TypeError('Max processes must be between 1 and 16.');
  }
  if (!Number.isSafeInteger(record.idleTimeoutMs)) throw new TypeError('Analysis worker settings are invalid.');
  if ((record.idleTimeoutMs as number) < MIN_IDLE_TIMEOUT_MS || (record.idleTimeoutMs as number) > MAX_IDLE_TIMEOUT_MS) {
    throw new TypeError('Idle timeout must be between 1000 and 3600000 milliseconds.');
  }
  return Object.freeze({ version: 1, maxProcesses: record.maxProcesses as number, idleTimeoutMs: record.idleTimeoutMs as number });
}

function defaults(): AnalysisWorkerSettings {
  return Object.freeze({ version: 1, maxProcesses: DEFAULT_MAX_PROCESSES, idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS });
}
