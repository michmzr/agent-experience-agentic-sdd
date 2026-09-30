import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

test('AVB-A6 maps every requirement to truthful test and run evidence', () => {
  const baseline = read('docs/product/ael-value-delivery-traceability.json');
  const manifest = read('docs/verification/2026-09-30-ael-requirement-traceability.json');
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.sourceIndex, 'docs/product/ael-value-delivery-traceability.json');
  assert.equal(manifest.requirements.length, 46);
  assert.deepEqual(manifest.requirements.map((entry: { requirement: string }) => entry.requirement),
    baseline.requirements.map((entry: { requirement: string }) => entry.requirement));
  assert.deepEqual(new Set(manifest.requirements.map((entry: { spec: string }) => entry.spec)),
    new Set(['ABI', 'AEC', 'ARC', 'ASC', 'ATI', 'ACL', 'AAP', 'AVB']));
  for (const entry of manifest.requirements) {
    const source = baseline.requirements.find((item: { requirement: string }) => item.requirement === entry.requirement);
    assert.equal(entry.acceptance, source.acceptance);
    assert.equal(entry.specPath, source.specPath);
    assert.equal(entry.planPath, source.planPath);
    assert.ok(existsSync(join(root, entry.specPath)));
    assert.ok(existsSync(join(root, entry.planPath)));
    assert.ok(['test-present', 'unsupported'].includes(entry.status), entry.acceptance);
    assert.ok(['not-run', 'historical-scoped'].includes(entry.run.status), entry.acceptance);
    assert.equal(entry.run.currentRevisionVerified, false, entry.acceptance);
    if (entry.testPath !== null) {
      assert.ok(entry.testPath && existsSync(join(root, entry.testPath)), entry.acceptance);
      assert.match(readFileSync(join(root, entry.testPath), 'utf8'), new RegExp(entry.acceptance), entry.acceptance);
      assert.equal(entry.testCommand, `rtk proxy node --test dist/${entry.testPath.replace(/\.ts$/, '.js')}`);
    } else {
      assert.equal(entry.status, 'unsupported', entry.acceptance);
      assert.equal(entry.testCommand, null, entry.acceptance);
    }
    if (entry.status === 'unsupported') {
      assert.ok(entry.reason?.length > 0, entry.acceptance);
    }
    if (entry.run.status === 'historical-scoped') {
      assert.ok(entry.run.artifactPath && existsSync(join(root, entry.run.artifactPath)), entry.acceptance);
      assert.match(readFileSync(join(root, entry.run.artifactPath), 'utf8'), new RegExp(entry.acceptance), entry.acceptance);
      assert.ok(entry.run.command?.startsWith('rtk '), entry.acceptance);
      assert.ok(readFileSync(join(root, entry.run.artifactPath), 'utf8').includes(entry.run.command), entry.acceptance);
    } else {
      assert.equal(entry.run.artifactPath, null, entry.acceptance);
      assert.equal(entry.run.command, null, entry.acceptance);
    }
  }
  for (const id of ['AEC-A1', 'AAP-A4', 'AAP-A5', 'AVB-A5']) {
    const entry = manifest.requirements.find((item: { acceptance: string }) => item.acceptance === id);
    assert.equal(entry.run.currentRevisionVerified, false);
    assert.notEqual(entry.run.status, 'passed');
  }
  assert.equal(manifest.hostQualification.status, 'unsupported');
  assert.equal(manifest.hostQualification.artifactPath, null);
  assert.equal(manifest.measuredImprovement.status, 'unsupported');
  assert.equal(manifest.measuredImprovement.artifactPath, null);
});
