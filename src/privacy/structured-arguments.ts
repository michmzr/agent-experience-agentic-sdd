const credentialPatterns: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY(?: BLOCK)?-----/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer(?:[_-]?token)?\s*(?:=|:)?\s*\S+/i,
  /\bBasic\s+\S+/i,
  /\b(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|password|passwd|secret|client[_-]?secret)\s*[:=]\s*\S+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i
];

const sensitiveNameTokens = new Set([
  'auth', 'authorization', 'bearer', 'token', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'credentials', 'cookie', 'userinfo'
]);
const sensitiveCollapsedTokens = new Set([
  'apikey', 'accesskey', 'secretkey', 'privatekey', 'clientsecret', 'sessiontoken',
  'accesstoken', 'refreshtoken', 'authtoken', 'oauth2bearer'
]);

export function containsCredentialMaterial(value: string): boolean {
  return credentialPatterns.some((pattern) => pattern.test(value));
}

/** Classifies structured command arguments without including caller-controlled values in diagnostics. */
export function assertStructuredArgumentsSafe(arguments_: readonly string[], tool: string, action: string): void {
  if (containsCredentialMaterial(arguments_.join(' '))) rejectArguments();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument.startsWith('--')) {
      const [name, attached] = argument.slice(2).split('=', 2);
      if (sensitiveOptionName(name!)) rejectArguments();
      if (userValueOption(name!) && ((attached?.length ?? 0) > 0
        || (arguments_[index + 1] !== undefined && !arguments_[index + 1]!.startsWith('-')))) rejectArguments();
    }
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(argument) && arguments_[index + 1] !== undefined
      && (sensitiveOptionName(argument) || userValueOption(argument)
        || (looksLikeEnvironmentName(argument) && sensitiveEnvironmentSuffix(argument)))) rejectArguments();
    const equals = argument.indexOf('=');
    if (equals > 0) {
      const assignmentName = argument.slice(0, equals).replace(/^-+/, '');
      if (sensitiveOptionName(assignmentName) || userValueOption(assignmentName)
        || (looksLikeEnvironmentName(assignmentName) && sensitiveEnvironmentSuffix(assignmentName))) rejectArguments();
    }
    if (sensitiveHeaderName(argument)) rejectArguments();
    if (/^(?:-H|--header)$/i.test(argument) && arguments_[index + 1] !== undefined
      && sensitiveHeaderName(arguments_[index + 1]!)) rejectArguments();
  }

  const command = tool === 'shell' ? action : tool;
  const subcommand = tool === 'shell' ? arguments_[0]?.toLowerCase() : action;
  const sensitiveShortOptions = command === 'redis-cli' ? ['-a']
    : command === 'curl' ? ['-u', '-b', '-c']
      : /^(?:mysql|mariadb)$/.test(command) ? ['-p']
        : command === 'docker' && subcommand === 'login' ? ['-p']
          : [];
  if (arguments_.some((argument) => sensitiveShortOptions.some((option) => argument === option || argument.startsWith(option)))) rejectArguments();
  if (command === 'curl' && arguments_.some((argument) => /^(?:--user|--proxy-user)(?:=|$)/i.test(argument))) rejectArguments();
  if (command === 'redis-cli' && arguments_.some((argument) => {
    const normalized = argument.toLowerCase();
    return normalized === '--pass' || normalized.startsWith('--pass=') || (normalized.startsWith('--pass') && normalized[6] !== '-');
  })) rejectArguments();
}

function nameTokens(value: string): readonly string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function sensitiveOptionName(value: string): boolean {
  const tokens = nameTokens(value);
  const collapsed = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (sensitiveNameTokens.has(collapsed) || sensitiveCollapsedTokens.has(collapsed)) return true;
  if (tokens.some((token) => sensitiveNameTokens.has(token) || sensitiveCollapsedTokens.has(token))) return true;
  return hasAdjacent(tokens, 'api', 'key') || hasAdjacent(tokens, 'secret', 'key') || hasAdjacent(tokens, 'private', 'key')
    || hasAdjacent(tokens, 'access', 'key') || hasAdjacent(tokens, 'session', 'token') || hasAdjacent(tokens, 'user', 'info');
}

function userValueOption(value: string): boolean {
  const normalized = nameTokens(value).join('-');
  return normalized === 'user' || normalized === 'username';
}

function sensitiveEnvironmentSuffix(value: string): boolean {
  const tokens = nameTokens(value);
  const suffix = tokens.at(-1) ?? '';
  return sensitiveCollapsedTokens.has(suffix) || (suffix === 'key' ? tokens.length > 1 : ['token', 'secret', 'password'].includes(suffix));
}

function looksLikeEnvironmentName(value: string): boolean {
  return value.includes('_') || value === value.toUpperCase();
}

function hasAdjacent(tokens: readonly string[], left: string, right: string): boolean {
  return tokens.some((token, index) => token === left && tokens[index + 1] === right);
}

function sensitiveHeaderName(value: string): boolean {
  const colon = value.indexOf(':');
  if (colon < 0) return false;
  const prefix = value.slice(0, colon);
  const name = prefix.slice(Math.max(prefix.lastIndexOf('='), prefix.lastIndexOf('/')) + 1).replace(/^(?:-H|--header=?)/i, '');
  return sensitiveOptionName(name);
}

function rejectArguments(): never {
  throw new TypeError('Structured arguments contain credential-like or private material.');
}
