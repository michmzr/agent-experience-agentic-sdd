import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';

test('uses the injected terminal host to select and explicitly confirm an interactive latest review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-terminal-'));
  writeFileSync(join(root, 'latest.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  const output: string[] = [];
  const answers = ['yes'];

  const result = await runCliAsync(
    ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', 'repo-current', '--session', 'latest', '--json'],
    {
      terminal: {
        write(value) { output.push(value); },
        async readLine(prompt) { output.push(prompt); return answers.shift() ?? ''; }
      },
      reviewDependencies: {
        discover: async () => [{ source: 'codex', id: 'latest.jsonl', location: join(root, 'latest.jsonl'), repositoryHint: 'repo-current', repositoryHintVerified: true, updatedAt: '2026-08-24T10:00:00.000Z' }]
      }
    }
  );

  assert.equal(result.exitCode, 0);
  assert.match(output.join(''), /Run review for latest\.jsonl\?/);
});
