import type { DatabaseSync } from 'node:sqlite';

import { openExperienceDatabase } from '../storage/database.js';
import { createLearningCandidate, createOperationalEpisode, type LearningCandidate, type OperationalEpisode, type OperationalFinding } from './contracts.js';

const schema = `
  CREATE TABLE IF NOT EXISTS operational_analysis_jobs (
    id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, input_high_water INTEGER NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(repository_id, session_id, input_high_water)
  );
  CREATE TABLE IF NOT EXISTS operational_episodes (
    id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector TEXT NOT NULL, state TEXT NOT NULL,
    evidence_json TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_findings (
    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES operational_episodes(id), kind TEXT NOT NULL, evidence_json TEXT NOT NULL, statement TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_candidates (
    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES operational_episodes(id), kind TEXT NOT NULL, state TEXT NOT NULL,
    statement TEXT NOT NULL, conditions_json TEXT NOT NULL, procedure_json TEXT NOT NULL, invalidation_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_candidate_evidence (
    candidate_id TEXT NOT NULL REFERENCES operational_candidates(id), event_id TEXT NOT NULL, polarity TEXT NOT NULL,
    PRIMARY KEY(candidate_id, event_id)
  );
`;

export interface AnalysisJob { readonly id: string; readonly repositoryId: string; readonly sessionId: string; readonly inputHighWater: number; readonly state: 'pending' | 'running' | 'completed' | 'retryable-failure' | 'quarantined-input'; readonly attempts: number; }
export interface LearningResult { readonly episodes: readonly OperationalEpisode[]; readonly findings: readonly OperationalFinding[]; readonly candidates: readonly LearningCandidate[]; }
export interface OperationalLearningReport { readonly candidates: readonly (Omit<LearningCandidate, 'state'> & { readonly state: 'candidate' | 'disputed' })[]; readonly findings: readonly OperationalFinding[]; readonly episodes: readonly OperationalEpisode[]; }

export class OperationalLearningRepository {
  private readonly database: DatabaseSync;
  constructor(databasePath?: string, private readonly now: () => string = () => new Date().toISOString()) { this.database = openExperienceDatabase(databasePath); this.database.exec(schema); }
  close(): void { this.database.close(); }

  enqueue(input: { readonly repositoryId: string; readonly sessionId: string; readonly inputHighWater: number }): AnalysisJob {
    const id = `${input.repositoryId}:${input.sessionId}:${input.inputHighWater}`;
    const timestamp = this.now();
    this.database.prepare(`INSERT INTO operational_analysis_jobs (id, repository_id, session_id, input_high_water, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(repository_id, session_id, input_high_water) DO NOTHING`).run(id, input.repositoryId, input.sessionId, input.inputHighWater, timestamp, timestamp);
    return this.job(this.database.prepare(`SELECT id, repository_id, session_id, input_high_water, state, attempts FROM operational_analysis_jobs WHERE repository_id = ? AND session_id = ? AND input_high_water = ?`).get(input.repositoryId, input.sessionId, input.inputHighWater));
  }

