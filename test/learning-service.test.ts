import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OperationalLearningService } from '../src/learning/service.js';

test('returns false when no committed analysis job is pending', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-service-'));
  const service = new OperationalLearningService(join(dataDir, 'experience.sqlite'));
  assert.deepEqual(service.runNext(), { status: 'idle' });
});
