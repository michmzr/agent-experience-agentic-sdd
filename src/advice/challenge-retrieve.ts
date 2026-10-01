import { randomBytes } from 'node:crypto';

import { runCli } from '../cli.js';
import { challengeAdviceResponse } from './exposure-challenge.js';
import { waitForAdviceContext } from './context-ready.js';

const [inputPath, dataDir] = process.argv.slice(2);
if (!inputPath || !dataDir || process.argv.length !== 4) {
  process.stdout.write(JSON.stringify({ error: { code: 'INVALID_SYNTAX', message: 'Expected context and data directory.' } }) + '\n');
  process.exitCode = 2;
} else {
  try {
    await waitForAdviceContext(inputPath);
    const result = runCli(['advice', 'retrieve', '--input', inputPath, '--data-dir', dataDir, '--json'],
      { workingDirectory: process.cwd() });
    const stdout = result.exitCode === 0
      ? challengeAdviceResponse(result.stdout, () => randomBytes(16).toString('hex')) : result.stdout;
    process.stdout.write(stdout);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Advice context is not ready.' } }) + '\n');
    process.exitCode = 1;
  }
}
