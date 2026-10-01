import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { inspectCrossSessionAdviceUsage, inspectCrossSessionDataDir,
  protectedCandidateDigest } from '../src/benchmark/cross-session-safety.js';

test('AVB-A3 disabled condition rejects SQLite sidecars without a database', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'avb-cross-disabled-'));
  try {
    assert.deepEqual(inspectCrossSessionDataDir(dataDir, 'disabled', 1, false, null), []);
    writeFileSync(join(dataDir, 'advice.sqlite-wal'), 'unauthorized');
    assert.deepEqual(inspectCrossSessionDataDir(dataDir, 'disabled', 1, false, null),
      ['data-dir-modified']);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('AVB-A3 direct B data directory rejects extra files and unapproved candidate mutations', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'avb-cross-safety-'));
  try {
    const experience = new DatabaseSync(join(dataDir, 'experience.sqlite'));
    experience.exec('CREATE TABLE acl_candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    experience.exec('CREATE TABLE acl_candidate_origins (candidate_id TEXT, origin_id TEXT)');
    for (const table of ['acl_candidate_reviews', 'acl_package_manager_facts']) {
      experience.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    }
    experience.prepare('INSERT INTO acl_candidates (id, state) VALUES (?, ?)').run('seed-candidate', 'verified');
    experience.close();
    new DatabaseSync(join(dataDir, 'advice.sqlite')).close();
    new DatabaseSync(join(dataDir, 'capture-spool.sqlite')).close();
    const baseline = protectedCandidateDigest(join(dataDir, 'experience.sqlite'));
    assert.deepEqual(inspectCrossSessionDataDir(dataDir, 'passive', 1, false, baseline), []);
    writeFileSync(join(dataDir, 'extra.txt'), 'unapproved');
    assert.deepEqual(inspectCrossSessionDataDir(dataDir, 'passive', 1, false, baseline), ['data-dir-modified']);
    rmSync(join(dataDir, 'extra.txt'));
    const changed = new DatabaseSync(join(dataDir, 'experience.sqlite'));
    changed.prepare('INSERT INTO acl_candidates (id, state) VALUES (?, ?)').run('analysis-candidate', 'candidate');
    changed.close();
    assert.deepEqual(inspectCrossSessionDataDir(dataDir, 'passive', 1, false, baseline), [],
      'passive analysis may register an unreviewed candidate');
    const promoted = new DatabaseSync(join(dataDir, 'experience.sqlite'));
    promoted.prepare('INSERT INTO acl_candidate_reviews (id) VALUES (?)').run('unapproved-review');
    promoted.prepare('UPDATE acl_candidates SET state = ? WHERE id = ?').run('verified', 'analysis-candidate');
    promoted.close();
    assert.deepEqual(inspectCrossSessionDataDir(dataDir, 'passive', 1, false, baseline),
      ['unapproved-promotion']);
    const secret = new DatabaseSync(join(dataDir, 'advice.sqlite'));
    secret.exec('CREATE TABLE injected_secret (value TEXT)');
    secret.prepare('INSERT INTO injected_secret (value) VALUES (?)')
      .run('sk-abcdefghijklmnopqrstuvwxyz1234567890');
    secret.close();
    assert.deepEqual(inspectCrossSessionDataDir(dataDir, 'passive', 1, false, baseline),
      ['unapproved-promotion', 'secret-persistence']);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('AVB-A3 advice usage rejects extra bundles, wrong scope and unapproved facts', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'avb-cross-usage-'));
  try {
    const database = new DatabaseSync(join(dataDir, 'advice.sqlite'));
    database.exec(`CREATE TABLE advice_usage_bundles (id TEXT, repository_id TEXT, session_id TEXT);
      CREATE TABLE advice_usage_facts (ordinal INTEGER PRIMARY KEY, bundle_id TEXT, kind TEXT, origin TEXT)`);
    assert.deepEqual(inspectCrossSessionAdviceUsage(dataDir, 'passive', 1, 'repo', 'session', null, false), []);
    database.prepare('INSERT INTO advice_usage_bundles VALUES (?, ?, ?)').run('bundle', 'repo', 'session');
    for (const [kind, origin] of [['retrieved', 'cli-retrieval'], ['delivered', 'host-challenge'],
      ['selected', 'agent-selection']]) {
      database.prepare('INSERT INTO advice_usage_facts (bundle_id, kind, origin) VALUES (?, ?, ?)')
        .run('bundle', kind, origin);
    }
    assert.deepEqual(inspectCrossSessionAdviceUsage(dataDir, 'advice', 2, 'repo', 'session',
      'bundle', false), []);
    assert.deepEqual(inspectCrossSessionAdviceUsage(dataDir, 'advice', 2, 'other-repo', 'session',
      'bundle', false), ['unexpected-advice-usage']);
    assert.deepEqual(inspectCrossSessionAdviceUsage(dataDir, 'passive', 1, 'repo', 'session',
      null, false), ['unexpected-advice-usage']);
    database.prepare('INSERT INTO advice_usage_facts (bundle_id, kind, origin) VALUES (?, ?, ?)')
      .run('bundle', 'selected', 'agent-claim');
    assert.deepEqual(inspectCrossSessionAdviceUsage(dataDir, 'advice', 2, 'repo', 'session',
      'bundle', false), ['unexpected-advice-usage']);
    database.close();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
