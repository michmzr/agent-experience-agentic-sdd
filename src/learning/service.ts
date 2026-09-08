import { ExperienceStore } from '../storage/experience-store.js';
import { detectOperationalEpisodes } from './detectors.js';
import { readProjectToolConventions } from './project-conventions.js';
import { OperationalLearningRepository, type OperationalLearningReport } from './repository.js';

export class OperationalLearningService {
  constructor(private readonly databasePath: string) {}

  enqueueCommittedSession(repositoryId: string, sessionId: string): void {
    const store = new ExperienceStore(this.databasePath);
    try {
      const records = store.listRepositoryRecords(repositoryId);
      const record = records.find(({ session }) => session.id === sessionId);
      if (!record) return;
      const repository = new OperationalLearningRepository(this.databasePath);
      try { repository.enqueue({ repositoryId, sessionId, inputHighWater: record.events.length }); } finally { repository.close(); }
    } finally { store.close(); }
  }

  runNext(options: { readonly maxEvents?: number } = {}): boolean {
    const repository = new OperationalLearningRepository(this.databasePath);
    try {
      const job = repository.claim();
      if (!job) return false;
      const store = new ExperienceStore(this.databasePath);
      try {
        const records = store.listRepositoryRecords(job.repositoryId);
        const record = records.find(({ session }) => session.id === job.sessionId);
        const registration = store.listRepositories().find(({ id }) => id === job.repositoryId);
        if (!record || !registration) throw new TypeError('Learning job input is unavailable.');
        const maxEvents = options.maxEvents ?? 1024;
        const events = record.events.slice(0, maxEvents);
        const result = detectOperationalEpisodes({ repositoryId: job.repositoryId, sessionId: job.sessionId, events, conventions: readProjectToolConventions(registration.root) });
        repository.saveResult(job.id, result);
        return true;
      } finally { store.close(); }
    } finally { repository.close(); }
  }

  report(repositoryId: string): OperationalLearningReport {
    const repository = new OperationalLearningRepository(this.databasePath);
    try { return repository.report(repositoryId); } finally { repository.close(); }
  }
}
