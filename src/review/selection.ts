export interface RepositorySessionDescriptor {
  readonly id: string;
  readonly repositoryHint?: string;
  readonly repositoryHintVerified?: boolean;
  readonly updatedAt?: string;
}

export interface ReviewSelectionPrompt {
  choose(sessions: readonly RepositorySessionDescriptor[]): Promise<string | undefined>;
  confirm(session: RepositorySessionDescriptor): Promise<boolean>;
}

export interface ReviewSelectionRequest {
  readonly session?: string;
  readonly interactive: boolean;
  readonly repository?: string;
}

export async function selectRepositorySession(
  sessions: readonly RepositorySessionDescriptor[],
  request: ReviewSelectionRequest,
  prompt: ReviewSelectionPrompt | undefined
): Promise<string> {
  if (request.session && request.session !== 'latest') return request.session;
  if (!request.interactive || !request.repository) {
    throw new SyntaxError('Interactive repository scope is required for session selection.');
  }
  if (!prompt) throw new Error('Interactive session selection requires a prompt boundary.');

  const scoped = sessions.filter((session) => session.repositoryHintVerified === true && session.repositoryHint === request.repository);
  if (scoped.length === 0) throw new Error('No verified repository-scoped sessions were found.');

  const selected = request.session === 'latest'
    ? latest(scoped)
    : await selectedFromPrompt(scoped, prompt);
  if (!await prompt.confirm(selected)) throw new Error('Session selection was not confirmed.');
  return selected.id;
}

function latest(sessions: readonly RepositorySessionDescriptor[]): RepositorySessionDescriptor {
  const dated = sessions.filter((session): session is RepositorySessionDescriptor & { updatedAt: string } => typeof session.updatedAt === 'string' && Number.isFinite(Date.parse(session.updatedAt)));
  if (dated.length === 0) throw new Error('No verified repository-scoped sessions have recency metadata.');
  return [...dated].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))[0]!;
}

async function selectedFromPrompt(sessions: readonly RepositorySessionDescriptor[], prompt: ReviewSelectionPrompt): Promise<RepositorySessionDescriptor> {
  const selectedId = await prompt.choose(sessions);
  const selected = sessions.find((session) => session.id === selectedId);
  if (!selected) throw new Error('Interactive session selection was not found.');
  return selected;
}
