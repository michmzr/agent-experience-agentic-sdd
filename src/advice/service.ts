import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCliContext } from '../cli/context.js';
import { CandidateRepository } from '../knowledge/candidate-repository.js';
import { AdvisoryConfigurationStore } from './configuration.js';
import { selectLocalAdvice, type AdviceContext, type VerifiedAdviceEntry } from './selection.js';
import { AdvisoryUsageStore } from './usage.js';

export interface AdviceRequest extends AdviceContext {
  readonly sessionId: string;
  readonly retrievalRef: string;
}

export function retrieveLocalAdvice(dataDir: string, workingDirectory: string, context: AdviceRequest) {
  const actualRepository = resolveCliContext(workingDirectory);
  if (!actualRepository || actualRepository.id !== context.repositoryId) return empty('unavailable');
  const started = Date.now();
  try {
    const configuration = new AdvisoryConfigurationStore(join(dataDir, 'advice.sqlite'));
    if (!configuration.status(context.repositoryId).enabled) return empty('disabled');
    const experiencePath = join(dataDir, 'experience.sqlite');
    if (!existsSync(experiencePath)) return empty('unavailable');
    const repository = new CandidateRepository(experiencePath);
    let verified;
    try { verified = repository.listVerifiedLocalEntries(context.repositoryId); }
    finally { repository.close(); }
    const candidates: VerifiedAdviceEntry[] = verified.map(entry => ({
      candidateId: entry.candidateId, revision: String(entry.revision), repositoryId: entry.repositoryId,
      kind: entry.kind, statement: entry.statement, applicability: entry.applicability,
      operationSignature: entry.operationSignature, contextRevision: entry.contextRevision,
      evidenceRefs: [entry.verificationEvidenceId], state: entry.state, contradictionState: entry.contradictionState
    }));
    const selection = selectLocalAdvice(candidates, context, { deadline: started + 200 });
    if (selection.status !== 'ready') return empty('unavailable');
    const usage = new AdvisoryUsageStore(join(dataDir, 'advice.sqlite'));
    const projected: Array<Record<string, unknown>> = [];
    for (const entry of selection.entries) {
      const item = { candidateId: entry.candidateId, revision: entry.revision, kind: entry.kind,
        statement: entry.statement, applicability: entry.applicability, evidenceRefs: entry.evidenceRefs,
        invalidationConditions: ['context-revision-changed', 'candidate-revised-or-disputed'],
        bundleId: `advice-use:${'0'.repeat(64)}` };
      if (Buffer.byteLength(JSON.stringify({ status: 'ready', entries: [...projected, item] }), 'utf8') > 4096) continue;
      if (Date.now() > started + 200 || !configuration.status(context.repositoryId).enabled) return empty('unavailable');
      const bundle = usage.retrieved({ repositoryId: context.repositoryId, lessonId: entry.candidateId,
        lessonRevision: entry.revision, sessionId: context.sessionId, contextRevision: context.contextRevision,
        operationSignature: context.operationSignature, retrievalRef: context.retrievalRef });
      projected.push(Object.freeze({ ...item, bundleId: bundle.id }));
    }
    if (Date.now() > started + 200) return empty('unavailable');
    return Object.freeze({ status: 'ready' as const, entries: Object.freeze(projected) });
  } catch {
    return empty('unavailable');
  }
}

function empty(status: 'disabled' | 'unavailable') {
  return Object.freeze({ status, entries: Object.freeze([]) });
}
