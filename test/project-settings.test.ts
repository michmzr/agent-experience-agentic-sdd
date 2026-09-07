import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadProjectSettings } from '../src/config/project-settings.js';

test('defaults and validates the project capture delivery deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-project-settings-'));
  try {
    assert.deepEqual(loadProjectSettings(root), { version: 1, captureDeliveryDeadlineMs: 2_000 });
    mkdirSync(join(root, '.ael'));
    writeFileSync(join(root, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":1500}\n');
    assert.deepEqual(loadProjectSettings(root), { version: 1, captureDeliveryDeadlineMs: 1_500 });
    writeFileSync(join(root, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":99}\n');
    assert.throws(() => loadProjectSettings(root), /deadline/i);
    writeFileSync(join(root, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":1500,"extra":true}\n');
    assert.throws(() => loadProjectSettings(root), /settings/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
