import assert from 'node:assert/strict';
import test from 'node:test';

import { defineRuntimeProfiles } from '../src/config/runtime-profile.js';
import {
  normalizeGitRemoteUrl,
  resolveProfileTarget,
  type ProfileResolutionInput,
  type ProfileTargetSelector
} from '../src/config/profile-resolver.js';

const profiles = defineRuntimeProfiles([
  { id: 'quiet', extends: 'normal', warningsEnabled: false },
  { id: 'safe-learning', extends: 'learning', retrievalEnabled: true }
]);

const facts = {
  workspacePath: '/work/./team/../repo',
  remoteUrl: 'git@GitHub.com:Acme/Project.git'
};

test('resolves every source in the declared precedence order', () => {
  const levels: readonly {
    readonly source: string;
    readonly add: (input: ProfileResolutionInput) => ProfileResolutionInput;
  }[] = [
    { source: 'session-override', add: (input) => ({ ...input, sessionOverride: 'observe-only' }) },
    {
      source: 'local-exact',
      add: (input) => ({
        ...input,
        localSelectors: [...(input.localSelectors ?? []), selector('path', '/work/repo', 'safe-learning')]
      })
    },
    {
      source: 'local-wildcard',
      add: (input) => ({
        ...input,
        localSelectors: [...(input.localSelectors ?? []), selector('path', '/work/*', 'quiet')]
      })
    },
    { source: 'repository-shared', add: (input) => ({ ...input, repositoryShared: 'learning' }) },
    {
      source: 'global-exact',
      add: (input) => ({
        ...input,
        globalSelectors: [...(input.globalSelectors ?? []), selector('remote', 'https://github.com/Acme/Project.git', 'quiet')]
      })
    },
    {
      source: 'global-wildcard',
      add: (input) => ({
        ...input,
        globalSelectors: [...(input.globalSelectors ?? []), selector('remote', 'ssh://git@github.com/Acme/*', 'safe-learning')]
      })
    },
    { source: 'global-default', add: (input) => ({ ...input, globalDefault: 'observe-only' }) },
    { source: 'built-in-default', add: (input) => ({ ...input, builtInDefault: 'normal' }) }
  ];

  for (let first = 0; first < levels.length; first += 1) {
    let input: ProfileResolutionInput = { facts, profiles };
    for (let index = first; index < levels.length; index += 1) input = levels[index]!.add(input);

    const result = resolveProfileTarget(input);

    assert.equal(result.trace.id.source, levels[first]!.source);
  }
});

test('normalizes equivalent remote URL forms for exact and wildcard selection', () => {
  assert.equal(normalizeGitRemoteUrl('git@GitHub.com:Acme/Project.git'), 'github.com/Acme/Project');
  assert.equal(normalizeGitRemoteUrl('ssh://git@github.com/Acme/Project.git/'), 'github.com/Acme/Project');
  assert.equal(normalizeGitRemoteUrl('https://github.com/Acme/Project'), 'github.com/Acme/Project');

  const exact = resolveProfileTarget({
    facts,
    profiles,
    globalSelectors: [
      selector('remote', 'https://github.com/Acme/*', 'learning'),
      selector('remote', 'ssh://git@github.com/Acme/Project.git', 'quiet')
    ]
  });

  assert.equal(exact.profile.id, 'quiet');
  assert.equal(exact.trace.id.source, 'global-exact');
});

test('uses runtime matcher path normalization and supports non-Git workspaces', () => {
  const result = resolveProfileTarget({
    facts: { workspacePath: '/projects/non-git/../scratch/' },
    profiles,
    localSelectors: [selector('path', '/projects/*', 'learning')],
    globalSelectors: [selector('path', '/projects/scratch', 'quiet')]
  });

  assert.equal(result.profile.id, 'learning');
  assert.equal(result.trace.id.source, 'local-wildcard');
  assert.throws(() => resolveProfileTarget({
    facts: { workspacePath: ' C:\\Workspace\\Repo ' },
    profiles
  }), RangeError);
});

test('chooses the most specific wildcard without locale-dependent ordering', () => {
  const result = resolveProfileTarget({
    facts,
    profiles,
    globalSelectors: [
      selector('remote', 'github.com/*', 'observe-only'),
      selector('remote', 'github.com/Acme/*', 'learning'),
      selector('remote', 'github.com/Acme/Pro*', 'quiet')
    ]
  });

  assert.equal(result.profile.id, 'quiet');
  assert.equal(result.trace.id.selector?.pattern, 'github.com/Acme/Pro*');
});

test('rejects equally specific matching selectors as ambiguous', () => {
  assert.throws(() => resolveProfileTarget({
    facts,
    profiles,
    globalSelectors: [
      selector('remote', 'github.com/Acme/P*', 'learning'),
      selector('remote', 'github.com/Acme/*t', 'quiet')
    ]
  }), /ambiguous/i);
});

test('rejects a learning profile with capture disabled in one setting', () => {
  assert.throws(() => resolveProfileTarget({
    facts,
    profiles,
    sessionOverride: { profile: 'learning', captureEnabled: false }
  }), /learning.*capture/i);
});

test('rejects a learning profile assembled with capture disabled by a higher-precedence layer', () => {
  assert.throws(() => resolveProfileTarget({
    facts,
    profiles,
    sessionOverride: { warningsEnabled: false },
    repositoryShared: { captureEnabled: false },
    globalDefault: 'learning',
    builtInDefault: 'normal'
  }), /learning.*capture/i);
});

test('resolves valid profile fields independently and traces every field', () => {
  const result = resolveProfileTarget({
    facts,
    profiles,
    sessionOverride: { warningsEnabled: false },
    repositoryShared: { retrievalEnabled: false },
    globalDefault: 'learning',
    builtInDefault: 'normal'
  });

  assert.equal(result.profile.id, 'learning');
  assert.equal(result.profile.hardBlocking, false);
  assert.equal(result.profile.warningsEnabled, false);
  assert.equal(result.profile.captureEnabled, true);
  assert.equal(result.profile.retrievalEnabled, false);
  assert.equal(result.trace.warningsEnabled.source, 'session-override');
  assert.equal(result.trace.retrievalEnabled.source, 'repository-shared');
  assert.equal(result.trace.hardBlocking.source, 'global-default');
  assert.deepEqual(Object.keys(result.trace).sort(), [
    'captureEnabled',
    'degradedOutcomes',
    'hardBlocking',
    'id',
    'retrievalEnabled',
    'warningsEnabled'
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.profile), true);
  assert.equal(Object.isFrozen(result.profile.degradedOutcomes), true);
  assert.equal(Object.isFrozen(result.trace), true);
  for (const entry of Object.values(result.trace)) assert.equal(Object.isFrozen(entry), true);
});

test('rejects unknown profiles, invalid settings, and malformed selectors', () => {
  assert.throws(() => resolveProfileTarget({ facts, profiles, sessionOverride: 'missing' }), /unknown/i);
  assert.throws(() => resolveProfileTarget({ facts, profiles, sessionOverride: { hardBlocking: 'no' } as never }), /hardBlocking/);
  assert.throws(() => resolveProfileTarget({
    facts,
    profiles,
    globalSelectors: [selector('path', '', 'normal')]
  }), /pattern/i);
});

function selector(
  target: ProfileTargetSelector['target'],
  pattern: string,
  profile: ProfileTargetSelector['profile']
): ProfileTargetSelector {
  return { target, pattern, profile };
}
