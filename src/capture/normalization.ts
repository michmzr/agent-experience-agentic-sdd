import { createHash } from 'node:crypto';

import type { SessionId } from '../domain/types.js';
import type { RuntimeSignature } from '../runtime/contracts.js';
import { normalizeRuntimePath } from '../runtime/matcher.js';
import { assertDurableTextSafe } from '../review/sanitizer.js';
import {
  MAX_CAPTURE_ARGUMENTS,
  MAX_CAPTURE_IDENTIFIER_LENGTH,
  MAX_CAPTURE_TEXT_LENGTH,
  type CaptureOutcome,
  type CapturePhase,
  type MappedCaptureRecord,
  type NormalizedCaptureEvent
} from './contracts.js';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/;
const signatureTokenPattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const argumentPattern = /^[A-Za-z0-9_./:@%+=,~\\-]+$/;
const MAX_CAPTURE_ARGUMENT_LENGTH = 512;
const MAX_CAPTURE_ARGUMENT_TEXT = 8_192;
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

export function normalizeMappedCapture(input: MappedCaptureRecord): NormalizedCaptureEvent {
  if (input.source !== 'codex' && input.source !== 'claude-code' && input.source !== 'cursor') throw new TypeError('Unsupported capture source.');
  const sourceEventId = identifier(input.sourceEventId, 'source event id');
  const sessionId = identifier(input.sessionId, 'session id') as SessionId;
  const phase = capturePhase(input.phase);
  const occurredAt = timestamp(input.occurredAt);
  const summary = safeText(input.summary, 'summary');
  const signature = normalizeSignature(input, phase);
  const outcome = phase === 'post-result' ? captureOutcome(input.outcome) : undefined;
  if (phase !== 'post-result' && (input.outcome !== undefined || input.exitStatus !== undefined || input.relatedEventId !== undefined)) {
    throw new TypeError('Result fields are only allowed for post-result capture.');
  }
  const exitStatus = optionalExitStatus(input.exitStatus);
  const relatedEventId = input.relatedEventId === undefined ? undefined : identifier(input.relatedEventId, 'related event id');
  const id = createHash('sha256').update('ael:capture-event:v1\0').update(input.source).update('\0').update(sourceEventId).digest('hex');

  return Object.freeze({
    id,
    source: input.source,
    sourceEventId,
    sessionId,
    phase,
    occurredAt,
    signature,
    summary,
    ...(outcome === undefined ? {} : { outcome }),
    ...(exitStatus === undefined ? {} : { exitStatus }),
    ...(relatedEventId === undefined ? {} : { relatedEventId })
  });
}

export function normalizeCaptureBatch(events: readonly NormalizedCaptureEvent[]): readonly NormalizedCaptureEvent[] {
  const identities = new Set<string>();
  const normalized = events.map(validateNormalizedCaptureEvent);
  for (const event of normalized) {
    const identity = `${event.source}\0${event.sourceEventId}`;
    if (identities.has(identity)) throw new TypeError('Duplicate source-event identity in capture batch.');
    identities.add(identity);
  }
  return Object.freeze(normalized);
}

export function validateNormalizedCaptureEvent(value: NormalizedCaptureEvent): NormalizedCaptureEvent {
  if (!value || typeof value !== 'object') throw new TypeError('Normalized capture event must be an object.');
  const signature = value.signature;
  const mapped: MappedCaptureRecord = signature.kind === 'intent'
    ? {
        source: value.source, sourceEventId: value.sourceEventId, sessionId: value.sessionId,
        phase: value.phase, occurredAt: value.occurredAt, verb: signature.verb, target: signature.target,
        tool: signature.tool, path: signature.path, summary: value.summary, outcome: value.outcome,
        exitStatus: value.exitStatus, relatedEventId: value.relatedEventId
      }
    : {
        source: value.source, sourceEventId: value.sourceEventId, sessionId: value.sessionId,
        phase: value.phase, occurredAt: value.occurredAt, tool: signature.tool, action: signature.action,
        arguments: signature.arguments, path: signature.path, summary: value.summary, outcome: value.outcome,
        exitStatus: value.exitStatus, relatedEventId: value.relatedEventId
      };
  const normalized = normalizeMappedCapture(mapped);
  if (value.id !== normalized.id || JSON.stringify(value) !== JSON.stringify(normalized)) {
    throw new TypeError('Normalized capture event is not canonical.');
  }
  return normalized;
}

function normalizeSignature(input: MappedCaptureRecord, phase: CapturePhase): RuntimeSignature {
  const path = input.path === undefined ? undefined : normalizeRuntimePath(safeStructuredText(input.path, 'path'));
  if (phase === 'pre-intent') {
    const signature = {
      kind: 'intent' as const,
      verb: safeToken(input.verb, 'intent verb'),
      target: safeToken(input.target, 'intent target'),
      ...(input.tool === undefined ? {} : { tool: safeToken(input.tool, 'tool') }),
      ...(path === undefined ? {} : { path })
    };
    if (input.action !== undefined || input.arguments !== undefined) throw new TypeError('Action fields are not allowed for pre-intent capture.');
    return Object.freeze(signature);
  }

  if (input.verb !== undefined || input.target !== undefined) throw new TypeError('Intent fields are not allowed for action capture.');
  const tool = safeToken(input.tool, 'tool');
  const action = safeToken(input.action, 'action');
  const args = input.arguments === undefined ? undefined : stringArray(input.arguments, tool, action);
  return Object.freeze({
    kind: 'action' as const,
    tool,
    action,
    ...(args === undefined ? {} : { arguments: Object.freeze(args) }),
    ...(path === undefined ? {} : { path })
  });
}

