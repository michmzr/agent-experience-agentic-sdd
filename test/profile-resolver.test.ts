import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineRuntimeProfiles,
  type RuntimeProfileRegistry
} from '../src/config/runtime-profile.js';
import {
  normalizeGitRemoteUrl,
  resolveProfileTarget,
  type ProfileResolutionInput,
  type ProfileTargetSelector
} from '../src/config/profile-resolver.js';

const profiles = defineRuntimeProfiles([
  { id: 'quiet', extends: 'normal', warningsEnabled: false },
  { id: 'safe-learning', extends: 'learning', warningsEnabled: false },
  { id: 'blocking-learning', extends: 'safe-learning', hardBlocking: true }
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

test('rejects a learning descendant that disables warnings and capture in one setting', () => {
  assert.throws(() => resolveProfileTarget({
    facts,
    profiles,
    sessionOverride: { profile: 'safe-learning', captureEnabled: false }
  }), /learning.*capture/i);
});

test('rejects a transitive learning descendant with blocking restored when capture is disabled by another layer', () => {
  assert.throws(() => resolveProfileTarget({
    facts,
    profiles,
    repositoryShared: { captureEnabled: false },
    globalDefault: 'blocking-learning'
  }), /learning.*capture/i);
});

test('preserves learning lineage through object spread and JSON serialization', () => {
  const cloned: RuntimeProfileRegistry = {
    ...profiles,
    profiles: { ...profiles.profiles },
    learningProfileIds: [...profiles.learningProfileIds]
  };
  const deserialized = JSON.parse(JSON.stringify(profiles)) as RuntimeProfileRegistry;

  for (const registry of [cloned, deserialized]) {
    assert.throws(() => resolveProfileTarget({
      facts,
      profiles: registry,
      sessionOverride: { profile: 'safe-learning', captureEnabled: false }
    }), /learning.*capture/i);
  }
});

test('allows a non-learning warn-only custom profile with capture disabled', () => {
  const nonLearningProfiles = defineRuntimeProfiles([
    {
      id: 'warn-only-no-capture',
      extends: 'normal',
      hardBlocking: false,
      captureEnabled: false
    }
  ]);

  const result = resolveProfileTarget({
    facts,
    profiles: nonLearningProfiles,
    sessionOverride: 'warn-only-no-capture'
  });

  assert.equal(result.profile.id, 'warn-only-no-capture');
  assert.equal(result.profile.captureEnabled, false);
});

test('treats Object prototype profile names as explicit IDs only', () => {
  const specialProfiles = defineRuntimeProfiles([
    { id: 'toString', extends: 'normal' },
    { id: 'constructor', extends: 'normal' },
    { id: '__proto__', extends: 'normal' }
  ]);

  for (const id of ['toString', 'constructor', '__proto__']) {
    assert.equal(resolveProfileTarget({ facts, profiles: specialProfiles, sessionOverride: id }).profile.id, id);
  }
  for (const id of ['toString', 'constructor', '__proto__']) {
    assert.throws(() => resolveProfileTarget({ facts, sessionOverride: id }), /unknown/i);
  }
});

test('remote diagnostics and traces never retain credential-bearing userinfo', () => {
  const secret = 'remote-user-secret';
  const malformedRemoteCalls = [
    () => normalizeGitRemoteUrl(`https://${secret}@invalid`),
    () => resolveProfileTarget({
      facts: { workspacePath: '/work/repo', remoteUrl: `https://${secret}@invalid` },
      profiles
    }),
    () => resolveProfileTarget({
      facts,
      profiles,
      globalSelectors: [selector('remote', `https://${secret}@invalid`, 'normal')]
    })
  ];
  for (const call of malformedRemoteCalls) {
    let diagnostic = '';
    try {
      call();
    } catch (error) {
      diagnostic = String(error);
    }
    assert.equal(diagnostic.includes(secret), false);
  }

  const result = resolveProfileTarget({
    facts: { workspacePath: '/work/repo', remoteUrl: `https://fact:${secret}@github.com/Acme/Project.git` },
    profiles,
    globalSelectors: [selector('remote', `https://selector:${secret}@github.com/Acme/Project.git`, 'quiet')]
  });
  assert.equal(JSON.stringify(result.trace).includes(secret), false);
  assert.equal(result.trace.id.selector?.pattern, 'github.com/Acme/Project');
});

test('path selectors preserve Task 1 path flavor identity', () => {
  const result = resolveProfileTarget({
    facts: { workspacePath: 'C:\\Repo' },
    profiles,
    localSelectors: [selector('path', './c:/repo', 'learning')]
  });

  assert.equal(result.profile.id, 'normal');
  assert.equal(result.trace.id.source, 'built-in-default');
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
