import {
  ITERATION_STATE_LABELS,
  STATE_LABELS,
  canIterationTransition,
  canTransition,
  type Activity,
  type AgentStep,
  type Iteration,
  type IterationState,
  type Review,
  type ReviewState,
} from "@heron/core";
import type { HeronDb, IterationPatch, NewActivity, ReviewPatch } from "@heron/db";
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

  step(review: Review, step: AgentStep): void {
    const entry = this.db.appendActivity({
      prId: review.prId,
      reviewId: review.id,
      kind: "agent.step",
      message: step.label,
      data: { kind: step.kind, ...(step.detail ? { detail: step.detail.slice(0, 4000) } : {}) },
    });
    this.bus.publish("step", { id: entry.id, reviewId: review.id, iterationId: null, ts: entry.ts, step });
    this.bus.publish("activity", entry);
  }

  /**
   * Move an iteration to `to`, like `transition` for reviews. Reaching `pushed`, `no_changes`,
   * `discarded` or `uncommitted` marks the comments it took on as handled, and leaving `pushing` for
   * `replying` (the push went through) counts toward the PR's loop cap, in the same transaction.
   */
  transitionIteration(
    it: Iteration,
    to: IterationState,
    opts: { patch?: IterationPatch; message?: string; from?: readonly IterationState[]; data?: Record<string, unknown> } = {},
  ): Iteration | null {
    const from = opts.from ?? [it.state];
    if (!from.some((s) => canIterationTransition(s, to))) return null;
    let activity: Activity | null = null;
    const updated = this.db.tx(() => {
      const row = this.db.updateIteration(it.id, { ...opts.patch, state: to }, from);
      if (!row) return null;
      if (to === "pushed" || to === "no_changes" || to === "discarded" || to === "uncommitted") this.db.handleIterationFeedback(it.id, Date.now());
      if (it.state === "pushing" && to === "replying") {
        const pr = this.db.getPr(it.prId);
        if (pr) this.db.updatePr(pr.id, { heronPushStreak: pr.heronPushStreak + 1 });
      }
      activity = this.db.appendActivity({
        prId: it.prId,
        reviewId: null,
        iterationId: it.id,
        kind: "iteration.state",
        message: opts.message ?? ITERATION_STATE_LABELS[to],
        data: { from: it.state, to, ...opts.data },
      });
      return row;
    });
    if (activity) this.bus.publish("activity", activity);
    if (updated) this.prsChanged();
    return updated;
  }

  /** Save step output without changing state (still guarded by the expected state). */
  saveIteration(it: Iteration, patch: IterationPatch): Iteration | null {
    return this.db.updateIteration(it.id, patch, [it.state]);
  }

  iterationStep(it: Iteration, step: AgentStep): void {
    const entry = this.db.appendActivity({
      prId: it.prId,
      reviewId: null,
      iterationId: it.id,
      kind: "agent.step",
      message: step.label,
      data: { kind: step.kind, ...(step.detail ? { detail: step.detail.slice(0, 4000) } : {}) },
    });
    this.bus.publish("step", { id: entry.id, reviewId: null, iterationId: it.id, ts: entry.ts, step });
    this.bus.publish("activity", entry);
  }
}
