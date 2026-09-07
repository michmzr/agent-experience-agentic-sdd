import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  assertSessionArtifactSize,
  normalizeSession,
  type LocalSessionRecord,
  type NormalizedSession,
  type SessionArtifact
} from '../contracts.js';
import { formatSafeRecordType, type SessionIngestionDiagnosticSink } from '../ingestion.js';
import { readBoundedJsonl } from './bounded-jsonl.js';
import { createBoundedSessionAccumulator } from '../bounded-session.js';
import { isWithinRepository, resolveRepositoryIdentity } from '../repository-identity.js';
import {
  createCodexIngestionCoverageCounter,
  finalizeCodexIngestionCoverage,
  incrementCodexIngestionCoverage,
  type CodexRecordDisposition
} from './codex-records.js';
import { createCodexStreamingProjector } from './codex-streaming-projector.js';

/**
 * Reads the explicitly supplied, locally observed Codex JSONL artifact format.
 * There is intentionally no default user-home location: the observed storage
 * layout is not a compatibility contract of Codex.
 */
export interface CodexSessionAdapterOptions {
  readonly diagnosticSink?: SessionIngestionDiagnosticSink;
}

export class CodexSessionAdapter {
  public constructor(
    private readonly artifactRoot: string,
    private readonly options: CodexSessionAdapterOptions = {}
  ) {}

  public async discover(): Promise<readonly SessionArtifact[]> {
    const root = await this.resolveRoot();
    const paths = await this.findJsonlFiles(root, root);
    const repository = resolveRepositoryIdentity(root);
    return Promise.all(paths.map(async (path) => {
      if (repository && !isWithinRepository(repository, path)) throw new Error('Codex session artifact repository scope could not be verified.');
      const status = await lstat(path);
      return {
        source: 'codex' as const,
        id: relative(root, path).split(sep).join('/'),
        location: path,
        format: 'observed-jsonl' as const,
        ...(repository ? {
          repositoryHint: repository.hint,
          repositoryHintVerified: true,
          repositoryIdentity: repository.canonicalTopLevel
        } : {}),
        updatedAt: status.mtime.toISOString()
      };
    }));
  }

  public async read(artifactId: string): Promise<NormalizedSession> {
    const root = await this.resolveRoot();
    const artifactPath = await this.resolveArtifact(root, artifactId);
    assertSessionArtifactSize((await lstat(artifactPath)).size);
    const accumulator = createBoundedSessionAccumulator();
    const coverage = createCodexIngestionCoverageCounter();
    let sourceOrdinal = 0;
    let usedStreamingProjection = false;
    let parseError: unknown;
    const consumeDisposition = async (disposition: CodexRecordDisposition, ordinal: number): Promise<void> => {
      incrementCodexIngestionCoverage(coverage, disposition);
      if (disposition.state === 'normalized') {
        accumulator.add({ ...disposition.record, sourceOrdinal: ordinal });
      } else if (disposition.state === 'unsupported') {
        await this.options.diagnosticSink?.(disposition.diagnostic);
      }
    };
    await readBoundedJsonl({
      path: artifactPath,
      onLine: async (line) => {
        if (parseError !== undefined) return;
        try {
          const currentSourceOrdinal = sourceOrdinal;
          sourceOrdinal = nextSourceOrdinal(sourceOrdinal);
          const disposition = this.parseRecord(line, currentSourceOrdinal);
          await consumeDisposition(disposition, currentSourceOrdinal);
        } catch (error) {
          parseError = error;
        }
      },
      overflowRecordFactory: async ({ prefix, sourceOrdinal: overflowOrdinal }) => {
        usedStreamingProjection = true;
        const projector = createCodexStreamingProjector({
          sourceOrdinal: overflowOrdinal
        });
        await projector.write(prefix);
        return {
          write: (chunk) => projector.write(chunk),
          finish: async () => {
            const disposition = await projector.finish();
            await consumeDisposition(disposition, overflowOrdinal);
            sourceOrdinal = nextSourceOrdinal(overflowOrdinal);
          }
        };
      }
    });
    if (parseError !== undefined) throw parseError;
    const window = accumulator.finish();
    return normalizeSession({
      source: 'codex',
      artifact: { source: 'codex', id: artifactId, location: artifactPath, format: 'observed-jsonl' },
      records: window.records,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      ingestionCoverage: finalizeCodexIngestionCoverage(coverage, usedStreamingProjection)
    });
  }

  private async resolveRoot(): Promise<string> {
    const rootInfo = await lstat(this.artifactRoot).catch(() => undefined);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Codex artifact root is unavailable.');
    return realpath(this.artifactRoot);
  }

