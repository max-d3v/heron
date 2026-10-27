import { execFile } from "node:child_process";
import {
  LimitError,
  OutputParseError,
  STEP_STATES,
  changeTriggersReview,
  classifyError,
  errorMessage,
  hasReviewForSha,
  isActive,
  isDraftAllowed,
  isEligible,
  isInFlight,
  isTerminal,
  retryDelay,
  type Pr,
  type PrChange,
  type QueueStatus,
  type Repo,
  type Review,
  type ReviewState,
  type ReviewTrigger,
  type Settings,
} from "@heron/core";
import type { HeronDb } from "@heron/db";
import type { GitClient } from "@heron/git";
import { RunAbortedError, killTree } from "@heron/harness";
import type { Bus } from "./bus.ts";
import type { Paths } from "./paths.ts";
import { PrClosedError, SupersededError, type Pipeline } from "./pipeline.ts";
import type { Store } from "./store.ts";

export interface SchedulerDeps {
  db: HeronDb;
  store: Store;
  bus: Bus;
  pipeline: Pipeline;
  git: GitClient;
  paths: Paths;
  settings: () => Settings;
  setSettings: (patch: Partial<Settings>) => void;
  viewerLogin: () => string | null;
  notify: (n: { title: string; body: string; prId: number }) => void;
  requestPoll: () => void;
}

interface ActiveRun {
  ac: AbortController;
  prId: number;
  promise: Promise<void>;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Owns the queue: turns PR changes into owed reviews (§5), runs up to N pipelines
 * at once, retries, pauses, supersedes and recovers after a crash or quit (§6).
 */
export class Scheduler {
  private readonly runs = new Map<number, ActiveRun>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private limitUntil: number | null = null;
  private limitMessage: string | null = null;
  private authMessage: string | null = null;
  private doctorOk = false;
  private lastStatus = "";

  constructor(private readonly d: SchedulerDeps) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.recover();
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** Reviews interrupted mid-step go back to the start of that step; orphaned agents are killed first. */
  private async recover(): Promise<void> {
    for (const r of this.d.db.listReviewsInStates(STEP_STATES)) {
      if (r.pid) await killOrphan(r.pid);
      this.d.db.updateReview(r.id, { pid: null });
      this.d.store.activity({ prId: r.prId, reviewId: r.id, kind: "review.state", message: `Resuming "${r.state}" after restart` });
    }
  }

  get runningCount(): number {
    return this.runs.size;
  }

