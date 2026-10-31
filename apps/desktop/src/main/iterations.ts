import { appendFile, readFile } from "node:fs/promises";
import {
  ITERATION_STEP_STATES,
  LimitError,
  OutputParseError,
  classifyError,
  errorMessage,
  feedbackCounts,
  isIterationActive,
  isIterationInFlight,
  isIterationTerminal,
  iterationEligibility,
  needsSlot,
  occupiesPr,
  retryDelay,
  type Feedback,
  type Iteration,
  type PauseReason,
  type Pr,
  type PrChange,
  type Repo,
  type Settings,
  type TriageVerdict,
} from "@heron/core";
import type { HeronDb } from "@heron/db";
import type { GitClient } from "@heron/git";
import type { GitHubClient } from "@heron/github";
import { RunAbortedError } from "@heron/harness";
import { groupKey } from "./feedback.ts";
import { StaleError, type IterationPipeline } from "./iteration-pipeline.ts";
import type { Paths } from "./paths.ts";
import { PrClosedError } from "./pipeline.ts";
import { formatDelay, killOrphan } from "./scheduler.ts";
import type { Store } from "./store.ts";

/** What iterations share with the review queue: its pauses and its parallel-run slots. */
export interface QueueControl {
  pauseReasons(): PauseReason[];
  pauseForLimit(until: number, message: string): void;
  pauseForAuth(message: string): void;
  /** Review runs holding a parallel-run slot. */
  reviewRuns(): number;
}

export interface IterationSchedulerDeps {
  db: HeronDb;
  store: Store;
  pipeline: IterationPipeline;
  github: GitHubClient;
  git: GitClient;
  paths: Paths;
  settings: () => Settings;
  viewerLogin: () => string | null;
  notify: (n: { title: string; body: string; prId: number; tab?: "iteration" }) => void;
  requestPoll: () => void;
  queue: QueueControl;
}

interface ActiveRun {
  ac: AbortController;
  prId: number;
  promise: Promise<void>;
  /** Holds a parallel-run slot (preparing, running, committing). */
  slot: boolean;
}

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Owns iterations (§15): keeps each eligible PR's comments in `feedback`, batches the
 * unhandled ones after a debounce, triages them, and runs the agent, commit, push and
 * replies through the pipeline. Shares the review queue's pauses and parallel-run slots;
 * triage doesn't take a slot.
 */
export class IterationScheduler {
  private readonly runs = new Map<number, ActiveRun>();
  private readonly triages = new Map<number, ActiveRun>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private syncing: Promise<void> | null = null;
  /** After a failed comment fetch, when to try that PR again. */
  private readonly syncRetryAt = new Map<number, number>();

  constructor(private readonly d: IterationSchedulerDeps) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.recover();
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** Steps interrupted by a crash or quit resume (a run starts over from a clean checkout); triage runs again. */
  private async recover(): Promise<void> {
    const { db, store } = this.d;
    for (const it of db.listIterationsInStates(ITERATION_STEP_STATES)) {
      if (it.pid) await killOrphan(it.pid);
      db.updateIteration(it.id, { pid: null });
      store.activity({ prId: it.prId, reviewId: null, iterationId: it.id, kind: "iteration.state", message: `Resuming "${it.state}" after restart` });
    }
    for (const it of db.listIterationsInStates(["triaging"])) {
      if (it.pid) await killOrphan(it.pid);
      store.transitionIteration(it, "debouncing", { patch: { pid: null, runAfter: Date.now() }, message: "Triage was interrupted; it runs again" });
    }
  }

  /** Agent runs in progress (pushes included). */
  get runningCount(): number {
    return this.runs.size;
  }

  /** Parallel-run slots iterations hold. */
  get slotCount(): number {
    return [...this.runs.values()].filter((r) => r.slot).length;
  }

  readyToPush(): number {
    return this.d.db.countIterationsByState().ready ?? 0;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pending = [...this.runs.values(), ...this.triages.values()];
    for (const run of pending) run.ac.abort("quit");
    await Promise.allSettled([...pending.map((r) => r.promise), this.syncing ?? Promise.resolve()]);
  }

  // ── eligibility and batches ───────────────────────────────────────────────

