import { AuthError, LimitError, diffPrs, errorMessage, type Repo } from "@heron/core";
import type { HeronDb } from "@heron/db";
import type { GitHubClient } from "@heron/github";
import type { Scheduler } from "./scheduler.ts";
import type { Store } from "./store.ts";

export interface PollerDeps {
  db: HeronDb;
  store: Store;
  github: GitHubClient;
  scheduler: Scheduler;
  intervalSec: () => number;
  /** Doctor is green (gh logged in etc.). */
  ready: () => boolean;
}

/** Polls each enabled repo's open PRs with ETags and feeds changes to the scheduler (§8). */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private pausedUntil = 0;

  constructor(private readonly d: PollerDeps) {}

  start(): void {
    this.schedule(1000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.pollAll().finally(() => this.schedule(this.d.intervalSec() * 1000));
    }, ms);
  }

  /** Poll now (wake from sleep, a repo added, Review now on a moved PR). */
  pollNow(): Promise<void> {
    return this.pollAll();
  }

  pollAll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      if (!this.d.ready() || Date.now() < this.pausedUntil) return;
      for (const repo of this.d.db.listRepos()) {
        if (!repo.enabled) continue;
        const stop = await this.pollRepo(repo);
        if (stop) break;
      }
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Returns true when polling should stop for now (rate limit or auth). */
  async pollRepo(repo: Repo): Promise<boolean> {
    const { db, github, store, scheduler } = this.d;
    try {
      const res = await github.listOpenPulls(repo.owner, repo.name, repo.etag);
      const now = Date.now();
      if (res.notModified) {
        db.updateRepo(repo.id, { lastPolledAt: now, lastPollError: null });
        return false;
      }

      const known = db.listPrsForRepo(repo.id);
      let changes = diffPrs(known, res.pulls);
      db.tx(() => {
        for (const pull of res.pulls) db.upsertObservedPr(repo.id, pull);
      });

      const stillOpen = new Set<number>();
      for (const c of changes) {
        if (c.type !== "PrClosed") continue;
        let state: "closed" | "merged" = "closed";
        try {
          const detail = await github.getPull(repo.owner, repo.name, c.prev.number);
          if (detail.state === "open") {
            // Fell off the list for another reason (e.g. more than 2000 open PRs).
            stillOpen.add(c.prev.id);
            continue;
          }
          state = detail.state;
        } catch {
          // Treat as closed; a 404 means it's gone either way.
        }
        db.updatePr(c.prev.id, { state });
      }
      changes = changes.filter((c) => c.type !== "PrClosed" || !stillOpen.has(c.prev.id));

      const initial = !repo.initialSyncDone;
      const fresh = db.updateRepo(repo.id, { etag: res.etag, lastPolledAt: now, lastPollError: null, initialSyncDone: true });
      // No backfill: PRs that were open when the repo was added are only listed.
      if (!initial) scheduler.handleChanges(fresh, changes);
      store.prsChanged();
      return false;
    } catch (err) {
      const message = errorMessage(err);
      db.updateRepo(repo.id, { lastPollError: message, lastPolledAt: Date.now() });
      store.prsChanged();
      if (err instanceof LimitError) {
        this.pausedUntil = err.resetAt;
        scheduler.pauseForLimit(err.resetAt, message);
        return true;
      }
      if (err instanceof AuthError) {
        scheduler.pauseForAuth(message);
        return true;
      }
      return false;
    }
  }
}
