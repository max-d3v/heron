import { errorMessage, isInFlight, type Activity, type Pr, type Review, type ReviewState, type Settings } from "@heron/core";
import type { HeronDb } from "@heron/db";
import { REVIEW_STATUS_CONTEXT, type GitHubClient, type ReviewStatus } from "@heron/github";
import type { Bus } from "./bus.ts";
import type { Store } from "./store.ts";

export interface CommitStatusDeps {
  db: HeronDb;
  store: Store;
  github: GitHubClient;
  settings: () => Settings;
}

/**
 * Mirrors each review onto its head commit as the `heron/review` status, so it shows in
 * the PR's checks box: pending while it runs, success once posted (linking the review),
 * error if it fails or is cancelled. Dry runs post nothing to GitHub, so they set nothing.
 */
export class CommitStatusReporter {
  // One at a time, so a slow "pending" can't land after the "success" that follows it.
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly d: CommitStatusDeps) {}

  /** Every state change is published as a `review.state` activity carrying `{ from, to }`. */
  start(bus: Bus): void {
    bus.subscribe("activity", (a) => this.onActivity(a));
  }

  private onActivity(a: Activity): void {
    if (a.kind !== "review.state" || a.reviewId === null) return;
    const from = a.data?.from as ReviewState | undefined;
    const to = a.data?.to as ReviewState | undefined;
    if (!from || !to) return;

    const review = this.d.db.getReview(a.reviewId);
    const pr = review ? this.d.db.getPr(review.prId) : null;
    const repo = pr ? this.d.db.getRepo(pr.repoId) : null;
    if (!review || !pr || !repo) return;
    // The snapshot is taken just after the first step starts, from these same settings.
    if (review.profileSnapshot?.dryRun ?? this.d.settings().dryRun) return;

    const status = statusFor(review, pr, from, to);
    if (!status) return;
    this.queue = this.queue.then(async () => {
      try {
        await this.d.github.setReviewStatus(repo.owner, repo.name, review.headSha, status);
      } catch (err) {
        this.d.store.activity({
          prId: review.prId,
          reviewId: review.id,
          kind: "review.state",
          message: `Couldn't set the ${REVIEW_STATUS_CONTEXT} check: ${errorMessage(err)}`,
        });
      }
    });
  }
}

function statusFor(review: Review, pr: Pr, from: ReviewState, to: ReviewState): ReviewStatus | null {
  // Leaving the queue, on the first attempt or a retry.
  if (from === "queued" && isInFlight(to)) return { state: "pending", description: "Reviewing…" };
  if (to === "posted") return { state: "success", description: "Review posted", targetUrl: review.githubReviewUrl ?? undefined };
  // Only a review that started has a pending status to replace. Superseded ones are on a
  // commit that is no longer the PR head, and closed PRs don't show their checks.
  if (review.startedAt === null) return null;
  if (to === "failed") return { state: "error", description: "Review failed" };
  if (to === "cancelled" && pr.state === "open") return { state: "error", description: "Review cancelled" };
  return null;
}
