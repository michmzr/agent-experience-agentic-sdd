import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { AdvisoryUsageStore } from '../advice/usage.js';
import { runCli } from '../cli.js';
import { waitForHostDelivery } from './real-advice.js';

const [inputPath, dataDir] = process.argv.slice(2);
if (!inputPath || !dataDir || process.argv.length !== 4 || !isAbsolute(inputPath) || !isAbsolute(dataDir)) {
  process.stdout.write(JSON.stringify({ error: { code: 'INVALID_SYNTAX' } }) + '\n');
  process.exitCode = 2;
} else {
  try {
    if (inputPath !== join(dataDir, 'selection.json')) throw new TypeError('Selection path is invalid.');
    const state = lstatSync(inputPath);
    if (!state.isFile() || state.size > 4096) throw new TypeError('Selection input is invalid.');
    const input = JSON.parse(readFileSync(inputPath, 'utf8')) as { bundleId?: unknown };
    if (typeof input.bundleId !== 'string' || !/^advice-use:[a-f0-9]{64}$/.test(input.bundleId)) {
      throw new TypeError('Selection bundle is invalid.');
    }
    const usage = new AdvisoryUsageStore(join(dataDir, 'advice.sqlite'));
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const delivered = waitForHostDelivery(() => {
      try { return usage.facts(input.bundleId as string).some(fact => fact.kind === 'delivered'
        && fact.origin === 'host-challenge'); }
      catch { return false; }
    }, Date.now, milliseconds => { Atomics.wait(sleeper, 0, 0, milliseconds); });
    if (!delivered) throw new TypeError('Observed host delivery is unavailable.');
    const result = runCli(['advice', 'record', '--input', inputPath, '--data-dir', dataDir, '--json'],
      { workingDirectory: process.cwd() });
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(JSON.stringify({ error: { code: 'SELECTION_UNSUPPORTED' } }) + '\n');
    process.exitCode = 1;
  }
}