  /** Quit: abort running reviews (state is kept, so they resume next launch) and wait for them to wind down. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pending = [...this.runs.values()];
    for (const run of pending) run.ac.abort("quit");
    await Promise.allSettled(pending.map((r) => r.promise));
  }

  // ── pause ─────────────────────────────────────────────────────────────────

  setDoctorOk(ok: boolean): void {
    this.doctorOk = ok;
    if (ok && this.authMessage) {
      this.authMessage = null;
      this.d.store.activity({ prId: null, reviewId: null, kind: "queue.resumed", message: "Logged in again; queue resumed" });
    }
    this.tick();
  }

  pauseManual(paused: boolean): void {
    this.d.setSettings({ manualPause: paused });
    this.d.store.activity({
      prId: null,
      reviewId: null,
      kind: paused ? "queue.paused" : "queue.resumed",
      message: paused ? "Paused from the menu" : "Resumed",
    });
    if (!paused) {
      // Resuming by hand also clears a limit pause early (the user may know better).
      this.limitUntil = null;
      this.limitMessage = null;
    }
    this.tick();
  }

  pauseForLimit(until: number, message: string): void {
    if (this.limitUntil && this.limitUntil >= until) return;
    this.limitUntil = until;
    this.limitMessage = message;
    this.d.store.activity({
      prId: null,
      reviewId: null,
      kind: "queue.paused",
      message: `${message}; paused until ${new Date(until).toLocaleTimeString()}`,
      data: { until },
    });
    this.publishStatus();
  }

  pauseForAuth(message: string): void {
    if (this.authMessage === message) return;
    this.authMessage = message;
    this.d.store.activity({ prId: null, reviewId: null, kind: "queue.paused", message });
    this.publishStatus();
  }

  get authProblem(): string | null {
    return this.authMessage;
  }

  status(): QueueStatus {
    const reasons: QueueStatus["reasons"] = [];
    if (this.d.settings().manualPause) reasons.push("manual");
    if (this.limitUntil && this.limitUntil > Date.now()) reasons.push("limit");
    if (this.authMessage) reasons.push("auth");
    if (!this.doctorOk) reasons.push("doctor");
    const counts = this.d.db.countByState();
    let message: string | null = null;
    if (reasons.includes("auth")) message = this.authMessage;
    else if (reasons.includes("limit")) message = `${this.limitMessage ?? "Usage limit"}. Resumes at ${new Date(this.limitUntil!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    else if (reasons.includes("doctor")) message = "Finish setup: git, gh and claude must be installed and logged in";
    else if (reasons.includes("manual")) message = "Paused";
    return {
      paused: reasons.length > 0,
      reasons,
      limitUntil: reasons.includes("limit") ? this.limitUntil : null,
      message,
      running: this.runs.size,
      queued: counts.queued ?? 0,
      debouncing: counts.debouncing ?? 0,
    };
  }

  private publishStatus(): void {
    const s = this.status();
    const key = JSON.stringify(s);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.d.bus.publish("queue", s);
  }

  // ── triggers ──────────────────────────────────────────────────────────────

  /** Apply what the poller saw (after the PR rows were upserted). */
  handleChanges(repo: Repo, changes: PrChange[]): void {
    const { db, store } = this.d;
    const viewer = this.d.viewerLogin();
    const manual = db.getManualPrs(repo.id);

    for (const change of changes) {
      if (change.type === "PrClosed") {
        const pr = db.getPr(change.prev.id);
        if (!pr) continue;
        store.activity({ prId: pr.id, reviewId: null, kind: "pr.closed", message: pr.state === "merged" ? "Merged" : "Closed" });
        this.stopActive(pr.id, "cancelled", `PR ${pr.state}`);
        void this.d.git
          .removeWorktree(this.d.paths.cloneDir(repo.owner, repo.name), this.d.paths.worktreeDir(repo.owner, repo.name, pr.number))
          .catch(() => undefined);
        continue;
      }

      const pr = db.getPr(change.type === "PrObserved" ? this.prIdFor(repo.id, change.pr.number) : change.prev.id);
      if (!pr) continue;

      if (change.type === "PrObserved") {
        store.activity({ prId: pr.id, reviewId: null, kind: "pr.observed", message: `Opened by @${pr.author}` });
      } else if (change.type === "PrReopened") {
        store.activity({ prId: pr.id, reviewId: null, kind: "pr.reopened", message: "Reopened" });
      } else {
        if (change.headChanged) {
          store.activity({
            prId: pr.id,
            reviewId: null,
            kind: "pr.head_changed",
            message: `Pushed ${short(pr.headSha)} (was ${short(change.prev.headSha)})`,
            data: { from: change.prev.headSha, to: pr.headSha },
          });
        }
        if (change.draft) {
          store.activity({
            prId: pr.id,
            reviewId: null,
            kind: "pr.draft_changed",
            message: change.draft === "to_ready" ? "Marked ready for review" : "Converted to draft",
          });
        }
      }

      const headChanged = change.type === "PrObserved" || ("headChanged" in change && change.headChanged);
      if (headChanged) this.supersedeOlder(pr, pr.headSha);
      if (change.type === "PrUpdated" && change.draft === "to_draft" && !isDraftAllowed(repo, pr, manual)) {
        this.stopActive(pr.id, "cancelled", "Converted to draft", ["debouncing", "queued"]);
      }

      if (changeTriggersReview(change) && isEligible(repo, pr, viewer, manual)) this.debounce(pr, "auto");
    }
    this.tick();
  }

