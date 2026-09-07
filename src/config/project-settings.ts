import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CAPTURE_DELIVERY_DEADLINE_MS = 2_000;
const MIN_CAPTURE_DELIVERY_DEADLINE_MS = 100;
const MAX_CAPTURE_DELIVERY_DEADLINE_MS = 60_000;

export interface ProjectSettings {
  readonly version: 1;
  readonly captureDeliveryDeadlineMs: number;
}

export function loadProjectSettings(projectRoot: string): ProjectSettings {
  const path = join(projectRoot, '.ael', 'settings.json');
  if (!existsSync(path)) return defaults();
  if (lstatSync(path).isSymbolicLink()) throw new TypeError('Project settings must be a regular file.');
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch { throw new TypeError('Project settings are invalid.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Project settings are invalid.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'captureDeliveryDeadlineMs,version' || record.version !== 1) {
    throw new TypeError('Project settings are invalid.');
  }
  const deadline = record.captureDeliveryDeadlineMs;
  if (!Number.isSafeInteger(deadline) || (deadline as number) < MIN_CAPTURE_DELIVERY_DEADLINE_MS || (deadline as number) > MAX_CAPTURE_DELIVERY_DEADLINE_MS) {
    throw new TypeError('Capture delivery deadline must be between 100 and 60000 milliseconds.');
  }
  return Object.freeze({ version: 1, captureDeliveryDeadlineMs: deadline as number });
}

function defaults(): ProjectSettings {
  return Object.freeze({ version: 1, captureDeliveryDeadlineMs: DEFAULT_CAPTURE_DELIVERY_DEADLINE_MS });
}
