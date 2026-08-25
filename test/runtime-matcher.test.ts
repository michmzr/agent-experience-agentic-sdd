import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationClass, RuntimeInput, RuntimeProfile, RuntimeRule, RuntimeSignature } from '../src/runtime/contracts.js';
import { canonicalSignature, matchRules, normalizeRuntimePath } from '../src/runtime/matcher.js';
import { evaluateRule } from '../src/runtime/policy.js';

const normalProfile: RuntimeProfile = {
  id: 'normal',
  hardBlocking: true,
  warningsEnabled: true,
  captureEnabled: true,
  retrievalEnabled: true,
  degradedOutcomes: { normal: 'ALLOW', caution: 'WARN', protected: 'BLOCK' }
};

function actionInput(overrides: {
  readonly repositoryId?: string;
  readonly operationClass?: OperationClass;
  readonly tags?: readonly string[];
  readonly signature?: RuntimeSignature;
} = {}): RuntimeInput {
  return {
    repositoryId: 'repository-1',
    operationClass: 'normal',
    tags: ['git', 'release'],
    signature: {
      kind: 'action',
      tool: 'git',
      action: 'push',
      arguments: ['--force-with-lease', 'origin', 'main'],
      path: '/workspace/project'
    },
    ...overrides
  } as RuntimeInput;
}

function actionRule(id: string, overrides: Partial<RuntimeRule> = {}): RuntimeRule {
  return {
    id,
    state: 'verified',
    authoritative: true,
    effect: 'conflict',
    signature: {
      kind: 'action',
      tool: 'git',
      action: 'push',
      arguments: ['--force-with-lease', 'origin', 'main'],
      path: '/workspace/project'
    },
    applicability: { scope: 'repository', repositoryId: 'repository-1' },
    reference: { knowledgeId: `knowledge-${id}`, evidenceIds: [`evidence-${id}`] },
    ...overrides
  };
}

test('matches canonical exact action signatures', () => {
  const input = actionInput({
    signature: {
      kind: 'action',
      tool: ' git ',
      action: ' PUSH ',
      arguments: ['--force-with-lease', 'origin', 'main'],
      path: '/workspace/project/./'
    }
  });

  const matches = matchRules(input, [actionRule('rule-exact')]);

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.strength, 'exact');
  assert.equal(canonicalSignature(input.signature), JSON.stringify({
    kind: 'action',
    tool: 'git',
    action: 'push',
    arguments: ['--force-with-lease', 'origin', 'main'],
    path: { flavor: 'posix-absolute', normalized: '/workspace/project' }
  }));
});

test('keeps action arguments in the exact signature', () => {
  const rule = actionRule('rule-arguments');
  const input = actionInput({
    signature: { ...rule.signature, arguments: ['--force', 'origin', 'main'] } as RuntimeInput['signature']
  });

  assert.deepEqual(matchRules(input, [rule]), []);
  assert.notEqual(
    canonicalSignature({ kind: 'action', tool: 'git', action: 'show', arguments: ['/workspace/project'] }),
    canonicalSignature({ kind: 'action', tool: 'git', action: 'show', path: '/workspace/project' })
  );
});

test('matches explicit technical intent signatures', () => {
  const input: RuntimeInput = {
    repositoryId: 'repository-1',
    operationClass: 'caution',
    signature: { kind: 'intent', verb: 'migrate', target: 'production-database', tool: 'prisma', path: '/workspace/project' }
  };
  const rule: RuntimeRule = {
    ...actionRule('rule-intent'),
    signature: { kind: 'intent', verb: ' MIGRATE ', target: ' production-database ', tool: 'PRISMA', path: '/workspace/project/' }
  };

  const matches = matchRules(input, [rule]);

  assert.equal(matches[0]?.strength, 'exact');
  assert.equal(matches[0]?.operationClass, 'caution');
});

test('does not match intent rules to actions through shared metadata', () => {
  const intentRule: RuntimeRule = {
    ...actionRule('rule-intent-metadata'),
    signature: { kind: 'intent', verb: 'push', target: 'release', tool: 'git' },
    applicability: { scope: 'repository', repositoryId: 'repository-1', tool: 'git' }
  };

  assert.deepEqual(matchRules(actionInput(), [intentRule]), []);
});