  /** The PR's repo when iterations run on the PR (§15.1). */
  private eligibleRepo(pr: Pr): Repo | null {
    const repo = this.d.db.getRepo(pr.repoId);
    if (!repo) return null;
    return iterationEligibility(repo, pr, this.d.viewerLogin()).ok ? repo : null;
  }

  /** Is the PR taken by an iteration between queued and replying (other than `except`)? */
  private occupied(prId: number, except?: number): boolean {
    return this.d.db.listIterationsForPr(prId).some((i) => i.id !== except && occupiesPr(i.state));
  }

  /** Unhandled comments that count under the repo's iteration comments and no live iteration has claimed. */
  private candidates(pr: Pr, repo: Repo): Feedback[] {
    const { db } = this.d;
    const viewer = this.d.viewerLogin();
    const live = new Set(db.listIterationsForPr(pr.id).filter((i) => isIterationActive(i.state)).map((i) => i.id));
    return db
      .listFeedbackForPr(pr.id, "unhandled")
      .filter((f) => (f.iterationId === null || !live.has(f.iterationId)) && feedbackCounts(repo.iterationComments, f.author, viewer));
  }

  /**
   * Owe a triage batch `iterationDebounceSec` after the newest new comment; another comment resets
   * the wait. Only never-claimed comments start one: those left by a failed or cancelled iteration
   * just join the next batch, so a failure doesn't loop.
   */
  plan(prId: number): void {
    const { db, store } = this.d;
    const pr = db.getPr(prId);
    if (!pr) return;
    const repo = this.eligibleRepo(pr);
    const debouncing = db.listIterationsForPr(pr.id).find((i) => i.state === "debouncing");
    const fresh = repo?.iterationEnabled ? this.candidates(pr, repo).filter((f) => f.iterationId === null) : [];
    if (fresh.length === 0) {
      // Iterations were turned off, or the comments setting changed so the ones it was waiting for no longer count.
      // A triage retry keeps its claimed rows.
      if (debouncing && db.listFeedbackForIteration(debouncing.id).length === 0) {
        this.stop(debouncing, repo && !repo.iterationEnabled ? "Iterations turned off" : "No comments left to triage");
      }
      return;
    }
    const runAfter = Math.max(...fresh.map((f) => f.createdAt)) + this.d.settings().iterationDebounceSec * 1000;
    if (debouncing) {
      db.updateIteration(debouncing.id, { runAfter: Math.max(debouncing.runAfter ?? 0, runAfter) }, ["debouncing"]);
      store.prsChanged();
      return;
    }
    const it = db.createIteration({ prId: pr.id, state: "debouncing", trigger: "feedback", runAfter, transcriptPath: this.d.paths.iterationTranscript });
    store.activity({ prId: pr.id, reviewId: null, iterationId: it.id, kind: "iteration.created", message: `Triage of ${plural(fresh.length, "comment")} scheduled` });
  }

  /** The repo's iteration settings changed: re-plan its open PRs. */
  replanRepo(repoId: number): void {
    for (const pr of this.d.db.listPrsForRepo(repoId)) if (pr.state === "open") this.plan(pr.id);
    this.tick();
  }

  // ── feedback sync ─────────────────────────────────────────────────────────

  /** Fetch the comments of one eligible PR whose `updatedAt` moved since the last fetch (one at a time). */
  private syncNext(): void {
    if (this.syncing || !this.d.viewerLogin()) return;
    // GitHub calls wait out a rate limit or a login problem; a manual pause still keeps comments current.
    if (this.d.queue.pauseReasons().some((r) => r !== "manual")) return;
    const now = Date.now();
    const pr = this.d.db
      .listOpenPrs()
      .find((p) => p.feedbackSyncedAt !== p.updatedAt && (this.syncRetryAt.get(p.id) ?? 0) <= now && this.eligibleRepo(p)?.iterationEnabled);
    if (!pr) return;
    this.syncing = this.syncFeedback(pr)
      .catch((err: unknown) => {
        this.syncRetryAt.set(pr.id, Date.now() + 60_000);
        if (err instanceof LimitError) this.d.queue.pauseForLimit(err.resetAt, errorMessage(err));
        else if (classifyError(err) === "auth") this.d.queue.pauseForAuth(errorMessage(err));
      })
      .finally(() => {
        this.syncing = null;
      });
  }

