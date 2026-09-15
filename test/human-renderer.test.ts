import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHumanDocument, renderHumanError, type HumanDocument } from '../src/cli/human-renderer.js';

test('renders a deterministic plain document with aligned fields', () => {
  const document: HumanDocument = {
    title: 'AEL status',
    status: { tone: 'success', text: 'ready' },
    sections: [{
      heading: 'Installation',
      blocks: [{
        kind: 'fields',
        rows: [
          { label: 'CLI', value: 'available' },
          { label: 'Database', value: 'available' }
        ]
      }]
    }]
  };

  assert.equal(renderHumanDocument(document), [
    'AEL status  [ready]',
    '',
    'Installation',
    'CLI       available',
    'Database  available'
  ].join('\n'));
});

test('styles only trusted presentation labels and escapes control characters in values', () => {
  const output = renderHumanDocument({
    title: 'Runtime',
    status: { tone: 'warning', text: 'degraded' },
    sections: [{ blocks: [{ kind: 'fields', rows: [{ label: 'Value', value: '\u001b[31muntrusted' }] }] }]
  }, { color: true });

  assert.match(output, /\u001b\[1mRuntime\u001b\[0m/);
  assert.match(output, /\u001b\[33m\[degraded\]\u001b\[0m/);
  assert.match(output, /\\u001b\[31muntrusted/);
  assert.equal(output.includes('\u001b[31muntrusted'), false);
});

test('renders a table in wide output and stacks its rows in narrow output', () => {
  const document: HumanDocument = {
    title: 'Sessions',
    sections: [{
      blocks: [{
        kind: 'table',
        columns: ['ID', 'Source', 'State'],
        rows: [
          ['session-1', 'codex', 'complete'],
          ['session-2', 'cursor', 'open']
        ]
      }]
    }]
  };

  assert.equal(renderHumanDocument(document, { width: 100 }), [
    'Sessions',
    '',
    'ID         Source  State',
    '---------  ------  --------',
    'session-1  codex   complete',
    'session-2  cursor  open'
  ].join('\n'));
  assert.equal(renderHumanDocument(document, { width: 20 }), [
    'Sessions',
    '',
    'ID      session-1',
    'Source  codex',
    'State   complete',
    '',
    'ID      session-2',
    'Source  cursor',
    'State   open'
  ].join('\n'));
});

test('keeps an actionable empty state and renders structured errors', () => {
  assert.equal(renderHumanDocument({
    title: 'Knowledge',
    sections: [{ blocks: [{ kind: 'empty', value: 'No knowledge entries found. Run `ael review session` first.' }] }]
  }), 'Knowledge\n\nNo knowledge entries found. Run `ael review session` first.');

  assert.equal(renderHumanError(
    { code: 'CONTEXT_REQUIRED', message: 'A repository or workspace is required.' },
    'Run `ael init` or pass --repository-id.'
  ), [
    'Error',
    '',
    'Message    A repository or workspace is required.',
    'Code       CONTEXT_REQUIRED',
    'Next step  Run `ael init` or pass --repository-id.'
  ].join('\n'));
});
