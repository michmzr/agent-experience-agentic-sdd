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
      path: normalizeOptionalPath(signature.path)
    });
  }

  return JSON.stringify({
    kind: 'intent',
    verb: canonicalToken(signature.verb),
    target: canonicalToken(signature.target),
    tool: canonicalToken(signature.tool ?? ''),
    path: normalizeOptionalPath(signature.path)
  });
}

export function normalizeRuntimePath(path: string): string {
  const slashPath = path.trim().replaceAll('\\', '/');
  const driveMatch = /^([A-Za-z]):(?:\/|$)/.exec(slashPath);
  const drive = driveMatch ? `${driveMatch[1]?.toLowerCase()}:` : '';
  const remainder = driveMatch ? slashPath.slice(driveMatch[0].length) : slashPath;
  const absolute = drive.length > 0 || remainder.startsWith('/');
  const segments: string[] = [];

  for (const segment of remainder.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  if (drive) return `${drive}/${segments.join('/')}`.replace(/\/$/, segments.length === 0 ? '/' : '');
  if (absolute) return `/${segments.join('/')}`;
  return segments.join('/');
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
  if (applicability.scope === 'global') return rule.authoritative;

  return input.repositoryId !== undefined
    && applicability.repositoryId !== undefined
    && input.repositoryId === applicability.repositoryId;
}

function declaredApplicabilityMatches(input: RuntimeInput, rule: RuntimeRule): boolean {
  const { applicability } = rule;
  const signatureTool = input.signature.kind === 'action' ? input.signature.tool : input.signature.tool;
  const signaturePath = input.signature.path;

  if (applicability.tool !== undefined && canonicalToken(applicability.tool) !== canonicalToken(signatureTool ?? '')) return false;
  if (applicability.path !== undefined && normalizeRuntimePath(applicability.path) !== normalizeRuntimePath(signaturePath ?? '')) return false;
  if (applicability.tags !== undefined) {
    const inputTags = new Set((input.tags ?? []).map(canonicalToken));
    if (!applicability.tags.every((tag) => inputTags.has(canonicalToken(tag)))) return false;
  }

  return true;
}

function canonicalToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalPath(path: string | undefined): string {
  return path === undefined ? '' : normalizeRuntimePath(path);
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
