import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { CodexSessionAdapter } from '../src/review/adapters/codex.js';
import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from '../src/review/adapters/claude-code.js';
import { readCursorMarkdownExport } from '../src/review/adapters/cursor.js';
import { MAX_NORMALIZED_SESSION_EVENTS, MAX_SESSION_ARTIFACT_LINE_BYTES, MAX_SESSION_REVIEW_TEXT_LENGTH, type NormalizedSession } from '../src/review/contracts.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';

const TARGET_ARTIFACT_BYTES = Math.round(7.97 * 1024 * 1024);
const EVENT_COUNT = MAX_NORMALIZED_SESSION_EVENTS + 1;
const OCCURRED_AT = '2026-09-04T12:00:00.000Z';
const EVICTED_CREDENTIAL_MARKER = 'secret=evicted-credential-marker';
const RETAINED_CREDENTIAL_MARKER = 'secret=retained-credential-marker';

test('bounds and sanitizes deterministic 7.97 MiB artifacts from every supported source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-milestone-3-3-large-artifacts-'));
  try {
    const fixtures = createFixtures(root);

    for (const fixture of fixtures) {
      assert.equal(Buffer.byteLength(fixture.contents, 'utf8'), TARGET_ARTIFACT_BYTES);
      assert.equal(fixture.supportedEventCount > MAX_NORMALIZED_SESSION_EVENTS, true);
      const rssBefore = process.resourceUsage().maxRSS;
      const started = performance.now();
      const normalized = await fixture.read();
      const sanitized = sanitizeForReview(normalized);
      const durationMs = performance.now() - started;
      const rssDelta = process.resourceUsage().maxRSS - rssBefore;
      const retainedTextBytes = sessionTextBytes(normalized);
      const normalizedSerialized = JSON.stringify(normalized);
      const sanitizedSerialized = JSON.stringify(sanitized);

      assert.equal(normalized.events.length, MAX_NORMALIZED_SESSION_EVENTS);
      assert.equal(sanitized.session.events.length, MAX_NORMALIZED_SESSION_EVENTS);
      assert.equal(retainedTextBytes <= MAX_SESSION_REVIEW_TEXT_LENGTH, true);
      assert.equal(normalizedSerialized.includes(EVICTED_CREDENTIAL_MARKER), false);
      assert.equal(normalizedSerialized.includes(RETAINED_CREDENTIAL_MARKER), true);
      assert.equal(sanitizedSerialized.includes(RETAINED_CREDENTIAL_MARKER), false);
      assert.equal(sanitized.redactions.secret > 0, true);
      console.info(JSON.stringify({
        source: fixture.source,
        artifactBytes: TARGET_ARTIFACT_BYTES,
        retainedEventCount: normalized.events.length,
        retainedTextBytes,
        durationMs,
        rssDelta
      }));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly source: 'codex' | 'claude-code' | 'cursor';
  readonly contents: string;
  readonly supportedEventCount: number;
  readonly read: () => Promise<NormalizedSession>;
}

function createFixtures(root: string): readonly Fixture[] {
  const codexRoot = join(root, 'codex');
  mkdirSync(codexRoot);
  const codexContents = jsonlFixture('codex');
  writeFileSync(join(codexRoot, 'session.jsonl'), codexContents);

  const claudeConfig = join(root, 'claude');
  const claudeProject = 'workspace';
  const claudeRoot = join(claudeConfig, 'projects', claudeProject);
  mkdirSync(claudeRoot, { recursive: true });
  const claudeContents = jsonlFixture('claude-code');
  writeFileSync(join(claudeRoot, 'session.jsonl'), claudeContents);

  const cursorRoot = join(root, 'cursor');
  mkdirSync(cursorRoot);
  const cursorPath = join(cursorRoot, 'session.md');
  const cursorContents = markdownFixture();
  writeFileSync(cursorPath, cursorContents);

  return [
    { source: 'codex', contents: codexContents, supportedEventCount: jsonlEventCount(codexContents), read: () => new CodexSessionAdapter(codexRoot).read('session.jsonl') },
    {
      source: 'claude-code',
      contents: claudeContents,
      supportedEventCount: jsonlEventCount(claudeContents),
      read: async () => {
        const [artifact] = await discoverClaudeCodeArtifacts({ configDir: claudeConfig, project: claudeProject });
        return normalizeClaudeCodeArtifact(artifact!);
      }
    },
    {
      source: 'cursor',
      contents: cursorContents,
      supportedEventCount: (cursorContents.match(/^##\s+(?:User|Assistant)\s*$/gim) ?? []).length,
      read: () => readCursorMarkdownExport(
        { source: 'cursor', id: 'session', location: cursorPath, format: 'markdown-export' },
        cursorRoot,
        OCCURRED_AT
      )
    }
  ];
}

function jsonlFixture(source: 'codex' | 'claude-code'): string {
  const lines = Array.from({ length: EVENT_COUNT }, (_, index) => JSON.stringify(
    source === 'codex'
      ? { kind: 'message', occurredAt: OCCURRED_AT, text: eventText(index), padding: '' }
      : { type: 'message', timestamp: OCCURRED_AT, message: eventText(index), padding: '' }
  ));
  const bytesWithoutPadding = Buffer.byteLength(lines.join('\n'), 'utf8');
  addJsonPadding(lines, TARGET_ARTIFACT_BYTES - bytesWithoutPadding);
  const contents = lines.join('\n');
  assert.equal(Buffer.byteLength(contents, 'utf8'), TARGET_ARTIFACT_BYTES);
  return contents;
}

function jsonlEventCount(contents: string): number {
  return contents.split('\n').filter((line) => line.includes('"message"')).length;
}

function addJsonPadding(lines: string[], remaining: number): void {
  assert.ok(remaining >= 0);
  for (let index = 0; remaining > 0; index += 1) {
    const padding = Math.min(remaining, MAX_SESSION_ARTIFACT_LINE_BYTES - Buffer.byteLength(lines[index]!, 'utf8'));
    assert.ok(padding > 0);
    lines[index] = `${lines[index]!.slice(0, -2)}${'x'.repeat(padding)}"}`;
    remaining -= padding;
  }
}

function markdownFixture(): string {
  const messages = Array.from({ length: EVENT_COUNT }, (_, index) => `## ${index % 2 === 0 ? 'User' : 'Assistant'}\n${eventText(index)}`).join('\n');
  const padding = ignoredMarkdownPadding(TARGET_ARTIFACT_BYTES - Buffer.byteLength(messages, 'utf8'));
  const contents = `${padding}${messages}`;
  assert.equal(Buffer.byteLength(contents, 'utf8'), TARGET_ARTIFACT_BYTES);
  return contents;
}

function ignoredMarkdownPadding(bytes: number): string {
  assert.ok(bytes > 0);
  const parts: string[] = [];
  let remaining = bytes;
  while (remaining > MAX_SESSION_ARTIFACT_LINE_BYTES + 1) {
    parts.push(`${'x'.repeat(MAX_SESSION_ARTIFACT_LINE_BYTES)}\n`);
    remaining -= MAX_SESSION_ARTIFACT_LINE_BYTES + 1;
  }
  return `${parts.join('')}${'x'.repeat(remaining - 1)}\n`;
}

function eventText(index: number): string {
  if (index === 0) return EVICTED_CREDENTIAL_MARKER;
  if (index === EVENT_COUNT - 1) return RETAINED_CREDENTIAL_MARKER;
  return `message-${index}`;
}

function sessionTextBytes(session: NormalizedSession): number {
  return session.events.reduce((total, event) => total + Buffer.byteLength(event.text ?? '', 'utf8'), 0);
}
