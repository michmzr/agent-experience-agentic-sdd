import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionDebrief } from '../src/review/debrief-model.js';
import { renderSessionDebrief, stripAnsi, visibleWidth } from '../src/review/debrief-renderer.js';
import { createDebriefState } from '../src/review/debrief-state.js';

const evidence = [
  { id: 'event-a', occurredAt: '2026-09-01T10:01:00.000Z', kind: 'tool' as const, outcome: 'failed' as const, tool: 'pnpm', summary: 'tool pnpm: failed' },
  { id: 'event-b', occurredAt: '2026-09-01T10:02:00.000Z', kind: 'tool' as const, outcome: 'passed' as const, tool: 'pnpm', summary: 'tool pnpm: passed' },
  { id: 'event-c', occurredAt: '2026-09-01T10:03:00.000Z', kind: 'message' as const, outcome: 'unknown' as const, summary: 'message event: unknown' },
  { id: 'event-d', occurredAt: '2026-09-01T10:04:00.000Z', kind: 'tool' as const, outcome: 'passed' as const, tool: 'git', summary: 'tool git: passed' }
];

const model: SessionDebrief = {
  source: 'codex', sessionPseudonym: '[REDACTED:opaque-id:session]',
  startedAt: '2026-09-01T10:00:00.000Z', endedAt: '2026-09-01T10:05:00.000Z', durationMs: 300_000, actionCount: 4,
  headline: 'Review completed with 1 evidence-backed improvements.', initialInsightIndex: 0,
  counts: { strengths: 1, improvements: 1, conflicts: 0, diagnostics: 0 },
  insights: [{
    id: 'project-improvement:architecture:terminal-boundary', kind: 'project-improvement', category: 'architecture', severity: 'high',
    title: 'terminal boundary', recommendation: 'Separate the terminal boundary.', evidence,
    timeline: [
      { kind: 'session-start', occurredAt: '2026-09-01T10:00:00.000Z' },
      ...evidence.slice(0, 3).map((item) => ({ kind: 'evidence' as const, occurredAt: item.occurredAt, evidence: item })),
      { kind: 'session-end', occurredAt: '2026-09-01T10:05:00.000Z' }
    ]
  }]
};

test('renders the insight card, compact timeline, counts, and key help', () => {
  const frame = renderSessionDebrief(model, createDebriefState(model.insights.length, 100, 30, true, 0));
  assert.match(stripAnsi(frame), /SESSION DEBRIEF/);
  assert.match(stripAnsi(frame), /Separate the terminal boundary/);
  assert.match(stripAnsi(frame), /Timeline/);
  assert.match(stripAnsi(frame), /Strengths 1/);
  assert.match(stripAnsi(frame), /Enter details/);
  assert.match(frame, /\u001b\[/);
});

test('uses compact monochrome layout and never exceeds the viewport', () => {
  const frame = renderSessionDebrief(model, createDebriefState(model.insights.length, 48, 16, false, 0));
  assert.doesNotMatch(frame, /\u001b\[/);
  for (const line of frame.split('\n')) assert.ok(visibleWidth(line) <= 48, line);
  assert.ok(frame.split('\n').length <= 16);
});

test('renders all linked sanitized evidence only when expanded in detail view', () => {
  const detail = { ...createDebriefState(model.insights.length, 100, 30, false, 0), view: 'detail' as const, evidenceExpanded: true };
  const frame = renderSessionDebrief(model, detail);
  assert.match(frame, /4 linked events/);
  assert.match(frame, /tool git: passed/);
});

test('renders an explicit empty state', () => {
  const frame = renderSessionDebrief({ ...model, insights: [], initialInsightIndex: null }, createDebriefState(0, 80, 24, false, null));
  assert.match(frame, /No corroborated insights/);
});

test('states when a legacy insight has no event timeline', () => {
  const legacy = { ...model, insights: [{ ...model.insights[0]!, kind: 'legacy-finding' as const, evidence: [], timeline: [] }] };
  assert.match(renderSessionDebrief(legacy, createDebriefState(1, 100, 30, false, 0)), /No event timeline is available/);
});

test('does not split graphemes when fitting a long recommendation', () => {
  const long = { ...model, insights: [{ ...model.insights[0]!, recommendation: '👩‍💻'.repeat(40) }] };
  const frame = renderSessionDebrief(long, createDebriefState(1, 9, 16, false, 0));
  for (const line of frame.split('\n')) assert.ok(visibleWidth(line) <= 9, line);
  assert.equal(frame.includes('\u200d'), frame.includes('👩‍💻'));
});

test('fits CJK and emoji glyphs to terminal display columns', () => {
  const wide = { ...model, insights: [{ ...model.insights[0]!, recommendation: '測試😀'.repeat(20) }] };
  const frame = renderSessionDebrief(wide, createDebriefState(1, 8, 16, false, 0));
  assert.equal(visibleWidth('測😀'), 4);
  for (const line of frame.split('\n')) assert.ok(visibleWidth(line) <= 8, `${visibleWidth(line)}: ${line}`);
});

test('defensively removes terminal control characters before rendering untrusted presentation fields', () => {
  const unsafe = {
    ...model,
    headline: 'Review\u001b]8;;https://example.test\u0007 completed',
    insights: [{ ...model.insights[0]!, title: 'Title\u001b[31m', recommendation: 'Keep\u001b]8;;https://example.test\u0007 this', evidence: [{ ...evidence[0]!, summary: 'tool git\u001b[2J: passed' }] }]
  };
  const detail = { ...createDebriefState(1, 100, 30, false, 0), view: 'detail' as const, evidenceExpanded: true };
  assert.doesNotMatch(renderSessionDebrief(unsafe, detail), /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});

test('keeps help as the final row in a short viewport', () => {
  const frame = renderSessionDebrief(model, createDebriefState(1, 48, 4, false, 0));
  const lines = frame.split('\n');
  assert.ok(lines.length <= 4);
  assert.match(lines.at(-1)!, /Enter|details|q quit/);
});
