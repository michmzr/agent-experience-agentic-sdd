import assert from 'node:assert/strict';
import test from 'node:test';

import { selectLocalAdvice, type VerifiedAdviceEntry } from '../src/advice/selection.js';

const entry: VerifiedAdviceEntry = {
  candidateId: 'candidate-1', revision: 'rev-1', repositoryId: 'repo-a',
  kind: 'convention', statement: 'Use the repository search command before changing a module.',
  applicability: { scope: 'subproject', path: 'package-a', conditions: ['task:change'] },
  operationSignature: 'tool:search', contextRevision: 'context-1', evidenceRefs: ['evidence-1'],
  contradictionState: 'clear', state: 'verified'
};
const context = {
  repositoryId: 'repo-a', subproject: 'package-a', operationSignature: 'tool:search',
  contextRevision: 'context-1', conditions: ['task:change']
};

test('AAP-A2 exact scope, lifecycle, freshness and bounded selection suppress ineligible advice', () => {
  assert.equal(selectLocalAdvice([entry], context).entries.length, 1);
  for (const changed of [
    { ...entry, repositoryId: 'repo-b' },
    { ...entry, applicability: { ...entry.applicability, path: 'package-b' } },
    { ...entry, contextRevision: 'context-0' },
    { ...entry, operationSignature: 'tool:write' },
    { ...entry, contradictionState: 'disputed' as const },
    { ...entry, state: 'observed' as const }
  ]) assert.equal(selectLocalAdvice([changed], context).entries.length, 0);
  assert.equal(selectLocalAdvice([{ ...entry, statement: 'x'.repeat(4096) }], context).entries.length, 0);
  const many = Array.from({ length: 5 }, (_, index) => ({ ...entry, candidateId: `candidate-${index}` }));
  assert.equal(selectLocalAdvice(many, context).entries.length, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(selectLocalAdvice(many, context).entries), 'utf8') <= 4096);
  assert.equal(selectLocalAdvice(many, context, { deadline: 0, now: () => 1 }).status, 'unavailable');
});
