import type {
  MatchStrength,
  RuleMatch,
  RuntimeInput,
  RuntimeRule,
  RuntimeSignature
} from './contracts.js';

const strengthRank: Readonly<Record<MatchStrength, number>> = Object.freeze({ exact: 3, metadata: 2, tags: 1 });

/** Performs deterministic matching only. Optional semantic enrichment is a separate boundary. */
export function matchRules(input: RuntimeInput, rules: readonly RuntimeRule[]): readonly RuleMatch[] {
  if (input.signature.path !== undefined) canonicalPath(input.signature.path);
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    if (!scopeApplies(input, rule) || !declaredApplicabilityMatches(input, rule)) continue;

    const strength = matchStrength(input, rule);
    if (!strength) continue;

    matches.push(Object.freeze({
      rule: freezeRule(rule),
      strength,
      operationClass: input.operationClass
    }));
  }

  matches.sort((left, right) => {
    const rankDifference = strengthRank[right.strength] - strengthRank[left.strength];
    if (rankDifference !== 0) return rankDifference;
    return left.rule.id < right.rule.id ? -1 : left.rule.id > right.rule.id ? 1 : 0;
  });

  return Object.freeze(matches);
}

export function canonicalSignature(signature: RuntimeSignature): string {
  if (signature.kind === 'action') {
    return JSON.stringify({
      kind: 'action',
      tool: canonicalToken(signature.tool),
      action: canonicalToken(signature.action),
      arguments: [...(signature.arguments ?? [])],
      path: canonicalOptionalPath(signature.path)
    });
  }

  return JSON.stringify({
    kind: 'intent',
    verb: canonicalToken(signature.verb),
    target: canonicalToken(signature.target),
    tool: canonicalToken(signature.tool ?? ''),
    path: canonicalOptionalPath(signature.path)
  });
}

/**
 * Normalizes a supported lexical path without filesystem access. Forward-slash
 * absolute and relative forms are POSIX; drive-rooted forms and a leading `\\`
 * are Windows. Path flavor is omitted from this display value; enforcement
 * comparisons use an internal flavor-aware identity.
 */
export function normalizeRuntimePath(path: string): string {
  return canonicalPath(path).normalized;
}

type RuntimePathFlavor = 'posix-absolute' | 'posix-relative' | 'windows-drive-absolute' | 'windows-unc';

interface CanonicalPath {
  readonly flavor: RuntimePathFlavor;
  readonly normalized: string;
}

function canonicalPath(path: string): CanonicalPath {
  const withoutSurroundingWhitespace = path.trim();
  const windowsLookingAfterTrim = /^[A-Za-z]:/.test(withoutSurroundingWhitespace)
    || /^\\\\/.test(withoutSurroundingWhitespace);
  if (path !== withoutSurroundingWhitespace && windowsLookingAfterTrim) {
    throw new RangeError('Windows paths cannot contain surrounding whitespace.');
  }
  if (/^[A-Za-z]:(?![\\/])/.test(path)) {
    throw new RangeError('Windows drive-relative paths are not supported.');
  }

  const driveMatch = /^([A-Za-z]):[\\/]/.exec(path);
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase();
    const remainder = path.slice(driveMatch[0].length).replaceAll('\\', '/');
    const segments = normalizeSegments(remainder, true, true);
    return { flavor: 'windows-drive-absolute', normalized: `${drive}:/${segments.join('/')}` };
  }

  if (/^\\\\/.test(path)) {
    const remainder = path.slice(2).replaceAll('\\', '/');
    const segments = normalizeSegments(remainder, true, true);
    return { flavor: 'windows-unc', normalized: `//${segments.join('/')}` };
  }

  if (path.includes('\\')) throw new RangeError('Unsupported Windows-relative path.');
  if (path.startsWith('/')) {
    const segments = normalizeSegments(path, true, false);
    return { flavor: 'posix-absolute', normalized: `/${segments.join('/')}` };
  }

  const segments = normalizeSegments(path, false, false);
  return { flavor: 'posix-relative', normalized: segments.join('/') };
}

function normalizeSegments(path: string, absolute: boolean, caseInsensitive: boolean): string[] {
  const segments: string[] = [];

  for (const rawSegment of path.split('/')) {
    const segment = caseInsensitive ? rawSegment.toLowerCase() : rawSegment;
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  return segments;
}

function matchStrength(input: RuntimeInput, rule: RuntimeRule): MatchStrength | undefined {
  if (input.signature.kind !== rule.signature.kind) return undefined;
  if (canonicalSignature(input.signature) === canonicalSignature(rule.signature)) return 'exact';

  const { applicability } = rule;
  if (applicability.tool !== undefined || applicability.path !== undefined) return 'metadata';
  if (applicability.tags !== undefined && applicability.tags.length > 0) return 'tags';

  return undefined;
}

function scopeApplies(input: RuntimeInput, rule: RuntimeRule): boolean {
  const { applicability } = rule;
  if (applicability.scope === 'global') return true;

  return input.repositoryId !== undefined
    && applicability.repositoryId !== undefined
    && input.repositoryId === applicability.repositoryId;
}

function declaredApplicabilityMatches(input: RuntimeInput, rule: RuntimeRule): boolean {
  const { applicability } = rule;
  const signatureTool = input.signature.kind === 'action' ? input.signature.tool : input.signature.tool;
  const signaturePath = input.signature.path;

  if (applicability.tool !== undefined && canonicalToken(applicability.tool) !== canonicalToken(signatureTool ?? '')) return false;
  if (applicability.path !== undefined) {
    if (signaturePath === undefined || canonicalPathIdentity(applicability.path) !== canonicalPathIdentity(signaturePath)) return false;
  }
  if (applicability.tags !== undefined) {
    const inputTags = new Set((input.tags ?? []).map(canonicalToken));
    if (!applicability.tags.every((tag) => inputTags.has(canonicalToken(tag)))) return false;
  }

  return true;
}

function canonicalToken(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalOptionalPath(path: string | undefined): CanonicalPath | null {
  return path === undefined ? null : canonicalPath(path);
}

function canonicalPathIdentity(path: string): string {
  const canonical = canonicalPath(path);
  return `${canonical.flavor}\u0000${canonical.normalized}`;
}

function freezeRule(rule: RuntimeRule): RuntimeRule {
  const signature = rule.signature.kind === 'action'
    ? Object.freeze({
        ...rule.signature,
        ...(rule.signature.arguments === undefined ? {} : { arguments: Object.freeze([...rule.signature.arguments]) })
      })
    : Object.freeze({ ...rule.signature });
  const applicability = Object.freeze({
    ...rule.applicability,
    ...(rule.applicability.tags === undefined ? {} : { tags: Object.freeze([...rule.applicability.tags]) })
  });
  const reference = Object.freeze({
    ...rule.reference,
    evidenceIds: Object.freeze([...rule.reference.evidenceIds])
  });

  return Object.freeze({ ...rule, signature, applicability, reference });
}