function capturePhase(value: unknown): CapturePhase {
  if (value === 'pre-intent' || value === 'pre-action' || value === 'post-result') return value;
  throw new TypeError('Unsupported capture event kind.');
}

function captureOutcome(value: unknown): CaptureOutcome {
  if (value === 'succeeded' || value === 'failed' || value === 'unknown') return value;
  throw new TypeError('Post-result capture requires a supported outcome.');
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('Capture timestamp must be canonical ISO time.');
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CAPTURE_IDENTIFIER_LENGTH || value !== value.trim() || !identifierPattern.test(value)) {
    throw new TypeError(`Capture ${field} is invalid or exceeds its resource limit.`);
  }
  assertNoCredentialMaterial(value, field);
  return value;
}

function safeToken(value: unknown, field: string): string {
  const normalized = safeText(value, field).toLowerCase();
  if (!signatureTokenPattern.test(normalized)) throw new TypeError(`Capture ${field} is not an allowlisted signature token.`);
  return normalized;
}

function safeText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CAPTURE_TEXT_LENGTH || value !== value.trim()) {
    throw new TypeError(`Capture ${field} is invalid or exceeds its resource limit.`);
  }
  assertNoCredentialMaterial(value, field);
  try {
    assertDurableTextSafe(value);
  } catch {
    throw new TypeError(`Capture ${field} contains credential-like or private material.`);
  }
  return value;
}

function safeStructuredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CAPTURE_TEXT_LENGTH || value !== value.trim()) {
    throw new TypeError(`Capture ${field} is invalid or exceeds its resource limit.`);
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) throw new TypeError(`Capture ${field} contains unsupported control characters.`);
  assertNoCredentialMaterial(value, field);
  return value;
}

function stringArray(value: unknown, tool: string, action: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_ARGUMENTS) throw new TypeError('Capture arguments exceed their resource limit.');
  let total = 0;
  const arguments_ = value.map((item) => {
    const argument = safeStructuredText(item, 'argument');
    total += argument.length;
    if (argument.length > MAX_CAPTURE_ARGUMENT_LENGTH || total > MAX_CAPTURE_ARGUMENT_TEXT || !argumentPattern.test(argument)) {
      throw new TypeError('Capture argument is not an allowlisted bounded token or option.');
    }
    return argument;
  });
  const joined = arguments_.join(' ');
  assertNoCredentialMaterial(joined, 'arguments');
  const sensitiveValueFlag = /^--(?:password|passwd|token|access[-_]?token|refresh[-_]?token|oauth2[-_]?bearer|api[-_]?key|access[-_]?key|private[-_]?key|secret|client[-_]?secret|authorization|auth|credential|credentials)(?:[-_](?:file|stdin))?$/i;
  const sensitiveKey = /^(?:[A-Z][A-Z0-9_]*_)?(?:PASSWORD|PASSWD|TOKEN|KEY|API_KEY|APIKEY|SECRET|CLIENT_SECRET|AUTHORIZATION)$/i;
  const shortPasswordTool = /^(?:mysql|mariadb)$/.test(tool === 'shell' ? action : tool);
  const curlTool = (tool === 'shell' ? action : tool) === 'curl';
  const credentialAssignment = /^(?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|KEY|SECRET|PASSWORD)=.*$/i;
  if (shortPasswordTool && arguments_.some((argument) => /^-p.+/.test(argument))) {
    throw new TypeError('Capture arguments contain credential-like or private material.');
  }
  if (arguments_.some((argument) => credentialAssignment.test(argument)
    || /authorization(?::|=)/i.test(argument)
    || /^(?:-H|--header=?)authorization:/i.test(argument)
    || (curlTool && (/^-u.+/.test(argument) || /^--(?:user|proxy-user)=.+/i.test(argument))))) {
    throw new TypeError('Capture arguments contain credential-like or private material.');
  }
  for (let index = 0; index < arguments_.length - 1; index += 1) {
    const argument = arguments_[index]!;
    if (sensitiveValueFlag.test(argument) || sensitiveKey.test(argument)
      || (argument === '-p' && shortPasswordTool)
      || (curlTool && /^(?:-u|--user|--proxy-user)$/i.test(argument))
      || (/^(?:-H|--header)$/i.test(argument) && /^authorization(?::|=)/i.test(arguments_[index + 1]!))) {
      throw new TypeError('Capture arguments contain credential-like or private material.');
    }
  }
  return arguments_;
}

function optionalExitStatus(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new TypeError('Capture exit status must be a safe integer.');
  return value as number;
}

function assertNoCredentialMaterial(value: string, field: string): void {
  if (credentialPatterns.some((pattern) => pattern.test(value))) {
    throw new TypeError(`Capture ${field} contains credential-like or private material.`);
  }
}