  /** Record the PR's comments (§15.3) and owe a batch if new ones count. */
  async syncFeedback(pr: Pr): Promise<void> {
    const { db, store, github } = this.d;
    const repo = db.getRepo(pr.repoId);
    if (!repo) return;
    const updatedAt = pr.updatedAt;
    const observed = await github.getFeedback(repo.owner, repo.name, pr.number);
    if (this.stopped) return;
    const added = db.upsertFeedback(pr.id, observed);
    db.updatePr(pr.id, { feedbackSyncedAt: updatedAt });
    this.syncRetryAt.delete(pr.id);
    const viewer = this.d.viewerLogin();
    const counting = added.filter((f) => f.status === "unhandled" && feedbackCounts(repo.iterationComments, f.author, viewer));
    if (counting.length > 0) {
      store.activity({
        prId: pr.id,
        reviewId: null,
        kind: "feedback.observed",
        message: counting.length === 1 ? `New comment from @${counting[0]!.author}` : `${counting.length} new comments`,
        data: { ids: counting.map((f) => f.id) },
      });
    }
    this.plan(pr.id);
    store.prsChanged();
  }

  // ── PR changes (from the poller) ──────────────────────────────────────────

  handleChanges(repo: Repo, changes: PrChange[]): void {
    const { db } = this.d;
    for (const change of changes) {
      if (change.type === "PrObserved") continue;
      const pr = db.getPr(change.prev.id);
      if (!pr) continue;
      if (change.type === "PrClosed") {
        for (const it of db.listIterationsForPr(pr.id)) if (isIterationActive(it.state)) this.stop(it, `PR ${pr.state}`);
        void this.d.git
          .removeWorktree(this.d.paths.cloneDir(repo.owner, repo.name), this.d.paths.iterationWorktreeDir(repo.owner, repo.name, pr.number))
          .catch(() => undefined);
      } else if (change.headChanged) {
        this.onHeadChanged(pr);
      }
    }
    this.tick();
  }

  /** A push landed. Work started from the old head is stale; a push that isn't Heron's resets the loop cap. */
  private onHeadChanged(pr: Pr): void {
    const { db } = this.d;
    if (pr.heronPushStreak > 0 && !db.iterationCommitShas(pr.id).has(pr.headSha)) db.updatePr(pr.id, { heronPushStreak: 0 });
    for (const it of db.listIterationsForPr(pr.id)) {
      if (!isIterationActive(it.state) || !it.headSha) continue;
      // Our own push, seen by the poller.
      if (it.headSha === pr.headSha || it.commitSha === pr.headSha) continue;
      this.markStale(it, `The PR moved to ${short(pr.headSha)}`);
    }
  }

  /** The head moved under this iteration: the same comments go straight back to the queue, no triage, no click (§15.6). */
  private markStale(it: Iteration, why: string): void {
    const fresh = this.d.db.getIteration(it.id);
    if (!fresh || isIterationTerminal(fresh.state)) return;
    const stale = this.d.store.transitionIteration(fresh, "stale", { patch: { finishedAt: Date.now(), runAfter: null }, message: `Stale: ${why}` });
    this.runs.get(it.id)?.ac.abort("stale");
    if (stale) this.requeue(stale, "stale", this.movedToWorktree(stale));
  }

  /** Re-run in a worktree took this one off the repo's local checkout, so its stale re-run stays off it too. */
  private movedToWorktree(it: Iteration): boolean {
    const pr = this.d.db.getPr(it.prId);
    const repo = pr ? this.d.db.getRepo(pr.repoId) : null;
    return !!repo?.useLocalCheckout && it.profileSnapshot !== null && it.profileSnapshot.localCheckoutPath === null;
  }