  private async findJsonlFiles(root: string, directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...await this.findJsonlFiles(root, candidate));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const resolved = await realpath(candidate);
        if (this.isWithin(root, resolved)) files.push(resolved);
      }
    }
    return files;
  }

  private async resolveArtifact(root: string, artifactId: string): Promise<string> {
    if (!this.isSafeArtifactId(artifactId)) throw new Error('Selected session artifact is outside the injected root.');
    const candidate = join(root, ...artifactId.split('/'));
    const info = await lstat(candidate).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error('Selected session artifact is unavailable.');
    const resolved = await realpath(candidate);
    if (!this.isWithin(root, resolved)) throw new Error('Selected session artifact is outside the injected root.');
    return resolved;
  }

  private isSafeArtifactId(artifactId: string): boolean {
    return artifactId.endsWith('.jsonl')
      && !isAbsolute(artifactId)
      && !artifactId.includes('\\')
      && artifactId.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
  }

  private isWithin(root: string, candidate: string): boolean {
    const pathFromRoot = relative(root, candidate);
    return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
  }

  private parseRecord(line: string, sourceOrdinal: number): CodexRecordDisposition {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('Codex session record is invalid JSON.');
    }
    if (!isRecord(value)) throw new Error('Unsupported session record.');
    if ('kind' in value || 'occurredAt' in value) return normalized(this.parseSyntheticRecord(value));
    return this.parseObservedRecord(value, sourceOrdinal);
  }

  private parseSyntheticRecord(value: Record<string, unknown>): LocalSessionRecord {
    if (!isKnownKind(value.kind) || typeof value.occurredAt !== 'string') throw new Error('Unsupported session record.');
    if (value.tool !== undefined && typeof value.tool !== 'string') throw new Error('Unsupported session record.');
    if (value.text !== undefined && typeof value.text !== 'string') throw new Error('Unsupported session record.');
    if (value.exitStatus !== undefined && (typeof value.exitStatus !== 'number' || !Number.isFinite(value.exitStatus))) {
      throw new Error('Unsupported session record.');
    }
    return {
      kind: value.kind,
      occurredAt: value.occurredAt,
      ...(typeof value.tool === 'string' ? { tool: value.tool } : {}),
      ...(typeof value.exitStatus === 'number' ? { exitStatus: value.exitStatus } : {}),
      ...(typeof value.text === 'string' ? { text: value.text } : {})
    };
  }

  private parseObservedRecord(value: Record<string, unknown>, sourceOrdinal: number): CodexRecordDisposition {
    if (typeof value.timestamp !== 'string' || typeof value.type !== 'string' || !isRecord(value.payload)) {
      throw new Error('Unsupported session record.');
    }
    if (value.type === 'token_usage_record') return { state: 'technical-skip' };
    if (!isObservedEnvelopeType(value.type)) return {
      state: 'unsupported',
      diagnostic: {
        code: 'UNSUPPORTED_CODEX_RECORD',
        level: 'envelope',
        recordType: formatSafeRecordType(value.type),
        sourceOrdinal
      }
    };
    if (value.type === 'session_meta' || value.type === 'turn_context' || value.type === 'compacted' || value.type === 'inter_agent_communication_metadata' || value.type === 'world_state') {
      return normalized({ kind: 'metadata', occurredAt: value.timestamp });
    }
    if (value.type === 'event_msg') {
      const text = ['user_message', 'agent_message'].includes(String(value.payload.type))
        ? stringValue(value.payload.message)
        : undefined;
      return normalized({
        kind: 'message',
        occurredAt: value.timestamp,
        ...(text ? { text } : {})
      });
    }
    return this.parseObservedResponseItem(value.timestamp, value.payload, sourceOrdinal);
  }

  private parseObservedResponseItem(timestamp: string, payload: Record<string, unknown>, sourceOrdinal: number): CodexRecordDisposition {
    if (typeof payload.type !== 'string') throw new Error('Unsupported session record.');
    if (!isObservedResponseItemType(payload.type)) return {
      state: 'unsupported',
      diagnostic: {
        code: 'UNSUPPORTED_CODEX_RECORD',
        level: 'response-item',
        recordType: formatSafeRecordType(payload.type),
        sourceOrdinal
      }
    };
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      if (!isSafeToolName(payload.name)) throw new Error('Unsupported session record.');
      const text = payload.type === 'function_call'
        ? stringValue(payload.arguments)
        : stringValue(payload.input);
      return normalized({ kind: 'tool', occurredAt: timestamp, tool: payload.name, ...(text ? { text } : {}) });
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const text = stringValue(payload.output);
      return normalized(
        { kind: 'tool', occurredAt: timestamp, ...(text ? { text } : {}) },
        isStructuredValue(payload.output) ? 1 : 0
      );
    }
    const text = payload.type === 'message' ? messageText(payload.content) : undefined;
    return normalized({ kind: 'message', occurredAt: timestamp, ...(text ? { text } : {}) });
  }
}

function normalized(record: LocalSessionRecord, omittedStructuredOutputs = 0): CodexRecordDisposition {
  return { state: 'normalized', record, truncatedTextFields: 0, omittedStructuredOutputs };
}

function nextSourceOrdinal(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Session record ordinal is invalid.');
  }
  return value + 1;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return stringValue(value);
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((block) => {
    if (!isRecord(block) || !['input_text', 'output_text', 'text'].includes(String(block.type))) return [];
    return typeof block.text === 'string' && block.text.trim() ? [block.text] : [];
  }).join('\n');
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnownKind(value: unknown): value is 'tool' | 'message' | 'metadata' {
  return value === 'tool' || value === 'message' || value === 'metadata';
}

function isObservedEnvelopeType(value: unknown): value is 'session_meta' | 'event_msg' | 'response_item' | 'turn_context' | 'compacted' | 'inter_agent_communication_metadata' | 'world_state' {
  return value === 'session_meta' || value === 'event_msg' || value === 'response_item' || value === 'turn_context'
    || value === 'compacted' || value === 'inter_agent_communication_metadata' || value === 'world_state';
}

function isObservedResponseItemType(
  value: unknown
): value is 'message' | 'reasoning' | 'function_call' | 'function_call_output' | 'custom_tool_call' | 'custom_tool_call_output' {
  return value === 'message'
    || value === 'reasoning'
    || value === 'function_call'
    || value === 'function_call_output'
    || value === 'custom_tool_call'
    || value === 'custom_tool_call_output';
}

function isSafeToolName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value);
}

function isStructuredValue(value: unknown): boolean {
  return Array.isArray(value) || isRecord(value);
}