  private prIdFor(repoId: number, number: number): number {
    return this.d.db.listPrsForRepo(repoId).find((p) => p.number === number)?.id ?? -1;
  }

  /**
   * Owe a review of the PR's head after the debounce window. A push during the
   * window replaces the pending review, which restarts the window.
   */
  private debounce(pr: Pr, trigger: ReviewTrigger): void {
    const { db, store } = this.d;
    const reviews = db.listReviewsForPr(pr.id);
    const pending = reviews.find((r) => r.headSha === pr.headSha && (r.state === "debouncing" || r.state === "queued"));
    const runAfter = Date.now() + this.d.settings().debounceSec * 1000;
    if (pending) {
      if (pending.state === "debouncing") db.updateReview(pending.id, { runAfter }, ["debouncing"]);
      return;
    }
    if (hasReviewForSha(reviews, pr.headSha)) return;
    const review = db.createReview({ prId: pr.id, headSha: pr.headSha, state: "debouncing", trigger, runAfter });
    const secs = this.d.settings().debounceSec;
    store.activity({
      prId: pr.id,
      reviewId: review.id,
      kind: "review.created",
      message: secs > 0 ? `Review of ${short(pr.headSha)} scheduled in ${formatDelay(secs * 1000)}` : `Review of ${short(pr.headSha)} scheduled`,
    });
  }

  /** A new head: abort and supersede work on older SHAs (explicit re-runs of old SHAs are left alone). */
  private supersedeOlder(pr: Pr, newSha: string): void {
    for (const r of this.d.db.listReviewsForPr(pr.id)) {
      if (!isActive(r.state) || r.headSha === newSha || r.trigger === "rerun") continue;
      this.stop(r, "superseded", `Superseded by ${short(newSha)}`);
    }
  }

  private stopActive(prId: number, to: "cancelled" | "superseded", why: string, only?: ReviewState[]): void {
    for (const r of this.d.db.listReviewsForPr(prId)) {
      if (!isActive(r.state)) continue;
      if (only && !only.includes(r.state)) continue;
      this.stop(r, to, why);
    }
  }

  private stop(review: Review, to: "cancelled" | "superseded", why: string): void {
    const fresh = this.d.db.getReview(review.id);
    if (!fresh || isTerminal(fresh.state)) return;
    this.d.store.transition(fresh, to, { patch: { finishedAt: Date.now(), runAfter: null }, message: why });
    this.runs.get(review.id)?.ac.abort(to);
  }

  // ── manual actions ────────────────────────────────────────────────────────

  reviewNow(prId: number): Review {
    const { db, store } = this.d;
    const pr = db.getPr(prId);
    if (!pr) throw new Error("PR not found");
    if (pr.state !== "open") throw new Error(`PR is ${pr.state}`);
    const existing = db.listReviewsForPr(pr.id).find((r) => r.headSha === pr.headSha && isActive(r.state));
    if (existing) {
      if (existing.state === "debouncing") {
        const r = store.transition(existing, "queued", { patch: { runAfter: Date.now() }, message: "Queued (review now)" });
        this.tick();
        return r ?? existing;
      }
      return existing;
    }
    this.supersedeOlder(pr, pr.headSha);
    const review = db.createReview({ prId: pr.id, headSha: pr.headSha, state: "queued", trigger: "manual", runAfter: Date.now() });
    store.activity({ prId: pr.id, reviewId: review.id, kind: "review.created", message: `Review of ${short(pr.headSha)} requested` });
    this.tick();
    return review;
  }

