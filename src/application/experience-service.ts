import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExperienceImport, KnowledgeEntry, KnowledgeState } from '../domain/types.js';
import { validateImport } from '../domain/validation.js';
import { defaultDatabasePath } from '../storage/database.js';
import { ExperienceStore, type KnowledgeScope, type RetrievalFilter, type RetrievedKnowledgeEntry } from '../storage/experience-store.js';

export interface LessonFilter {
  readonly scope?: KnowledgeScope;
  readonly repositoryId?: string;
  readonly state?: KnowledgeState;
  readonly tag?: string;
}

export interface ExperienceServiceOptions {
  readonly dataDir?: string;
}

export class ExperienceService {
  private readonly databasePath: string;

  constructor(options: ExperienceServiceOptions = {}) {
    this.databasePath = options.dataDir ? join(options.dataDir, 'experience.sqlite') : defaultDatabasePath();
  }

  init(): { databasePath: string } {
    const store = this.openStore();
    store.close();
    return { databasePath: this.databasePath };
  }

  add(inputPath: string): { imported: number } {
    const record = this.readImport(inputPath);
    const validation = validateImport(record);
    if (!validation.ok) throw new DomainError(validation.code, validation.message);
    const store = this.openStore();
    try {
      store.import(record);
      return { imported: record.knowledge.length };
    } finally {
      store.close();
    }
  }

  validate(): { valid: true } {
    const store = this.openStore();
    store.close();
    return { valid: true };
  }

  inspect(id: string): KnowledgeEntry | undefined {
    const store = this.openStore();
    try {
      return store.inspect(id as KnowledgeEntry['id']);
    } finally {
      store.close();
    }
  }

  list(filter: LessonFilter = {}): RetrievedKnowledgeEntry[] {
    return this.retrieve({
      ...(filter.scope ? { scope: filter.scope } : {}),
      ...(filter.repositoryId ? { repositoryId: filter.repositoryId } : {}),
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.tag ? { tags: [filter.tag] } : {})
    });
  }

  retrieve(filter: RetrievalFilter): RetrievedKnowledgeEntry[] {
    const store = this.openStore();
    try {
      return store.retrieve(filter);
    } finally {
      store.close();
    }
  }

  export(filter: LessonFilter = {}): { knowledge: RetrievedKnowledgeEntry[] } {
    return { knowledge: this.list(filter) };
  }

  private openStore(): ExperienceStore {
    return new ExperienceStore(this.databasePath);
  }

  private readImport(inputPath: string): ExperienceImport {
    let content: string;
    try {
      content = readFileSync(inputPath, 'utf8');
    } catch (error) {
      throw new DomainError('STORAGE_ERROR', errorMessage(error));
    }
    try {
      return JSON.parse(content) as ExperienceImport;
    } catch {
      throw new DomainError('INVALID_JSON', 'Input file is not valid JSON.');
    }
  }
}

export class DomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
