import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { ingestPassiveHook } from '../src/capture/hook-ingress.js';
import { CaptureSpool } from '../src/capture/spool.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { initializeGitRepository } from './helpers/git-repository.js';

const at = '2026-09-30T10:00:00.000Z';

test('ARC-A4 public health v3 scopes retained operations across repositories and restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a4-public-'));
  const dataDir = join(root, 'data');
  const repoA = join(root, 'repo-a'); const repoB = join(root, 'repo-b');
  mkdirSync(dataDir); mkdirSync(repoA); mkdirSync(repoB);
  initializeGitRepository(repoA); initializeGitRepository(repoB);
  const idA = resolveRepository(repoA)!.id; const idB = resolveRepository(repoB)!.id;
  const databasePath = join(dataDir, 'experience.sqlite');
  const ingest = (workingDirectory: string, input: string, repositoryId?: string) => ingestPassiveHook({
    source: 'codex', input, databasePath, workingDirectory, now: () => at, scheduleDrain: () => {},
    ...(repositoryId === undefined ? {} : { repositoryId: repositoryId as never })
  });
  try {
    const startA = JSON.stringify({ session_id: 'arc-a4-a', hook_event_name: 'SessionStart', source: 'startup' });
    const startB = JSON.stringify({ session_id: 'arc-a4-b', hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(ingest(repoA, startA).status, 'captured');
    assert.equal(ingest(repoB, startB).status, 'captured');
    const technical = JSON.stringify({ session_id: 'arc-a4-a', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'arc-a4-tool', tool_input: { command: 'pwd' } });
    assert.equal(ingest(repoA, technical).status, 'captured');
    assert.equal(ingest(repoA, technical).status, 'duplicate');
    assert.equal(ingest(repoB, technical).status, 'duplicate');
    const conflict = JSON.stringify({ session_id: 'arc-a4-conflict', hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(ingest(repoA, conflict, idB).status, 'captured');

    const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
    try {
      const receipts = spool.receiptReport().receipts as unknown as readonly { readonly eventClass?: string; readonly repositoryId?: string; readonly operationKey?: string }[];
      const technicalReceipts = receipts.filter(receipt => receipt.eventClass === 'technical');
      assert.equal(technicalReceipts.length, 3);
      assert.deepEqual(technicalReceipts.map(receipt => receipt.repositoryId), [idA, idA, idA]);
      assert.equal(new Set(technicalReceipts.map(receipt => receipt.operationKey)).size, 1);
      assert.equal(receipts.filter(receipt => receipt.repositoryId === idB).length, 1);
      assert.equal(receipts.filter(receipt => receipt.repositoryId === undefined).length, 1);
    } finally { spool.close(); }

    const status = (id: string) => {
      const result = runCli(['status', '--data-dir', dataDir, '--repository-id', id, '--schema-version', '3', '--json']);
      assert.equal(result.exitCode, 1);
      return JSON.parse(result.stdout) as { schemaVersion: number; receipts: { deliveries: number; uniqueOperations: number; sourceDenominator: { state: string }; retention: { capacity: number } } };
    };
    const legacyCommands = [
      ['status', '--data-dir', dataDir, '--repository-id', idA, '--json'],
      ['status', '--data-dir', dataDir, '--repository-id', idA, '--schema-version', '2', '--json'],
      ['status-global', '--data-dir', dataDir, '--json'],
      ['status-global', '--data-dir', dataDir, '--schema-version', '2', '--json'],
      ['analysis', 'report', '--data-dir', dataDir, '--repository-id', idA, '--json'],
      ['analysis', 'report', '--data-dir', dataDir, '--repository-id', idA, '--schema-version', '2', '--json']
    ];
    runCli(legacyCommands[4]!, { workingDirectory: repoA });
    const beforeV3 = legacyCommands.map(args => runCli(args, { workingDirectory: repoA }).stdout);
    const a = status(idA); const b = status(idB);
    assert.equal(a.schemaVersion, 3);
    assert.equal(a.receipts.deliveries, 4);
    assert.equal(a.receipts.uniqueOperations, 2);
    assert.deepEqual(a.receipts.sourceDenominator, { state: 'unavailable' });
    assert.equal(a.receipts.retention.capacity, 10000);
    assert.equal(b.receipts.deliveries, 1);
    assert.equal(b.receipts.uniqueOperations, 1);
    const global = runCli(['status-global', '--data-dir', dataDir, '--schema-version', '3', '--json']);
    assert.equal(JSON.parse(global.stdout).schemaVersion, 3);
    const analysis = runCli(['analysis', 'report', '--data-dir', dataDir, '--repository-id', idA, '--schema-version', '3', '--json']);
    assert.equal(JSON.parse(analysis.stdout).schemaVersion, 3);
    assert.deepEqual(legacyCommands.map(args => runCli(args, { workingDirectory: repoA }).stdout), beforeV3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A4 keeps historical receipt scope unknown and attributes retry from first admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a4-migration-'));
  const path = join(root, 'capture-spool.sqlite');
  const initial = new CaptureSpool(path);
  initial.close();
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`DROP TABLE capture_receipts;
      CREATE TABLE capture_receipts (sequence INTEGER PRIMARY KEY, correlation_key TEXT NOT NULL, operation_key TEXT,
      disposition TEXT NOT NULL, received_at TEXT NOT NULL, build_role TEXT, build_id TEXT, writer INTEGER) STRICT`);
    legacy.prepare("INSERT INTO capture_receipts (correlation_key, operation_key, disposition, received_at, build_role) VALUES (?, ?, 'accepted', ?, 'unknown')")
      .run('a'.repeat(64), 'b'.repeat(64), at);
  } finally { legacy.close(); }
  const spool = new CaptureSpool(path);
  try {
    const old = spool.receiptReport().receipts[0]!;
    assert.equal(old.repositoryId, undefined);
    assert.equal(old.source, undefined);
    assert.equal(old.eventClass, undefined);
    const record = { kind: 'session-start' as const, session: { id: 'arc-a4-retry' as never, source: 'codex' as const, startedAt: at } };
    assert.throws(() => spool.admitWithReceipt(record, { source: 'codex', repositoryId: '/private/credentials', receivedAt: at }), /repository ID/i);
    assert.equal(spool.status().admitted, 0);
    assert.equal(spool.receiptReport().receipts.length, 1);
    const admission = spool.admitWithReceipt(record, { source: 'codex', repositoryId: 'repo-canonical', receivedAt: at, correlationInput: 'private-command --token=opaque' });
    spool.claim(at, 1);
    spool.retry(admission.deliveryId, '2026-09-30T10:00:01.000Z');
    const receipts = spool.receiptReport().receipts;
    assert.deepEqual(receipts.slice(1).map(receipt => receipt.repositoryId), ['repo-canonical', 'repo-canonical']);
    assert.deepEqual(receipts.slice(1).map(receipt => receipt.eventClass), ['session-start', 'session-start']);
    assert.deepEqual(receipts.slice(1).map(receipt => receipt.source), ['codex', 'codex']);
    assert.equal(JSON.stringify(receipts).includes('private-command'), false);
    spool.claim('2026-09-30T10:00:02.000Z', 1);
    spool.acknowledge(admission.deliveryId, '2026-09-30T10:00:03.000Z');
    assert.equal(spool.admitWithReceipt(record, { source: 'codex', repositoryId: 'repo-other', receivedAt: '2026-09-30T10:00:04.000Z' }).status, 'duplicate');
    assert.equal(spool.receiptReport().receipts.at(-1)!.repositoryId, 'repo-canonical');
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A4 does not attribute a session when direct metadata conflicts with receipt scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a4-conflict-'));
  const spool = new CaptureSpool(join(root, 'capture-spool.sqlite'));
  try {
    spool.admitWithReceipt({ kind: 'session-start', session: { id: 'scope-conflict' as never, source: 'codex', startedAt: at,
      repositoryId: 'repo-record' as never } }, { source: 'codex', repositoryId: 'repo-receipt', receivedAt: at });
    assert.equal(spool.receiptReport().receipts[0]!.repositoryId, undefined);
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A4 concurrent cold scope migration preserves historical unknown receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a4-cold-'));
  const path = join(root, 'capture-spool.sqlite');
  const setup = new CaptureSpool(path); setup.close();
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`DROP TABLE capture_receipts;
      CREATE TABLE capture_receipts (sequence INTEGER PRIMARY KEY, correlation_key TEXT NOT NULL, operation_key TEXT,
      disposition TEXT NOT NULL, received_at TEXT NOT NULL, build_role TEXT, build_id TEXT, writer INTEGER) STRICT`);
    legacy.prepare("INSERT INTO capture_receipts (correlation_key, disposition, received_at) VALUES (?, 'accepted', ?)").run('a'.repeat(64), at);
  } finally { legacy.close(); }
  const script = `import {CaptureSpool} from '${join(process.cwd(), 'dist/src/capture/spool.js')}'; const spool = new CaptureSpool(process.argv[1]); spool.close();`;
  try {
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'ignore', 'pipe'] }));
    const exits = await Promise.all(children.map(async child => {
      let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
      const [code] = await once(child, 'exit'); return { code, stderr };
    }));
    assert.deepEqual(exits, [{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    const migrated = new CaptureSpool(path);
    try {
      assert.equal(migrated.receiptReport().receipts.length, 1);
      assert.equal(migrated.receiptReport().receipts[0]!.repositoryId, undefined);
      assert.equal(migrated.receiptReport().receipts[0]!.source, undefined);
      assert.equal(migrated.receiptReport().receipts[0]!.eventClass, undefined);
    } finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A4 scoped receipt report exposes a bounded retained sequence window', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a4-window-'));
  const spool = new CaptureSpool(join(root, 'capture-spool.sqlite'), { maxReceipts: 2 });
  try {
    for (const index of [1, 2, 3]) spool.recordReceipt({ source: 'codex', repositoryId: 'repo-window', receivedAt: at,
      disposition: 'unsupported-tool', correlationInput: `private-input-${index}` });
    const report = spool.receiptReport();
    assert.deepEqual(report.retention, { firstSequence: 2, lastSequence: 3, capacity: 2 });
    assert.equal(report.receipts.length, 2);
    assert.equal(report.receipts.every(receipt => receipt.repositoryId === 'repo-window'), true);
    assert.equal(JSON.stringify(report).includes('private-input'), false);
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});
