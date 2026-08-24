import type {
  Evidence,
  KnowledgeEntry,
  KnowledgeState,
  TransitionHistoryEntry,
  TransitionResult
} from './types.js';

const activeStates: readonly KnowledgeState[] = ['candidate', 'observed', 'confirmed', 'verified'];
const terminalStates: readonly KnowledgeState[] = ['superseded', 'rejected', 'expired'];
const normalNext: Partial<Record<KnowledgeState, KnowledgeState>> = {
  candidate: 'observed',
  observed: 'confirmed',
  confirmed: 'verified'
};

export function canTransition(from: KnowledgeState, to: KnowledgeState): boolean {
  if (terminalStates.includes(from) || from === to || from === 'disputed') return false;

  return normalNext[from] === to || (activeStates.includes(from) && ['disputed', 'superseded', 'rejected', 'expired'].includes(to));
}

export function applyTransition(
  entry: KnowledgeEntry,
  evidence: Evidence,
  history: readonly TransitionHistoryEntry[] = []
): TransitionResult {
  if (entry.evidenceIds.includes(evidence.id)) return freezeResult(entry, history);

  const nextState = evidence.polarity === 'contradicts'
    ? 'disputed'
    : entry.state === 'disputed' && evidence.revalidatesTo
      ? evidence.revalidatesTo
      : evidence.polarity === 'confirms'
        ? normalNext[entry.state]
      : undefined;

  if (!nextState || terminalStates.includes(entry.state)) {
    return freezeResult({ ...entry, evidenceIds: [...entry.evidenceIds, evidence.id] }, history);
  }

  const revalidation = entry.state === 'disputed' && Boolean(evidence.revalidatesTo);
  if ((!revalidation && !canTransition(entry.state, nextState)) || (revalidation && evidence.polarity === 'contradicts')) {
    return freezeResult({ ...entry, evidenceIds: [...entry.evidenceIds, evidence.id] }, history);
  }

  return freezeResult(
    { ...entry, state: nextState, evidenceIds: [...entry.evidenceIds, evidence.id] },
    [...history, { from: entry.state, to: nextState, evidenceId: evidence.id }]
  );
}

function freezeResult(entry: KnowledgeEntry, history: readonly TransitionHistoryEntry[]): TransitionResult {
  const frozenEntry = Object.freeze({ ...entry, evidenceIds: Object.freeze([...entry.evidenceIds]) });
  const frozenHistory = Object.freeze(history.map((item) => Object.freeze({ ...item })));

  return Object.freeze({ entry: frozenEntry, history: frozenHistory });
}
