import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionDebrief, type ReviewForDebrief } from '../src/review/debrief-model.js';
import { renderSessionDebrief } from '../src/review/debrief-renderer.js';
import { createDebriefState } from '../src/review/debrief-state.js';
import { runSessionDebrief } from '../src/review/debrief-terminal.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';
import { FakeDebriefTerminalHost } from './helpers/debrief-terminal.js';

const rawMarkers = [
  '/Users/private/secret-project',
  'password=hunter2',
  'sk-live-private-token',
  'RAW_PRIVATE_PROMPT',
  'RAW_ASSISTANT_RESPONSE',
  'RAW_TOOL_OUTPUT'
] as const;

test('renders and fails closed without exposing raw session material', async () => {
  const artifact = sanitizeForReview({
    source: 'codex',
    sessionId: 'private-session',
    repositoryHint: rawMarkers[0],
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:05:00.000Z',
    events: [
      { id: 'prompt', kind: 'message', occurredAt: '2026-09-01T10:01:00.000Z', outcome: 'unknown', text: `${rawMarkers[1]} ${rawMarkers[3]}` },
      { id: 'assistant', kind: 'message', occurredAt: '2026-09-01T10:02:00.000Z', outcome: 'unknown', text: `${rawMarkers[2]} ${rawMarkers[4]}` },
      { id: 'tool', kind: 'tool', tool: 'shell', occurredAt: '2026-09-01T10:03:00.000Z', outcome: 'failed', text: rawMarkers[5] }
    ]
  }, { configuredPatterns: rawMarkers.slice(3).map((marker) => new RegExp(marker, 'g')) });
  const [prompt, assistant, tool] = artifact.session.events;
  const review: ReviewForDebrief = {
    source: 'codex',
    findings: [],
    projectImprovements: [{
      id: 'project-improvement:developer-experience:sanitized-evidence',
      category: 'developer-experience',
      rootCauseId: 'sanitized-evidence',
      recommendation: 'Keep session evidence sanitized before rendering.',
      severity: 'high',
      findingIds: ['sanitized-evidence-finding'],
      evidenceEventIds: [prompt!.id, assistant!.id, tool!.id]
    }],
    projectReviewDiagnostics: [],
    serviceDiagnostics: [],
    runtimeDiagnostics: [],
    skippedReviewerIds: []
  };
  const model = buildSessionDebrief(artifact, review);
  const overview = renderSessionDebrief(model, createDebriefState(model.insights.length, 100, 30, false, 0));
  const detail = renderSessionDebrief(model, { ...createDebriefState(model.insights.length, 100, 30, false, 0), view: 'detail', evidenceExpanded: true });
  const failedFrame = new FakeDebriefTerminalHost({ failFrame: true });

  assert.deepEqual(await runSessionDebrief(model, failedFrame), { status: 'unavailable' });
  assert.equal(failedFrame.frames.length, 0);
  assert.equal(failedFrame.output.some((value) => rawMarkers.some((marker) => value.includes(marker))), false);

  for (const output of [JSON.stringify(model), overview, detail, ...failedFrame.output]) {
    for (const marker of rawMarkers) assert.equal(output.includes(marker), false, marker);
  }
});
