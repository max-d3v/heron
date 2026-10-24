import { STATE_LABELS, canTransition, type Activity, type AgentStep, type Review, type ReviewState } from "@heron/core";
import type { HeronDb, NewActivity, ReviewPatch } from "@heron/db";
import type { Bus } from "./bus.ts";

/**
 * Every state change goes through here: the row update and its `activity` entry are
 * written in one transaction, then published on the bus for the live UI.
 */
export class Store {
  private prsTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly db: HeronDb,
    private readonly bus: Bus,
  ) {}

  /** Coalesce PR-list notifications (a poll can touch many rows at once). */
  prsChanged(): void {
    if (this.prsTimer) return;
    this.prsTimer = setTimeout(() => {
      this.prsTimer = null;
      this.bus.publish("prs", { at: Date.now() });
    }, 50);
  }

  activity(a: NewActivity): Activity {
    const entry = this.db.appendActivity(a);
    this.bus.publish("activity", entry);
    this.prsChanged();
    return entry;
  }

  /**
   * Move a review to `to`. Applies only if the row is still in `from` (default: the
   * state we last saw), so a concurrent supersede/cancel wins. Returns null otherwise.
   */
  transition(
    review: Review,
    to: ReviewState,
    opts: { patch?: ReviewPatch; message?: string; from?: readonly ReviewState[]; data?: Record<string, unknown> } = {},
  ): Review | null {
    const from = opts.from ?? [review.state];
    if (!from.some((s) => canTransition(s, to))) return null;
    let activity: Activity | null = null;
    const updated = this.db.tx(() => {
      const row = this.db.updateReview(review.id, { ...opts.patch, state: to }, from);
      if (!row) return null;
      activity = this.db.appendActivity({
        prId: review.prId,
        reviewId: review.id,
        kind: "review.state",
        message: opts.message ?? STATE_LABELS[to],
        data: { from: review.state, to, ...opts.data },
      });
      return row;
    });
    if (activity) this.bus.publish("activity", activity);
    if (updated) this.prsChanged();
    return updated;
  }

  /** Save step output without changing state (still guarded by the expected state). */
  save(review: Review, patch: ReviewPatch): Review | null {
    const row = this.db.updateReview(review.id, patch, [review.state]);
    return row;
  }

  step(review: Pick<Review, "id" | "prId">, step: AgentStep): void {
    const entry = this.db.appendActivity({
      prId: review.prId,
      reviewId: review.id,
      kind: "agent.step",
      message: step.label,
      data: { kind: step.kind, ...(step.detail ? { detail: step.detail.slice(0, 4000) } : {}) },
    });
    this.bus.publish("step", { id: entry.id, reviewId: review.id, ts: entry.ts, step });
    this.bus.publish("activity", entry);
  }
}
