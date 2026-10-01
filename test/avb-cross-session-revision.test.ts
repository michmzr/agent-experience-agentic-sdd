import assert from 'node:assert/strict';
import test from 'node:test';

import { createCrossSessionRealProtocol, createPairedProtocol } from '../src/benchmark/paired.js';
import { crossSessionFixtureDigest, crossSessionFixtureDigestV2 } from '../src/benchmark/cross-session-scenario.js';
import { qualifiedCodexCli } from '../src/host/codex-cli-launcher.js';

const common = { baselineBuildId: 'a'.repeat(64), candidateBuildId: 'b'.repeat(64),
  sourceVersions: { runnerCorpus: 'b2-3', aap: 'codex-exposure-v1' },
  environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform,
    arch: process.arch }, seed: 17,
  budgets: { wallMilliseconds: 120_000, aelOverheadMilliseconds: 10_000, tokens: null } };

test('paired protocol keeps b2-2/rev1 distinct from b2-3/rev2', () => {
  const rev2 = createPairedProtocol({ ...common, corpusVersion: 'b2-3',
    scenarios: [{ id: 'cross-session-package-manager', revision: 2 }] });
  assert.equal(rev2.order.length, 15);
  assert.equal(rev2.scenarios[0]!.revision, 2);
  assert.throws(() => createPairedProtocol({ ...common, corpusVersion: 'b2-3',
    scenarios: [{ id: 'cross-session-package-manager', revision: 1 }] }));
  assert.throws(() => createPairedProtocol({ ...common, corpusVersion: 'b2-2',
    sourceVersions: { ...common.sourceVersions, runnerCorpus: 'b2-2' },
    scenarios: [{ id: 'cross-session-package-manager', revision: 2 }] }));
});

test('real protocol accepts rev2 digest and rejects cross-revision substitution', () => {
  const agent = { model: qualifiedCodexCli.model, cliVersion: '0.157.1',
    binarySha256: qualifiedCodexCli.sha256, sandbox: 'workspace-write', approval: 'never' };
  const seedStoreDigest = 'c'.repeat(64);
  const rev1 = createCrossSessionRealProtocol({ ...common, corpusVersion: 'b2-2',
    sourceVersions: { runnerCorpus: 'b2-2', aap: 'codex-exposure-v1' },
    scenarios: [{ id: 'cross-session-package-manager', revision: 1 }],
    fixtureDigest: crossSessionFixtureDigest, seedStoreDigest, agent });
  const rev2 = createCrossSessionRealProtocol({ ...common, corpusVersion: 'b2-3',
    scenarios: [{ id: 'cross-session-package-manager', revision: 2 }],
    fixtureDigest: crossSessionFixtureDigestV2, seedStoreDigest, agent });
  assert.notEqual(rev1.protocolDigest, rev2.protocolDigest);
  assert.equal(rev2.scenarios[0]!.revision, 2);
  assert.throws(() => createCrossSessionRealProtocol({ ...common, corpusVersion: 'b2-3',
    scenarios: [{ id: 'cross-session-package-manager', revision: 2 }],
    fixtureDigest: crossSessionFixtureDigest, seedStoreDigest, agent }));
});
