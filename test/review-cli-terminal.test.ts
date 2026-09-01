import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { FakeDebriefTerminalHost } from './helpers/debrief-terminal.js';
import { initializeGitRepository } from './helpers/git-repository.js';

test('uses the injected terminal host to select and explicitly confirm an interactive latest review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-terminal-'));
  initializeGitRepository(root);
  writeFileSync(join(root, 'latest.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  const output: string[] = [];
  const answers = ['yes'];

  const result = await runCliAsync(
    ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', root, '--session', 'latest', '--json'],
    {
      terminal: {
        write(value) { output.push(value); },
        async readLine(prompt) { output.push(prompt); return answers.shift() ?? ''; }
      }
    }
  );

  assert.equal(result.exitCode, 0);
  assert.match(output.join(''), /Run review for latest\.jsonl\?/);
});

test('launches the debrief after an interactive non-JSON review and leaves no static output', async () => {
  const { root, terminal } = interactiveReviewFixture();
  const debriefTerminal = new FakeDebriefTerminalHost();
  const review = runCliAsync(reviewArgs(root), { terminal, debriefTerminal });

  await waitFor(() => debriefTerminal.enterCalls === 1);
  debriefTerminal.key({ name: 'q', ctrl: false });

  assert.deepEqual(await review, { exitCode: 0, stdout: '', stderr: '' });
  assert.equal(debriefTerminal.enterCalls, 1);
  assert.equal(debriefTerminal.leaveCalls, 1);
});

test('does not launch the debrief for interactive JSON and preserves the JSON response', async () => {
  const { root, terminal } = interactiveReviewFixture();
  const debriefTerminal = new FakeDebriefTerminalHost();

  const result = await runCliAsync([...reviewArgs(root), '--json'], { terminal, debriefTerminal });

  assert.equal(result.exitCode, 0);
  assert.equal(debriefTerminal.enterCalls, 0);
  assert.equal('debrief' in JSON.parse(result.stdout), false);
  assert.equal(result.stderr, '');
});

test('uses the existing text response when the injected debrief terminal is not interactive', async () => {
  const { root, terminal } = interactiveReviewFixture();
  const debriefTerminal = new FakeDebriefTerminalHost({ interactive: false });

  const result = await runCliAsync(reviewArgs(root), { terminal, debriefTerminal });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Review completed:/);
  assert.equal(result.stderr, '');
  assert.equal(debriefTerminal.enterCalls, 0);
});

test('falls back to static text with the generic diagnostic when the debrief frame fails', async () => {
  const { root, terminal } = interactiveReviewFixture();
  const debriefTerminal = new FakeDebriefTerminalHost({ failFrame: true });

  const result = await runCliAsync(reviewArgs(root), { terminal, debriefTerminal });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Review completed:/);
  assert.equal(result.stderr, 'REVIEW_TUI_UNAVAILABLE: Interactive debrief unavailable; printed text fallback.\n');
});

test('returns the interrupt exit result when Ctrl+C closes the debrief', async () => {
  const { root, terminal } = interactiveReviewFixture();
  const debriefTerminal = new FakeDebriefTerminalHost();
  const review = runCliAsync(reviewArgs(root), { terminal, debriefTerminal });

  await waitFor(() => debriefTerminal.enterCalls === 1);
  debriefTerminal.key({ name: 'c', ctrl: true });

  assert.deepEqual(await review, { exitCode: 130, stdout: '', stderr: '' });
});

test('does not create a debrief terminal for review discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-discovery-terminal-'));
  writeFileSync(join(root, 'session.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  const debriefTerminal = new FakeDebriefTerminalHost();

  const result = await runCliAsync(['review', 'sessions', '--source', 'codex', '--root', root], { debriefTerminal });

  assert.equal(result.exitCode, 0);
  assert.equal(debriefTerminal.enterCalls, 0);
  assert.equal(debriefTerminal.subscribeCalls, 0);
});

function interactiveReviewFixture(): { root: string; terminal: { write(value: string): void; readLine(prompt: string): Promise<string>; } } {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-debrief-cli-'));
  initializeGitRepository(root);
  writeFileSync(join(root, 'latest.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  return {
    root,
    terminal: { write() {}, async readLine() { return 'yes'; } }
  };
}

function reviewArgs(root: string): string[] {
  return ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', root, '--session', 'latest'];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(predicate(), true, 'debrief terminal should start');
}