  rerun(reviewId: number): Review {
    const { db, store } = this.d;
    const old = db.getReview(reviewId);
    if (!old) throw new Error("Review not found");
    const pr = db.getPr(old.prId);
    if (!pr) throw new Error("PR not found");
    if (pr.state !== "open") throw new Error(`PR is ${pr.state}`);
    const active = db.listReviewsForPr(pr.id).find((r) => r.headSha === old.headSha && isActive(r.state));
    if (active) return active;
    const review = db.createReview({ prId: pr.id, headSha: old.headSha, state: "queued", trigger: "rerun", runAfter: Date.now() });
    store.activity({ prId: pr.id, reviewId: review.id, kind: "review.created", message: `Re-run of ${short(old.headSha)} requested` });
    this.tick();
    return review;
  }

  cancel(reviewId: number): void {
    const r = this.d.db.getReview(reviewId);
    if (!r || !isActive(r.state)) return;
    this.stop(r, "cancelled", "Cancelled");
    this.tick();
  }

  /** Hand-picking a PR (manual scope) is a request to review it, so its current head is owed now. */
  onManualPicks(repo: Repo, added: number[]): void {
    const viewer = this.d.viewerLogin();
    const manual = this.d.db.getManualPrs(repo.id);
    for (const pr of this.d.db.listPrsForRepo(repo.id)) {
      if (!added.includes(pr.number) || !isEligible(repo, pr, viewer, manual)) continue;
      if (hasReviewForSha(this.d.db.listReviewsForPr(pr.id), pr.headSha)) continue;
      const review = this.d.db.createReview({ prId: pr.id, headSha: pr.headSha, state: "queued", trigger: "manual", runAfter: Date.now() });
      this.d.store.activity({ prId: pr.id, reviewId: review.id, kind: "review.created", message: `Picked for review (${short(pr.headSha)})` });
    }
    this.tick();
  }

  /** A repo is being removed: stop everything for it. */
  stopRepo(repoId: number): void {
    for (const pr of this.d.db.listPrsForRepo(repoId)) this.stopActive(pr.id, "cancelled", "Repo removed");
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  tick(): void {
    // After shutdown the database is about to close (a run winding down still schedules a tick).
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const { db, store } = this.d;
      const now = Date.now();

      if (this.limitUntil && now >= this.limitUntil) {
        this.limitUntil = null;
        this.limitMessage = null;
        store.activity({ prId: null, reviewId: null, kind: "queue.resumed", message: "Usage limit reset; queue resumed" });
      }

      for (const r of db.listReviewsInStates(["debouncing"])) {
        if ((r.runAfter ?? 0) <= now) store.transition(r, "queued", { patch: { runAfter: now } });
      }

      if (!this.status().paused) {
        const max = this.d.settings().parallelRuns;
        const busyPrs = new Set([...this.runs.values()].map((r) => r.prId));
        // A paused repo starts nothing new (work already running finishes).
        const disabledRepos = new Set(db.listRepos().filter((r) => !r.enabled).map((r) => r.id));
        for (const pr of disabledRepos.size ? db.listOpenPrs() : []) if (disabledRepos.has(pr.repoId)) busyPrs.add(pr.id);
        // Reviews interrupted mid-step (crash/quit) first, then the queue in order.
        const resumable = db.listReviewsInStates(STEP_STATES).filter((r) => !this.runs.has(r.id));
        const queued = db.listReviewsInStates(["queued"]).filter((r) => (r.runAfter ?? 0) <= now);
        for (const r of [...resumable, ...queued]) {
          if (this.runs.size >= max) break;
          // One run per PR at a time: they share the PR's worktree.
          if (busyPrs.has(r.prId)) continue;
          busyPrs.add(r.prId);
          this.startRun(r);
        }
      }
      this.publishStatus();
    } finally {
      this.ticking = false;
    }
  }

  private startRun(review: Review): void {
    const ac = new AbortController();
    const promise = this.d.pipeline
      .execute(review.id, ac.signal)
      .then((final) => this.onFinished(final))
      .catch((err: unknown) => this.onFailure(review.id, err, ac.signal))
      .finally(() => {
        this.runs.delete(review.id);
        this.d.store.prsChanged();
        setImmediate(() => this.tick());
      });
    this.runs.set(review.id, { ac, prId: review.prId, promise });
    this.d.store.prsChanged();
  }

