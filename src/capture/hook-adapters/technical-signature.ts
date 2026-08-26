import { assertStructuredArgumentsSafe, containsCredentialMaterial } from '../../privacy/structured-arguments.js';
import { MAX_CAPTURE_ARGUMENTS, MAX_CAPTURE_TEXT_LENGTH } from '../contracts.js';

const shellTokenPattern = /^[A-Za-z0-9_./:@%+=,~\\-]+$/;
const mcpSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const scalarKeyPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const fileEditTools = new Set(['apply_patch', 'Edit', 'Write']);

export interface TechnicalSignatureInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly cwd?: string;
}

export interface TechnicalSignature {
  readonly tool: string;
  readonly action: string;
  readonly arguments?: readonly string[];
  readonly path?: string;
  readonly summary: string;
}

export function technicalSignature(input: TechnicalSignatureInput): TechnicalSignature | undefined {
  assertSafeText(input.toolName, 'tool name');
  if (input.cwd !== undefined) assertSafeText(input.cwd, 'working directory');
  if (input.toolName === 'Bash' || input.toolName === 'Shell') return shellSignature(input);
  if (input.toolName.startsWith('mcp__')) return mcpSignature(input);
  if (fileEditTools.has(input.toolName)) return fileEditSignature(input);
  return undefined;
}

function shellSignature(input: TechnicalSignatureInput): TechnicalSignature {
  const command = field(record(input.toolInput), 'command');
  const tokens = shellTokens(command);
  if (tokens.length < 1) throw rejected();
  const [executable, ...arguments_] = tokens;
  const action = executable!.toLowerCase();
  try {
    assertStructuredArgumentsSafe(arguments_, 'shell', action);
  } catch {
    throw rejectedPrivate();
  }
  return Object.freeze({
    tool: 'shell',
    action,
    ...(arguments_.length === 0 ? {} : { arguments: Object.freeze(arguments_) }),
    ...(input.cwd === undefined ? {} : { path: input.cwd }),
    summary: `Run ${action}.`
  }) as TechnicalSignature;
}

function mcpSignature(input: TechnicalSignatureInput): TechnicalSignature {
  const [, ...segments] = input.toolName.split('__');
  if (segments.length < 2 || segments.some((segment) => !mcpSegmentPattern.test(segment))) throw rejected();
  const arguments_ = scalarArguments(record(input.toolInput));
  const action = segments.join('/').replaceAll('_', '-').toLowerCase();
  try {
    assertStructuredArgumentsSafe(arguments_, 'mcp', action);
  } catch {
    throw rejectedPrivate();
  }
  return Object.freeze({
    tool: 'mcp',
    action,
    ...(arguments_.length === 0 ? {} : { arguments: Object.freeze(arguments_) }),
    ...(input.cwd === undefined ? {} : { path: input.cwd }),
    summary: `Call MCP ${action}.`
  });
}

function fileEditSignature(input: TechnicalSignatureInput): TechnicalSignature {
  const payload = record(input.toolInput);
  const path = optionalPath(payload);
  return Object.freeze({
    tool: 'file',
    action: 'edit',
    ...(path === undefined ? {} : { path }),
    summary: 'Edit file.'
  });
}

function shellTokens(command: string): string[] {
  assertSafeText(command, 'command');
  if (/[\n\r;&|<>`]/.test(command) || /\$\(|\$\{/.test(command)) throw rejected();
  const tokens = command.trim().split(/[ \t]+/).filter(Boolean);
  if (tokens.length > MAX_CAPTURE_ARGUMENTS + 1) throw rejectedLimit();
  for (const token of tokens) {
    assertSafeText(token, 'command token');
    if (!shellTokenPattern.test(token)) throw rejected();
  }
  return tokens;
}

function scalarArguments(payload: Readonly<Record<string, unknown>>): readonly string[] {
  const entries = Object.entries(payload).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (entries.length > MAX_CAPTURE_ARGUMENTS) throw rejectedLimit();
  return entries.map(([key, value]) => {
    if (!scalarKeyPattern.test(key)) throw rejected();
    if (containsCredentialMaterial(key)) throw rejectedPrivate();
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw rejected();
    const argument = `${key}=${String(value)}`;
    assertSafeText(argument, 'argument');
    if (!shellTokenPattern.test(argument)) throw rejected();
    return argument;
  });
}

function optionalPath(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload.file_path ?? payload.path;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw rejected();
  assertSafeText(value, 'path');
  if (!shellTokenPattern.test(value)) throw rejected();
  return value;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw rejected();
  return value as Readonly<Record<string, unknown>>;
}

function field(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw rejected();
  return value;
}

function assertSafeText(value: string, field: string): void {
  if (value.length < 1 || value.length > MAX_CAPTURE_TEXT_LENGTH || value !== value.trim()) throw rejectedLimit();
  if (/[\u0000-\u001F\u007F]/.test(value)) throw rejected();
  if (containsCredentialMaterial(value)) throw rejectedPrivate();
  void field;
}

function rejected(): TypeError {
  return new TypeError('Passive hook payload is unsupported.');
}

function rejectedLimit(): TypeError {
  return new TypeError('Passive hook payload exceeds its resource limit.');
}

function rejectedPrivate(): TypeError {
  return new TypeError('Passive hook payload contains credential-like or private material.');
}
