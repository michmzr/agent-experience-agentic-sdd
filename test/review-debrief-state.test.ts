import assert from 'node:assert/strict';
import test from 'node:test';

import { createDebriefState, reduceDebriefState } from '../src/review/debrief-state.js';

test('wraps insight navigation and collapses expanded evidence on selection change', () => {
  const initial = { ...createDebriefState(3, 120, 32, true, 1), view: 'detail' as const, evidenceExpanded: true };
  const next = reduceDebriefState(initial, { type: 'next-insight' }, 3);
  assert.equal(next.selectedInsightIndex, 2);
  assert.equal(next.view, 'overview');
  assert.equal(next.evidenceExpanded, false);
  assert.equal(reduceDebriefState(next, { type: 'next-insight' }, 3).selectedInsightIndex, 0);
  assert.equal(reduceDebriefState(next, { type: 'previous-insight' }, 3).selectedInsightIndex, 1);
});

test('opens details, toggles evidence, and treats escape as back then exit', () => {
  const initial = createDebriefState(1, 100, 30, false, 0);
  const detail = reduceDebriefState(initial, { type: 'open-detail' }, 1);
  assert.equal(detail.view, 'detail');
  assert.equal(reduceDebriefState(detail, { type: 'toggle-evidence' }, 1).evidenceExpanded, true);
  const overview = reduceDebriefState(detail, { type: 'back' }, 1);
  assert.equal(overview.view, 'overview');
  assert.equal(reduceDebriefState(overview, { type: 'back' }, 1).exit, 'completed');
});

test('does not toggle evidence outside the detail view', () => {
  const overview = createDebriefState(1, 100, 30, false, 0);
  assert.equal(reduceDebriefState(overview, { type: 'toggle-evidence' }, 1), overview);
});

test('resizes, quits, interrupts, and remains safe with no insights', () => {
  const empty = createDebriefState(0, 0, -2, true, null);
  assert.equal(empty.selectedInsightIndex, null);
  assert.equal(empty.width, 1);
  assert.equal(empty.height, 1);
  assert.equal(reduceDebriefState(empty, { type: 'next-insight' }, 0).selectedInsightIndex, null);
  assert.deepEqual(reduceDebriefState(empty, { type: 'resize', width: 90, height: 25 }, 0), { ...empty, width: 90, height: 25 });
  assert.equal(reduceDebriefState(empty, { type: 'quit' }, 0).exit, 'completed');
  assert.equal(reduceDebriefState(empty, { type: 'interrupt' }, 0).exit, 'interrupted');
});

test('ignores actions after exit other than a clamped resize', () => {
  const completed = reduceDebriefState(createDebriefState(1, 80, 24, false, 0), { type: 'quit' }, 1);
  assert.equal(reduceDebriefState(completed, { type: 'open-detail' }, 1), completed);
  assert.deepEqual(reduceDebriefState(completed, { type: 'resize', width: 0, height: 0 }, 1), { ...completed, width: 1, height: 1 });
});