  /**
   * A new iteration for `from`'s change comments, queued (or held) without triage.
   * `worktree`: it runs in Heron's worktree even when the repo uses a local checkout.
   */
  private requeue(from: Iteration, trigger: "stale" | "rerun", worktree = false): Iteration | null {
    const { db, store } = this.d;
    const pr = db.getPr(from.prId);
    if (!pr || pr.state !== "open") return null;
    const live = new Set(db.listIterationsForPr(pr.id).filter((i) => i.id !== from.id && isIterationActive(i.state)).map((i) => i.id));
    const listed = new Set(from.items?.flatMap((i) => i.feedbackIds) ?? []);
    const rows = db
      .listFeedbackForPr(pr.id)
      .filter((f) => (f.iterationId === from.id || listed.has(f.id)) && f.verdict === "change" && f.status !== "ignored")
      .filter((f) => f.iterationId === null || !live.has(f.iterationId));
    if (rows.length === 0) return null;
    // Frozen now rather than when the run starts, which would read the repo's local checkout setting again.
    const profileSnapshot = worktree ? this.d.pipeline.snapshot(from, { worktree: true }) : undefined;
    const next = db.tx(() => {
      const created = db.createIteration({
        prId: pr.id,
        state: this.occupied(pr.id, from.id) ? "held" : "queued",
        trigger,
        runAfter: Date.now(),
        transcriptPath: this.d.paths.iterationTranscript,
      });
      db.updateFeedback(
        rows.map((f) => f.id),
        { iterationId: created.id, status: "unhandled", handledAt: null },
      );
      return db.updateIteration(created.id, { triageTotal: from.triageTotal, triageChange: from.triageChange, profileSnapshot }) ?? created;
    });
    const where = worktree ? " in Heron's worktree" : "";
    store.activity({
      prId: pr.id,
      reviewId: null,
      iterationId: next.id,
      kind: "iteration.created",
      message: trigger === "stale" ? `Queued again on the new head (${plural(rows.length, "comment")})` : `Re-run of iteration ${from.id} requested${where}`,
    });
    return next;
  }

  private stop(it: Iteration, why: string): void {
    const fresh = this.d.db.getIteration(it.id);
    if (!fresh || isIterationTerminal(fresh.state)) return;
    this.d.store.transitionIteration(fresh, "cancelled", { patch: { finishedAt: Date.now(), runAfter: null }, message: why });
    this.runs.get(it.id)?.ac.abort("cancelled");
    this.triages.get(it.id)?.ac.abort("cancelled");
  }

  /** A repo is being removed or paused for good: stop its iterations. */
  stopRepo(repoId: number): void {
    for (const pr of this.d.db.listPrsForRepo(repoId)) {
      for (const it of this.d.db.listIterationsForPr(pr.id)) if (isIterationActive(it.state)) this.stop(it, "Repo removed");
    }
  }

  // ── manual actions ────────────────────────────────────────────────────────

  /** Manual actions need iterations on: with them off, the tick wouldn't run what they start. */
  private requireOn(prId: number): void {
    const pr = this.d.db.getPr(prId);
    const repo = pr ? this.d.db.getRepo(pr.repoId) : null;
    if (repo && !repo.iterationEnabled) throw new Error(`Iterations are off for ${repo.owner}/${repo.name}. Turn them on in Settings → Repos.`);
  }

  /** Iterate: start the batch that waits for a click (manual start or the loop cap). */
  iterate(prId: number): Iteration {
    const { db, store } = this.d;
    this.requireOn(prId);
    const its = db.listIterationsForPr(prId);
    const waiting = its.find((i) => i.state === "awaiting_start");
    if (!waiting) throw new Error("No feedback is waiting for Iterate");
    if (its.some((i) => i.state === "ready")) throw new Error("Push or discard the result that's ready first");
    const next = store.transitionIteration(waiting, this.occupied(prId, waiting.id) ? "held" : "queued", {
      patch: { runAfter: Date.now() },
      message: "Started (Iterate)",
    });
    this.tick();
    return next ?? waiting;
  }

  push(iterationId: number): Iteration {
    const it = this.d.db.getIteration(iterationId);
    if (!it || it.state !== "ready") throw new Error("Nothing is ready to push");
    if (this.d.settings().dryRun) throw new Error("Dry run is on: pushes are blocked");
    this.requireOn(it.prId);
    // The tick picks it up like any step to resume (pushing needs no parallel-run slot).
    const next = this.d.store.transitionIteration(it, "pushing", { message: "Pushing (Push)" });
    this.tick();
    return next ?? it;
  }

  async discard(iterationId: number): Promise<void> {
    const it = this.d.db.getIteration(iterationId);
    if (!it || it.state !== "ready") throw new Error("Nothing is ready to discard");
    const done = this.d.store.transitionIteration(it, "discarded", { patch: { finishedAt: it.finishedAt ?? Date.now() } });
    if (done) await this.undoLocalCommit(done);
  }

