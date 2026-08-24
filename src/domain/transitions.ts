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
  if (terminalStates.includes(from) || from === to) return false;
  if (from === 'disputed') return ['observed', 'confirmed', 'verified'].includes(to);

  return normalNext[from] === to || (activeStates.includes(from) && ['disputed', 'superseded', 'rejected', 'expired'].includes(to));
}

export function applyTransition(
  entry: KnowledgeEntry,
  evidence: Evidence,
  history: readonly TransitionHistoryEntry[] = [],
  target?: KnowledgeState
): TransitionResult {
  if (evidence.candidateId !== entry.candidateId || entry.evidenceIds.includes(evidence.id)) return freezeResult(entry, history);
  if (evidence.polarity === 'contradicts' && (evidence.revalidatesTo || (target !== undefined && target !== 'disputed'))) {
    return freezeResult(entry, history);
  }

  const nextState = target ?? automaticTarget(entry, evidence);

  if (!nextState || !canTransition(entry.state, nextState)) {
    return freezeResult({ ...entry, evidenceIds: [...entry.evidenceIds, evidence.id] }, history);
  }

  if (entry.state === 'disputed' && evidence.revalidatesTo !== nextState) {
    return freezeResult({ ...entry, evidenceIds: [...entry.evidenceIds, evidence.id] }, history);
  }

  return freezeResult(
    { ...entry, state: nextState, evidenceIds: [...entry.evidenceIds, evidence.id] },
    [...history, { from: entry.state, to: nextState, evidenceId: evidence.id }]
  );
}

function automaticTarget(entry: KnowledgeEntry, evidence: Evidence): KnowledgeState | undefined {
  if (evidence.polarity === 'contradicts') return 'disputed';
  if (entry.state === 'disputed') return evidence.revalidatesTo;
  if (evidence.polarity === 'confirms') return normalNext[entry.state];

  return undefined;
}

function freezeResult(entry: KnowledgeEntry, history: readonly TransitionHistoryEntry[]): TransitionResult {
  const frozenEntry = Object.freeze({ ...entry, evidenceIds: Object.freeze([...entry.evidenceIds]) });
  const frozenHistory = Object.freeze(history.map((item) => Object.freeze({ ...item })));

  return Object.freeze({ entry: frozenEntry, history: frozenHistory });
}
