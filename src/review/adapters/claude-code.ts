import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

import {
  assertSessionArtifactSize,
  MAX_NORMALIZED_SESSION_EVENTS,
  normalizeSession,
  type LocalSessionRecord,
  type NormalizedSession,
  type SessionArtifact
} from '../contracts.js';

export interface ClaudeCodeAdapterOptions {
  readonly configDir: string;
  readonly project?: string;
}

export interface ClaudeCodeArtifact extends SessionArtifact {
  readonly root: string;
}

type ClaudeCodeJsonRecord = {
  readonly type?: unknown;
  readonly timestamp?: unknown;
  readonly tool_name?: unknown;
  readonly exit_code?: unknown;
  readonly message?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
};

export async function discoverClaudeCodeArtifacts(options: ClaudeCodeAdapterOptions): Promise<readonly ClaudeCodeArtifact[]> {
  const projectsRoot = await realpath(resolve(options.configDir, 'projects'));
  const project = requiredProject(options.project);
  const projectRoot = await realpath(join(projectsRoot, project));
  assertWithin(projectsRoot, projectRoot, 'Claude Code project directory');

  const entries = await readdir(projectRoot, { withFileTypes: true });
  const artifacts: ClaudeCodeArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || extname(entry.name) !== '.jsonl' || isExcludedSidecar(entry.name)) continue;
    const location = join(projectRoot, entry.name);
    const fileStatus = await lstat(location);
    if (fileStatus.isSymbolicLink()) continue;
    artifacts.push({
      source: 'claude-code',
      id: basename(entry.name, '.jsonl'),
      location,
      format: 'jsonl',
      root: projectsRoot
    });
  }
  return artifacts.sort((left, right) => left.id.localeCompare(right.id));
}

export async function normalizeClaudeCodeArtifact(artifact: ClaudeCodeArtifact): Promise<NormalizedSession> {
  const projectsRoot = await realpath(artifact.root);
  const artifactStatus = await lstat(artifact.location);
  if (artifactStatus.isSymbolicLink() || !artifactStatus.isFile()) throw new Error('Claude Code session artifact must be a regular file.');
  assertSessionArtifactSize(artifactStatus.size);
  const artifactPath = await realpath(artifact.location);
  assertWithin(projectsRoot, artifactPath, 'Claude Code session artifact');
  if (extname(artifactPath) !== '.jsonl' || isExcludedSidecar(basename(artifactPath))) {
    throw new Error('Claude Code session artifact is unsupported.');
  }

  const contents = await readFile(artifactPath, 'utf8');
  assertSessionArtifactSize(Buffer.byteLength(contents, 'utf8'));
  const records = parseRecords(contents);
  return normalizeSession({ source: 'claude-code', artifact, records });
}

function requiredProject(project: string | undefined): string {
  if (!project || project !== basename(project) || project === '.' || project === '..') {
    throw new Error('A single Claude Code project directory is required.');
  }
  return project;
}

function isExcludedSidecar(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.includes('subagent') || normalized.includes('sidecar');
}

function assertWithin(root: string, target: string, label: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith('../') || pathFromRoot.startsWith('/')) {
    throw new Error(`${label} must remain within the configured projects root.`);
  }
}

function parseRecords(contents: string): readonly LocalSessionRecord[] {
  const records: LocalSessionRecord[] = [];
  const lines = contents.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > MAX_NORMALIZED_SESSION_EVENTS) throw new Error('Session resource limit exceeded.');
  for (const line of lines) {
    let parsed: ClaudeCodeJsonRecord;
    try {
      parsed = JSON.parse(line) as ClaudeCodeJsonRecord;
    } catch {
      throw new Error('Claude Code session artifact contains invalid JSONL.');
    }
    records.push(normalizeRecord(parsed));
  }
  return records;
}

function normalizeRecord(record: ClaudeCodeJsonRecord): LocalSessionRecord {
  if (typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp))) {
    throw new Error('Claude Code session record timestamp is invalid.');
  }
  if (record.type === 'message') {
    const text = messageText(record.message);
    return { kind: 'message', occurredAt: record.timestamp, ...(text ? { text } : {}) };
  }
  if (record.type === 'metadata') return { kind: 'metadata', occurredAt: record.timestamp };
  if (record.type === 'tool') {
    if (typeof record.tool_name !== 'string' || !record.tool_name) throw new Error('Claude Code tool record is invalid.');
    const exitStatus = record.exit_code;
    if (exitStatus !== undefined && (typeof exitStatus !== 'number' || !Number.isInteger(exitStatus) || exitStatus < 0)) {
      throw new Error('Claude Code tool exit status is invalid.');
    }
    const text = toolText(record.input, record.output);
    return {
      kind: 'tool',
      occurredAt: record.timestamp,
      tool: record.tool_name,
      ...(exitStatus === undefined ? {} : { exitStatus }),
      ...(text ? { text } : {})
    };
  }
  throw new Error('Unsupported Claude Code session record.');
}

function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (!isRecord(value)) return undefined;
  if (typeof value.content === 'string') return value.content.trim() ? value.content : undefined;
  if (!Array.isArray(value.content)) return undefined;
  const text = value.content.flatMap((block) => {
    if (!isRecord(block) || !['text', 'input_text', 'output_text'].includes(String(block.type))) return [];
    return typeof block.text === 'string' && block.text.trim() ? [block.text] : [];
  }).join('\n');
  return text || undefined;
}

function toolText(input: unknown, output: unknown): string | undefined {
  const values: string[] = [];
  if (typeof input === 'string' && input.trim()) values.push(input);
  if (isRecord(input)) {
    for (const key of ['command', 'arguments'] as const) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) values.push(value);
    }
  }
  if (typeof output === 'string' && output.trim()) values.push(output);
  return values.join('\n') || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