  /**
   * Local checkout mode: take the commit back off your branch but keep its changes staged, to
   * finish by hand. Heron then neither pushes nor replies; its comments count as handled.
   */
  async uncommit(iterationId: number): Promise<void> {
    const { git, store } = this.d;
    const it = this.d.db.getIteration(iterationId);
    if (!it || it.state !== "ready") throw new Error("Nothing is ready to uncommit");
    const dir = it.profileSnapshot?.localCheckoutPath;
    if (it.cwdKind !== "local" || !dir || !it.headSha || !it.commitSha) throw new Error("Only a commit on your local checkout can be uncommitted");
    const head = await git.headSha(dir);
    if (head !== it.commitSha) throw new Error(`The local checkout is at ${short(head ?? "?")}, not the iteration's commit ${short(it.commitSha)}`);
    await git.resetSoft(dir, it.headSha);
    store.transitionIteration(it, "uncommitted", {
      patch: { finishedAt: it.finishedAt ?? Date.now() },
      message: `Uncommitted: the changes are staged in the local checkout, back at ${short(it.headSha)}`,
    });
  }

  /** `worktree`: run in Heron's worktree this time, e.g. when the local checkout isn't on the PR head. */
  rerun(iterationId: number, opts: { worktree?: boolean } = {}): Iteration {
    const { db, store } = this.d;
    const old = db.getIteration(iterationId);
    if (!old) throw new Error("Iteration not found");
    this.requireOn(old.prId);
    const pr = db.getPr(old.prId);
    if (!pr || !this.eligibleRepo(pr)) throw new Error(pr ? iterationEligibilityReason(db, pr, this.d.viewerLogin()) : "PR not found");
    if (isIterationActive(old.state) && old.state !== "ready") throw new Error("This iteration is still in progress");
    if (old.state === "ready") {
      const replaced = store.transitionIteration(old, "cancelled", { patch: { finishedAt: old.finishedAt ?? Date.now() }, message: "Replaced by a re-run" });
      if (replaced) void this.undoLocalCommit(replaced);
    }
    const next = this.requeue(db.getIteration(old.id) ?? old, "rerun", opts.worktree);
    if (!next) throw new Error("This iteration has no comments left to address");
    this.tick();
    return next;
  }

  cancel(iterationId: number): void {
    const it = this.d.db.getIteration(iterationId);
    if (!it || !isIterationActive(it.state)) return;
    if (it.state === "ready") throw new Error("Use Discard for a result that's ready");
    this.stop(it, "Cancelled");
    this.tick();
  }