  claim(): AnalysisJob | undefined {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(`SELECT id, repository_id, session_id, input_high_water, state, attempts FROM operational_analysis_jobs WHERE state IN ('pending', 'retryable-failure') ORDER BY created_at, id LIMIT 1`).get();
      if (!row) { this.database.exec('COMMIT'); return undefined; }
      this.database.prepare(`UPDATE operational_analysis_jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(this.now(), (row as { id: string }).id);
      const claimed = this.job(this.database.prepare(`SELECT id, repository_id, session_id, input_high_water, state, attempts FROM operational_analysis_jobs WHERE id = ?`).get((row as { id: string }).id));
      this.database.exec('COMMIT'); return claimed;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  retry(jobId: string, reason: 'execution-failure' | 'timeout' | 'invalid-input' = 'execution-failure'): void {
    const job = this.jobById(jobId);
    if (!job || job.state !== 'running') throw new TypeError('Analysis job is not running.');
    const state = reason === 'invalid-input' || job.attempts >= 4 ? 'quarantined-input' : 'retryable-failure';
    this.database.prepare(`UPDATE operational_analysis_jobs SET state = ?, updated_at = ? WHERE id = ?`).run(state, this.now(), jobId);
  }

  jobById(id: string): AnalysisJob | undefined {
    const row = this.database.prepare(`SELECT id, repository_id, session_id, input_high_water, state, attempts FROM operational_analysis_jobs WHERE id = ?`).get(id);
    return row === undefined ? undefined : this.job(row);
  }

  saveResult(jobId: string, result: LearningResult): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const job = this.job(this.database.prepare(`SELECT id, repository_id, session_id, input_high_water, state, attempts FROM operational_analysis_jobs WHERE id = ?`).get(jobId));
      if (job.state !== 'running') throw new TypeError('Analysis job is not running.');
      for (const rawEpisode of result.episodes) {
        const episode = createOperationalEpisode(rawEpisode);
        if (episode.repositoryId !== job.repositoryId || episode.sessionId !== job.sessionId) throw new TypeError('Episode scope conflicts with job.');
        this.database.prepare(`INSERT INTO operational_episodes (id, repository_id, session_id, detector, state, evidence_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, evidence_json = excluded.evidence_json, payload_json = excluded.payload_json`).run(episode.id, job.repositoryId, job.sessionId, episode.detector, episode.state, JSON.stringify(episode.evidenceEventIds), JSON.stringify(episode));
      }
      for (const finding of result.findings) this.database.prepare(`INSERT INTO operational_findings (id, episode_id, kind, evidence_json, statement) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(finding.id, finding.episodeId, finding.kind, JSON.stringify(finding.evidenceEventIds), finding.statement);
      for (const rawCandidate of result.candidates) {
        const candidate = createLearningCandidate(rawCandidate);
        this.database.prepare(`INSERT INTO operational_candidates (id, episode_id, kind, state, statement, conditions_json, procedure_json, invalidation_json) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(candidate.id, candidate.episodeId, candidate.kind, candidate.statement, JSON.stringify(candidate.conditions), JSON.stringify(candidate.procedure), JSON.stringify(candidate.invalidationConditions));
        for (const eventId of candidate.evidenceEventIds) this.database.prepare(`INSERT OR IGNORE INTO operational_candidate_evidence (candidate_id, event_id, polarity) VALUES (?, ?, 'confirms')`).run(candidate.id, eventId);
      }
      this.database.prepare(`UPDATE operational_analysis_jobs SET state = 'completed', updated_at = ? WHERE id = ?`).run(this.now(), jobId);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  contradict(candidateId: string, eventId: string): void { this.database.prepare(`INSERT OR IGNORE INTO operational_candidate_evidence (candidate_id, event_id, polarity) VALUES (?, ?, 'contradicts')`).run(candidateId, eventId); this.database.prepare(`UPDATE operational_candidates SET state = 'disputed' WHERE id = ?`).run(candidateId); }

  report(repositoryId: string): OperationalLearningReport {
    const episodes = (this.database.prepare(`SELECT payload_json FROM operational_episodes WHERE repository_id = ? ORDER BY id`).all(repositoryId) as Array<{ payload_json: string }>).map(({ payload_json }) => JSON.parse(payload_json) as OperationalEpisode);
    const findings = (this.database.prepare(`SELECT f.id, f.episode_id, f.kind, f.evidence_json, f.statement FROM operational_findings f JOIN operational_episodes e ON e.id = f.episode_id WHERE e.repository_id = ? ORDER BY f.id`).all(repositoryId) as Array<{ id: string; episode_id: string; kind: OperationalFinding['kind']; evidence_json: string; statement: string }>).map((row) => Object.freeze({ id: row.id, episodeId: row.episode_id, kind: row.kind, evidenceEventIds: Object.freeze(JSON.parse(row.evidence_json) as string[]), statement: row.statement }));
    const candidates = (this.database.prepare(`SELECT c.id, c.episode_id, c.kind, c.state, c.statement, c.conditions_json, c.procedure_json, c.invalidation_json FROM operational_candidates c JOIN operational_episodes e ON e.id = c.episode_id WHERE e.repository_id = ? ORDER BY c.id`).all(repositoryId) as Array<{ id: string; episode_id: string; kind: LearningCandidate['kind']; state: 'candidate' | 'disputed'; statement: string; conditions_json: string; procedure_json: string; invalidation_json: string }>).map((row) => Object.freeze({ id: row.id, episodeId: row.episode_id, kind: row.kind, state: row.state, statement: row.statement, conditions: Object.freeze(JSON.parse(row.conditions_json) as string[]), procedure: Object.freeze(JSON.parse(row.procedure_json) as string[]), evidenceEventIds: Object.freeze((this.database.prepare(`SELECT event_id FROM operational_candidate_evidence WHERE candidate_id = ? ORDER BY event_id`).all(row.id) as Array<{ event_id: string }>).map(({ event_id }) => event_id)), invalidationConditions: Object.freeze(JSON.parse(row.invalidation_json) as string[]) }));
    return Object.freeze({ episodes: Object.freeze(episodes), findings: Object.freeze(findings), candidates: Object.freeze(candidates) });
  }

  private job(row: unknown): AnalysisJob { if (!row) throw new TypeError('Analysis job was not found.'); const value = row as { id: string; repository_id: string; session_id: string; input_high_water: number; state: AnalysisJob['state']; attempts: number }; return Object.freeze({ id: value.id, repositoryId: value.repository_id, sessionId: value.session_id, inputHighWater: value.input_high_water, state: value.state, attempts: value.attempts }); }
}
