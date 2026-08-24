import { assertSanitizedReviewArtifact, type SanitizedReviewArtifact } from './sanitizer.js';

export interface ReviewFinding {
  readonly code: string;
  readonly [attribute: string]: string;
}

export interface Reviewer {
  readonly id: string;
  readonly expensive: boolean;
  review(artifact: SanitizedReviewArtifact): Promise<readonly ReviewFinding[]>;
}

export interface ReviewProfile {
  readonly id: string;
  readonly version: string;
  readonly reviewerIds: readonly string[];
}

export interface ReviewRuntimeOptions {
  readonly profiles: readonly ReviewProfile[];
  readonly reviewers: readonly Reviewer[];
}

export interface RunReviewInput {
  readonly artifact: SanitizedReviewArtifact;
  readonly profile: Pick<ReviewProfile, 'id' | 'version'>;
  readonly allowExpensiveChecks: boolean;
}

export interface ReviewerResult {
  readonly reviewerId: string;
  readonly findings: readonly ReviewFinding[];
}

export interface ReviewRun {
  readonly profile: Pick<ReviewProfile, 'id' | 'version'>;
  readonly results: readonly ReviewerResult[];
  readonly skippedReviewerIds: readonly string[];
}

export class ReviewRuntime {
  readonly #profiles: ReadonlyMap<string, ReviewProfile>;
  readonly #reviewers: ReadonlyMap<string, Reviewer>;

  constructor(options: ReviewRuntimeOptions) {
    this.#profiles = indexBy(options.profiles, (profile) => profileKey(profile), 'review profile');
    this.#reviewers = indexBy(options.reviewers, (reviewer) => reviewer.id, 'reviewer');
  }

  async run(input: RunReviewInput): Promise<ReviewRun> {
    assertSanitizedReviewArtifact(input.artifact);
    const profile = this.#profiles.get(profileKey(input.profile));
    if (!profile) throw new Error(`Review profile ${input.profile.id}@${input.profile.version} was not found.`);

    const selected = profile.reviewerIds.map((reviewerId) => {
      const reviewer = this.#reviewers.get(reviewerId);
      if (!reviewer) throw new Error(`Reviewer ${reviewerId} configured by profile ${profile.id}@${profile.version} was not found.`);
      return reviewer;
    });
    const runnable = selected.filter((reviewer) => input.allowExpensiveChecks || !reviewer.expensive);
    const skippedReviewerIds = selected.filter((reviewer) => !input.allowExpensiveChecks && reviewer.expensive).map((reviewer) => reviewer.id);
    const results = await Promise.all(runnable.map(async (reviewer) => ({ reviewerId: reviewer.id, findings: await reviewer.review(input.artifact) })));

    return { profile: { id: profile.id, version: profile.version }, results, skippedReviewerIds };
  }
}

function profileKey(profile: Pick<ReviewProfile, 'id' | 'version'>): string {
  return `${profile.id}@${profile.version}`;
}

function indexBy<T>(items: readonly T[], getKey: (item: T) => string, itemName: string): ReadonlyMap<string, T> {
  const indexed = new Map<string, T>();
  for (const item of items) {
    const key = getKey(item);
    if (indexed.has(key)) throw new Error(`Duplicate ${itemName}: ${key}.`);
    indexed.set(key, item);
  }
  return indexed;
}