  /** In local checkout mode the commit sits on the user's branch: take it back off, but never at the cost of local edits. */
  private async undoLocalCommit(it: Iteration): Promise<void> {
    const dir = it.profileSnapshot?.localCheckoutPath;
    if (it.cwdKind !== "local" || !dir || !it.headSha || !it.commitSha) return;
    const { git, store } = this.d;
    try {
      if ((await git.headSha(dir)) !== it.commitSha) return;
      await git.resetKeep(dir, it.headSha);
      store.activity({ prId: it.prId, reviewId: null, iterationId: it.id, kind: "iteration.state", message: `Reset the local checkout back to ${short(it.headSha)}` });
    } catch (err) {
      store.activity({
        prId: it.prId,
        reviewId: null,
        iterationId: it.id,
        kind: "iteration.error",
        message: `Couldn't take the commit back off the local checkout: ${errorMessage(err)}`,
      });
    }
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  tick(): void {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const { db, store } = this.d;
      const now = Date.now();
      this.syncNext();

      const paused = this.d.queue.pauseReasons().length > 0;
      // A repo with iterations off starts and resumes nothing (a run already going finishes).
      const disabledRepos = new Set(db.listRepos().filter((r) => !r.iterationEnabled).map((r) => r.id));
      const blocked = (prId: number) => disabledRepos.size > 0 && disabledRepos.has(db.getPr(prId)?.repoId ?? -1);

      // Triage doesn't take a parallel-run slot.
      if (!paused) {
        for (const it of db.listIterationsInStates(["debouncing"])) {
          if ((it.runAfter ?? 0) > now || this.triages.has(it.id) || blocked(it.prId)) continue;
          this.startTriage(it);
        }
      }

      // A held batch moves up once the PR is free.
      for (const it of db.listIterationsInStates(["held"])) {
        if (!this.occupied(it.prId, it.id)) store.transitionIteration(it, "queued", { patch: { runAfter: now } });
      }

      if (!paused) {
        const max = this.d.settings().parallelRuns;
        const busyPrs = new Set([...this.runs.values()].map((r) => r.prId));
        // Interrupted steps and Push clicks first, then the queue in order.
        const resumable = db.listIterationsInStates(ITERATION_STEP_STATES).filter((i) => !this.runs.has(i.id));
        const queued = db.listIterationsInStates(["queued"]).filter((i) => (i.runAfter ?? 0) <= now);
        for (const it of [...resumable, ...queued]) {
          if (busyPrs.has(it.prId) || blocked(it.prId)) continue;
          const step = it.state === "queued" ? (it.retryStep ?? "preparing") : isIterationInFlight(it.state) ? it.state : "preparing";
          const slot = needsSlot(step);
          if (slot && this.slotCount + this.d.queue.reviewRuns() >= max) continue;
          busyPrs.add(it.prId);
          this.startRun(it, slot);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // ── triage ────────────────────────────────────────────────────────────────

  private startTriage(it: Iteration): void {
    const ac = new AbortController();
    const promise = this.triage(it, ac.signal)
      .catch((err: unknown) => this.onTriageFailure(it.id, err, ac.signal))
      .finally(() => {
        this.triages.delete(it.id);
        this.d.store.prsChanged();
        setImmediate(() => this.tick());
      });
    this.triages.set(it.id, { ac, prId: it.prId, promise, slot: false });
  }

  private async triage(debouncing: Iteration, signal: AbortSignal): Promise<void> {
    const { db, store, pipeline } = this.d;
    const pr = db.getPr(debouncing.prId);
    const repo = pr ? this.eligibleRepo(pr) : null;
    if (!pr || !repo) {
      this.stop(debouncing, "Iterations no longer run on this PR");
      return;
    }
    const it = store.transitionIteration(debouncing, "triaging", { patch: { runAfter: null } });
    if (!it) return;

    // Claim the batch: every unhandled comment that counts and no other live iteration holds.
    db.updateFeedback(
      this.candidates(pr, repo).map((f) => f.id),
      { iterationId: it.id },
    );
    const rows = db.listFeedbackForIteration(it.id).filter((f) => f.status === "unhandled");
    if (rows.length === 0) {
      store.transitionIteration(it, "skipped", { patch: { finishedAt: Date.now() }, message: "Nothing left to triage" });
      return;
    }
    const verdicts = await pipeline.triage(it, rows, signal);
    if (signal.aborted) return;
    this.applyTriage(it, rows, verdicts);
  }

  /** Save the verdicts (a thread's verdict covers all its comments; no-change handles them), then route the batch. */
  private applyTriage(it: Iteration, rows: Feedback[], verdicts: Map<string, { verdict: TriageVerdict; reason: string }>): void {
    const { db, store } = this.d;
    const now = Date.now();
    db.tx(() => {
      for (const [key, v] of verdicts) {
        const ids = rows.filter((r) => groupKey(r) === key).map((r) => r.id);
        db.updateFeedback(ids, { verdict: v.verdict, reason: v.reason, ...(v.verdict === "no-change" ? { status: "handled" as const, handledAt: now } : {}) });
      }
    });
    const toChange = [...verdicts.values()].filter((v) => v.verdict === "change").length;
    const counted = db.updateIteration(it.id, { triageTotal: it.triageTotal + verdicts.size, triageChange: it.triageChange + toChange }) ?? it;
    if (verdicts.size > 0) {
      store.activity({
        prId: it.prId,
        reviewId: null,
        iterationId: it.id,
        kind: "feedback.triaged",
        message: `Triage: ${toChange} of ${verdicts.size} to change`,
        data: { total: verdicts.size, change: toChange },
      });
    }
    const change = db.listFeedbackForIteration(it.id).filter((f) => f.status === "unhandled" && f.verdict === "change");
    if (change.length === 0) {
      store.transitionIteration(counted, "skipped", { patch: { finishedAt: now } });
      return;
    }
    this.route(counted, new Set(change.map(groupKey)).size);
  }

  /** After triage: wait for Iterate, wait behind the iteration occupying the PR, or queue. Waiting batches merge into one. */
  private route(it: Iteration, items: number): void {
    const { db, store } = this.d;
    const pr = db.getPr(it.prId);
    const repo = pr ? db.getRepo(pr.repoId) : null;
    if (!pr || !repo) return;
    const settings = this.d.settings();
    const waiting = db.listIterationsForPr(pr.id).find((i) => i.id !== it.id && (i.state === "held" || i.state === "awaiting_start"));
    if (waiting) {
      this.merge(it, waiting);
      return;
    }
    const capped = pr.heronPushStreak >= settings.loopCap;
    if (!repo.iterationAutoStart || capped) {
      const moved = store.transitionIteration(it, "awaiting_start", {
        message: capped ? `Waiting for Iterate: Heron pushed ${pr.heronPushStreak} times in a row` : undefined,
      });
      if (moved && settings.notifyPosted) {
        this.d.notify({ title: "Feedback waiting", body: `#${pr.number} ${pr.title}: ${plural(items, "comment")} to address`, prId: pr.id, tab: "iteration" });
      }
      return;
    }
    store.transitionIteration(it, this.occupied(pr.id, it.id) ? "held" : "queued", { patch: { runAfter: Date.now() } });
  }

  /** Fold a newly triaged batch into the one already waiting, so they run as one. */
  private merge(from: Iteration, into: Iteration): void {
    const { db, store } = this.d;
    const ids = db
      .listFeedbackForIteration(from.id)
      .filter((f) => f.status === "unhandled")
      .map((f) => f.id);
    db.tx(() => {
      db.updateFeedback(ids, { iterationId: into.id });
      db.updateIteration(into.id, { triageTotal: into.triageTotal + from.triageTotal, triageChange: into.triageChange + from.triageChange });
    });
    store.transitionIteration(from, "cancelled", { patch: { mergedInto: into.id, finishedAt: Date.now() }, message: `Merged into iteration ${into.id}` });
    // The waiting iteration's transcript then holds every triage call.
    if (from.transcriptPath && into.transcriptPath) {
      void readFile(from.transcriptPath, "utf8")
        .then((text) => appendFile(into.transcriptPath!, text))
        .catch(() => undefined);
    }
  }

  private onTriageFailure(iterationId: number, err: unknown, signal: AbortSignal): void {
    const { db, store } = this.d;
    const it = db.getIteration(iterationId);
    if (!it || isIterationTerminal(it.state)) return;
    // Quit leaves it in triaging; `recover` sends it back to debouncing on the next launch.
    if (err instanceof RunAbortedError || signal.aborted) return;
    const message = errorMessage(err);
    const cls = classifyError(err);
    if (cls === "limit") {
      const until = err instanceof LimitError ? err.resetAt : Date.now() + 15 * 60_000;
      this.d.queue.pauseForLimit(until, message);
      store.transitionIteration(it, "debouncing", { patch: { runAfter: until, lastError: message }, message: `Waiting for the limit to reset (${message})` });
      return;
    }
    if (cls === "auth") {
      this.d.queue.pauseForAuth(message);
      store.transitionIteration(it, "debouncing", { patch: { runAfter: Date.now(), lastError: message }, message: `Waiting for login (${message})` });
      return;
    }
    if (cls === "transient") {
      const delay = retryDelay(it.attempt);
      if (delay !== null) {
        const moved = store.transitionIteration(it, "debouncing", {
          patch: { runAfter: Date.now() + delay, attempt: it.attempt + 1, lastError: message },
          message: `Triage retries in ${formatDelay(delay)}: ${message}`,
        });
        if (moved) store.activity({ prId: it.prId, reviewId: null, iterationId: it.id, kind: "iteration.retry", message: `Attempt ${it.attempt + 2} in ${formatDelay(delay)}` });
        return;
      }
    }
    this.fail(it, message, err);
  }

  // ── agent runs ────────────────────────────────────────────────────────────

  private startRun(it: Iteration, slot: boolean): void {
    const ac = new AbortController();
    const promise = this.d.pipeline
      .execute(it.id, ac.signal)
      .then((final) => this.onFinished(final))
      .catch((err: unknown) => this.onFailure(it.id, err, ac.signal))
      .finally(() => {
        this.runs.delete(it.id);
        this.d.store.prsChanged();
        setImmediate(() => this.tick());
      });
    this.runs.set(it.id, { ac, prId: it.prId, promise, slot });
    this.d.store.prsChanged();
  }

  private onFinished(it: Iteration | null): void {
    if (!it) return;
    const pr = this.d.db.getPr(it.prId);
    if (!pr) return;
    const s = this.d.settings();
    if (it.state === "ready" && s.notifyPosted) {
      this.d.notify({ title: "Ready to push", body: `#${pr.number} ${it.output?.commitTitle ?? pr.title}`, prId: pr.id, tab: "iteration" });
    }
    if (it.state === "pushed") {
      // The poller then sees the new head soon (and supersedes a review in progress).
      this.d.requestPoll();
      if (s.notifyPosted) this.d.notify({ title: "Pushed", body: `#${pr.number} ${it.output?.commitTitle ?? pr.title}`, prId: pr.id, tab: "iteration" });
    }
  }

  private onFailure(iterationId: number, err: unknown, signal: AbortSignal): void {
    const { db, store } = this.d;
    const it = db.getIteration(iterationId);
    if (!it || isIterationTerminal(it.state)) return; // stale/cancelled already recorded

    if (err instanceof RunAbortedError || signal.aborted) {
      if (signal.reason === "quit") {
        store.activity({ prId: it.prId, reviewId: null, iterationId, kind: "iteration.state", message: "Interrupted by quit; resumes on next launch" });
      }
      return;
    }
    if (err instanceof StaleError) {
      this.markStale(it, err.message);
      this.d.requestPoll();
      return;
    }
    if (err instanceof PrClosedError) {
      store.transitionIteration(it, "cancelled", { patch: { finishedAt: Date.now() }, message: `PR ${err.state}` });
      this.d.requestPoll();
      return;
    }

    const message = errorMessage(err);
    const step = isIterationInFlight(it.state) ? it.state : "preparing";
    const cls = classifyError(err);
    if (cls === "limit") {
      const until = err instanceof LimitError ? err.resetAt : Date.now() + 15 * 60_000;
      this.d.queue.pauseForLimit(until, message);
      store.transitionIteration(it, "queued", { patch: { retryStep: step, runAfter: until, lastError: message }, message: `Waiting for the limit to reset (${message})` });
      return;
    }
    if (cls === "auth") {
      this.d.queue.pauseForAuth(message);
      store.transitionIteration(it, "queued", { patch: { retryStep: step, runAfter: Date.now(), lastError: message }, message: `Waiting for login (${message})` });
      return;
    }
    if (cls === "transient") {
      const delay = retryDelay(it.attempt);
      if (delay !== null) {
        const moved = store.transitionIteration(it, "queued", {
          patch: { retryStep: step, runAfter: Date.now() + delay, attempt: it.attempt + 1, lastError: message },
          message: `Retrying in ${formatDelay(delay)}: ${message}`,
        });
        if (moved) store.activity({ prId: it.prId, reviewId: null, iterationId, kind: "iteration.retry", message: `Attempt ${it.attempt + 2} in ${formatDelay(delay)}` });
        return;
      }
    }
    this.fail(it, message, err);
  }

  private fail(it: Iteration, message: string, err: unknown): void {
    const { db, store } = this.d;
    const step = isIterationInFlight(it.state) ? it.state : it.state === "triaging" ? "triage" : "preparing";
    const failed = store.transitionIteration(it, "failed", {
      patch: { lastError: message, finishedAt: Date.now(), pid: null, ...(err instanceof OutputParseError && err.raw ? { rawOutput: err.raw } : {}) },
      message: `Failed: ${message.split("\n")[0]}`,
    });
    if (!failed) return;
    store.activity({ prId: it.prId, reviewId: null, iterationId: it.id, kind: "iteration.error", message, data: { step } });
    const pr = db.getPr(it.prId);
    if (pr && this.d.settings().notifyFailed) {
      this.d.notify({ title: "Iteration failed", body: `#${pr.number} ${pr.title}: ${message.slice(0, 120)}`, prId: pr.id, tab: "iteration" });
    }
  }
}

function iterationEligibilityReason(db: HeronDb, pr: Pr, viewerLogin: string | null): string {
  const repo = db.getRepo(pr.repoId);
  if (!repo) return "Repo not found";
  const e = iterationEligibility(repo, pr, viewerLogin);
  return e.ok ? "" : e.reason;
}