test('normalizes POSIX and Windows paths deterministically', () => {
  assert.equal(normalizeRuntimePath('/workspace/project/src/../src/'), '/workspace/project/src');
  assert.equal(normalizeRuntimePath('C:\\Workspace\\Project\\src\\..\\SRC\\'), 'c:/workspace/project/src');

  const windowsRule = actionRule('rule-windows', {
    signature: { kind: 'action', tool: 'git', action: 'status', path: 'C:\\workspace\\project\\' }
  });
  const windowsInput = actionInput({
    signature: { kind: 'action', tool: 'git', action: 'status', path: 'c:/workspace/project' }
  });

  assert.equal(matchRules(windowsInput, [windowsRule])[0]?.strength, 'exact');
});

test('keeps absent, relative, POSIX absolute, Windows drive, and UNC path identities distinct', () => {
  const signature = (path?: string): RuntimeSignature => ({ kind: 'action', tool: 'git', action: 'status', ...(path === undefined ? {} : { path }) });

  assert.equal(normalizeRuntimePath('.'), '');
  assert.notEqual(canonicalSignature(signature()), canonicalSignature(signature('.')));
  assert.notEqual(canonicalSignature(signature('/workspace/project')), canonicalSignature(signature('workspace/project')));
  assert.notEqual(canonicalSignature(signature('/c:/workspace/project')), canonicalSignature(signature('C:\\workspace\\project')));
  assert.notEqual(canonicalSignature(signature('//server/share/project')), canonicalSignature(signature('\\\\server\\share\\project')));
});

test('preserves leading and trailing whitespace in POSIX exact-signature path identity', () => {
  const signature = (path: string): RuntimeSignature => ({ kind: 'action', tool: 'git', action: 'status', path });

  for (const [spaced, unspaced] of [
    ['/repo/file ', '/repo/file'],
    [' repo/file', 'repo/file'],
    ['repo/file ', 'repo/file']
  ] as const) {
    assert.notEqual(canonicalSignature(signature(spaced)), canonicalSignature(signature(unspaced)));
  }
});

test('does not metadata-match POSIX paths that differ by leading or trailing whitespace', () => {
  for (const [rulePath, inputPath] of [
    ['/repo/file ', '/repo/file'],
    [' repo/file', 'repo/file'],
    ['repo/file ', 'repo/file']
  ] as const) {
    const rule = actionRule(`rule-whitespace-${rulePath}`, {
      signature: { kind: 'action', tool: 'git', action: 'fetch' },
      applicability: { scope: 'repository', repositoryId: 'repository-1', path: rulePath }
    });
    const input = actionInput({
      signature: { kind: 'action', tool: 'git', action: 'push', path: inputPath }
    });

    assert.deepEqual(matchRules(input, [rule]), []);
  }
});

test('rejects surrounding whitespace on Windows-looking paths', () => {
  for (const path of [' C:\\repo', 'C:\\repo ', ' \\\\server\\share', '\\\\server\\share ']) {
    assert.throws(() => normalizeRuntimePath(path), { name: 'RangeError' });
  }
});

test('rejects Windows drive-relative paths instead of treating them as drive roots', () => {
  for (const path of ['C:', 'C:project']) {
    assert.throws(() => normalizeRuntimePath(path), { name: 'RangeError' });
    assert.throws(() => matchRules(actionInput({
      signature: { kind: 'action', tool: 'git', action: 'status', path }
    }), []), { name: 'RangeError' });
    assert.throws(() => matchRules(actionInput({
      signature: { kind: 'action', tool: 'git', action: 'status', path }
    }), [actionRule(`rule-${path}`)]), { name: 'RangeError' });
  }

  assert.equal(normalizeRuntimePath('C:\\'), 'c:/');
});

test('matches Windows metadata paths case-insensitively without crossing path flavors', () => {
  const windowsMetadata = actionRule('rule-windows-metadata', {
    signature: { kind: 'action', tool: 'git', action: 'fetch' },
    applicability: {
      scope: 'repository',
      repositoryId: 'repository-1',
      path: 'C:\\WORKSPACE\\PROJECT'
    }
  });
  const windowsInput = actionInput({
    signature: { kind: 'action', tool: 'git', action: 'push', path: 'c:\\workspace\\project\\' }
  });
  const posixInput = actionInput({
    signature: { kind: 'action', tool: 'git', action: 'push', path: '/c:/workspace/project' }
  });

  assert.equal(matchRules(windowsInput, [windowsMetadata])[0]?.strength, 'metadata');
  assert.deepEqual(matchRules(posixInput, [windowsMetadata]), []);
});

