import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runManualReview } from '../src/review/review-service.js';
import type { RunReviewInput } from '../src/review/runtime.js';

test('ACL-A6 keeps justified manual kinds and holds ambiguous legacy review outside the lesson enum', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-manual-kinds-'));
  try {
    writeFileSync(join(root, 'session.jsonl'), [
      { kind: 'tool', occurredAt: '2026-09-29T10:00:00.000Z', tool: 'shell', exitStatus: 1 },
      { kind: 'tool', occurredAt: '2026-09-29T10:00:01.000Z', tool: 'shell', exitStatus: 0 }
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const accepted: string[] = [];
    const result = await runManualReview({ source: 'codex', root, session: 'session.jsonl', allowExpensiveChecks: false }, {
      runtime: { async run({ artifact, profile }: RunReviewInput) {
        const [failed, passed] = artifact.session.events;
        return { profile, skippedReviewerIds: [], diagnostics: [], results: [{ reviewerId: 'typed-reviewer', findings: [
          { code: `failure-learning:${failed!.id}`, findingId: 'failure-1', rootCauseId: 'failure-root', recommendation: 'Inspect failed command' },
          { code: `project-fact:${passed!.id}`, findingId: 'fact-1', rootCauseId: 'fact-root', recommendation: 'Keep observed project fact' },
          { code: `legacy-ambiguous:${passed!.id}`, findingId: 'ambiguous-1', rootCauseId: 'ambiguous-root', recommendation: 'Review unclassified output' }
        ] }] };
      } },
      candidateSink(candidate: { kind: string }) { accepted.push(candidate.kind); }
    });
    assert.deepEqual(result.candidates.map(({ kind }) => kind).sort(), ['failure', 'project-fact']);
    assert.equal(result.reviewRequired.length, 1);
    assert.equal(result.reviewRequired[0]?.rootCauseId, 'ambiguous-root');
    assert.deepEqual(accepted.sort(), ['failure', 'project-fact']);
    assert.equal(JSON.stringify(result).includes('successful-workflow'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
