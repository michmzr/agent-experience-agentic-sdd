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
  history: TransitionHistoryEntry[] = []
): TransitionResult {
  const nextState = evidence.polarity === 'contradicts'
    ? 'disputed'
    : entry.state === 'disputed' && evidence.revalidatesTo
      ? evidence.revalidatesTo
      : evidence.polarity === 'confirms'
        ? normalNext[entry.state]
      : undefined;

  if (!nextState || terminalStates.includes(entry.state)) {
    return { entry: { ...entry, evidenceIds: [...entry.evidenceIds, evidence.id] }, history: [...history] };
  }

  const revalidation = entry.state === 'disputed' && Boolean(evidence.revalidatesTo);
  if ((!revalidation && !canTransition(entry.state, nextState)) || (revalidation && evidence.polarity === 'contradicts')) {
    return { entry: { ...entry, evidenceIds: [...entry.evidenceIds, evidence.id] }, history: [...history] };
  }

  return {
    entry: { ...entry, state: nextState, evidenceIds: [...entry.evidenceIds, evidence.id] },
    history: [...history, { from: entry.state, to: nextState, evidenceId: evidence.id }]
  };
}