  private onFinished(review: Review | null): void {
    if (!review) return;
    const s = this.d.settings();
    const pr = this.d.db.getPr(review.prId);
    if (!pr) return;
    if (review.state === "posted" && s.notifyPosted) {
      this.d.notify({ title: "Review posted", body: `#${pr.number} ${pr.title}`, prId: pr.id });
    }
    if (review.state === "completed" && s.notifyPosted) {
      this.d.notify({ title: "Review ready (dry run)", body: `#${pr.number} ${pr.title}`, prId: pr.id });
    }
  }

  private onFailure(reviewId: number, err: unknown, signal: AbortSignal): void {
    const { db, store } = this.d;
    const review = db.getReview(reviewId);
    if (!review || isTerminal(review.state)) return; // superseded/cancelled already recorded

    if (err instanceof RunAbortedError || signal.aborted) {
      if (signal.reason === "quit") {
        store.activity({ prId: review.prId, reviewId, kind: "review.state", message: "Interrupted by quit; resumes on next launch" });
      }
      return;
    }

    if (err instanceof SupersededError) {
      store.transition(review, "superseded", { patch: { finishedAt: Date.now() }, message: err.message });
      this.d.requestPoll();
      return;
    }

    if (err instanceof PrClosedError) {
      // Same as when the poller sees it first; the poll then records the merge/close and cleans up.
      store.transition(review, "cancelled", { patch: { finishedAt: Date.now() }, message: `PR ${err.state}` });
      this.d.requestPoll();
      return;
    }

    const message = errorMessage(err);
    const step = isInFlight(review.state) ? review.state : "preparing";
    const cls = classifyError(err);

    if (cls === "limit") {
      const until = err instanceof LimitError ? err.resetAt : Date.now() + 15 * 60_000;
      this.pauseForLimit(until, message);
      store.transition(review, "queued", {
        patch: { retryStep: step, runAfter: until, lastError: message },
        message: `Waiting for the limit to reset (${message})`,
      });
      return;
    }

    if (cls === "auth") {
      this.pauseForAuth(message);
      store.transition(review, "queued", {
        patch: { retryStep: step, runAfter: Date.now(), lastError: message },
        message: `Waiting for login (${message})`,
      });
      return;
    }

    if (cls === "transient") {
      const delay = retryDelay(review.attempt);
      if (delay !== null) {
        const updated = store.transition(review, "queued", {
          patch: { retryStep: step, runAfter: Date.now() + delay, attempt: review.attempt + 1, lastError: message },
          message: `Retrying in ${formatDelay(delay)}: ${message}`,
        });
        if (updated) {
          store.activity({ prId: review.prId, reviewId, kind: "review.retry", message: `Attempt ${review.attempt + 2} in ${formatDelay(delay)}` });
        }
        return;
      }
    }

    const failed = store.transition(review, "failed", {
      patch: {
        lastError: message,
        finishedAt: Date.now(),
        ...(err instanceof OutputParseError && err.raw ? { rawOutput: err.raw } : {}),
      },
      message: `Failed: ${message}`,
    });
    if (failed) {
      store.activity({ prId: review.prId, reviewId, kind: "review.error", message, data: { step } });
      const pr = db.getPr(review.prId);
      if (pr && this.d.settings().notifyFailed) {
        this.d.notify({ title: "Review failed", body: `#${pr.number} ${pr.title}: ${message.slice(0, 120)}`, prId: pr.id });
      }
    }
  }
}

function formatDelay(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;
}

/** Kill a leftover agent from a previous session, if that pid is still a claude process. */
async function killOrphan(pid: number): Promise<void> {
  const command = await new Promise<string>((resolve) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "command="], (err, stdout) => resolve(err ? "" : String(stdout)));
  });
  if (!/claude/i.test(command)) return;
  killTree(pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  killTree(pid, "SIGKILL");
}