test('uses structured repository, tool, and path metadata after exact matching', () => {
  const rule = actionRule('rule-metadata', {
    signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--force'] },
    applicability: {
      scope: 'repository',
      repositoryId: 'repository-1',
      tool: 'git',
      path: '/workspace/project/'
    }
  });

  assert.equal(matchRules(actionInput(), [rule])[0]?.strength, 'metadata');
});

test('uses tag subset matching only when every rule tag is present', () => {
  const matching = actionRule('rule-tags', {
    signature: { kind: 'action', tool: 'pnpm', action: 'publish' },
    applicability: { scope: 'repository', repositoryId: 'repository-1', tags: ['release', 'git'] }
  });
  const missing = actionRule('rule-tags-missing', {
    signature: { kind: 'action', tool: 'pnpm', action: 'publish' },
    applicability: { scope: 'repository', repositoryId: 'repository-1', tags: ['release', 'protected'] }
  });

  const matches = matchRules(actionInput(), [missing, matching]);

  assert.deepEqual(matches.map(({ rule }) => rule.id), ['rule-tags']);
  assert.equal(matches[0]?.strength, 'tags');
});

test('combines authoritative global rules with rules for the active repository', () => {
  const global = actionRule('rule-global', { applicability: { scope: 'global' } });
  const repository = actionRule('rule-repository');

  const matches = matchRules(actionInput(), [repository, global]);

  assert.deepEqual(matches.map(({ rule }) => rule.id), ['rule-global', 'rule-repository']);
});

test('returns non-authoritative global matches as context while policy keeps them non-enforcing', () => {
  const unapprovedGlobal = actionRule('rule-unapproved-global', {
    authoritative: false,
    applicability: { scope: 'global' }
  });

  const matches = matchRules(actionInput(), [unapprovedGlobal]);
  assert.equal(matches.length, 1);
  const decision = evaluateRule(matches[0]!, normalProfile);

  assert.equal(matches[0]?.strength, 'exact');
  assert.equal(decision.outcome, 'ALLOW');
  assert.equal(decision.explanation.code, 'CONTEXT_ONLY');
});

test('isolates rules belonging to other repositories', () => {
  const otherRepository = actionRule('rule-other', {
    applicability: { scope: 'repository', repositoryId: 'repository-2' }
  });

  assert.deepEqual(matchRules(actionInput(), [otherRepository]), []);
});

test('sorts matches by strength and then stable rule ID', () => {
  const exactB = actionRule('rule-b');
  const exactA = actionRule('rule-a');
  const metadata = actionRule('rule-metadata', {
    signature: { kind: 'action', tool: 'git', action: 'fetch' },
    applicability: { scope: 'repository', repositoryId: 'repository-1', tool: 'git' }
  });
  const tags = actionRule('rule-tags', {
    signature: { kind: 'action', tool: 'pnpm', action: 'publish' },
    applicability: { scope: 'repository', repositoryId: 'repository-1', tags: ['release'] }
  });

  const matches = matchRules(actionInput(), [tags, exactB, metadata, exactA]);

  assert.deepEqual(matches.map(({ rule, strength }) => [rule.id, strength]), [
    ['rule-a', 'exact'],
    ['rule-b', 'exact'],
    ['rule-metadata', 'metadata'],
    ['rule-tags', 'tags']
  ]);
});

test('returns immutable matches detached from caller-owned rules', () => {
  const source = actionRule('rule-immutable');
  const matches = matchRules(actionInput(), [source]);
  (source.reference.evidenceIds as string[]).push('later-evidence');

  assert.equal(Object.isFrozen(matches), true);
  assert.equal(Object.isFrozen(matches[0]), true);
  assert.equal(Object.isFrozen(matches[0]?.rule), true);
  assert.equal(Object.isFrozen(matches[0]?.rule.reference.evidenceIds), true);
  assert.deepEqual(matches[0]?.rule.reference.evidenceIds, ['evidence-rule-immutable']);
});
