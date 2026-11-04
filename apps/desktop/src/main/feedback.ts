import { stripIterationMarker, type Feedback, type FeedbackKind, type Pr, type Repo } from "@heron/core";
import type { HeronDb } from "@heron/db";
import type { GitHubClient } from "@heron/github";
import type { Store } from "./store.ts";

/**
 * A unit of feedback: an inline thread, a review body or a conversation comment. Triage
 * gives one verdict per group, and the agent gets one numbered item per group. A new reply
 * reopens its whole thread, so the thread is always sent in full as context.
 */
export interface FeedbackGroup {
  key: string;
  kind: FeedbackKind;
  threadRootId: number;
  /** The rows this group stands for in a batch. */
  rows: Feedback[];
  /** Every comment of the thread, whatever its status, oldest first. */
  thread: Feedback[];
  path: string | null;
  line: number | null;
  outdated: boolean;
  diffHunk: string | null;
  reviewState: string | null;
  url: string | null;
  /** When the thread started (orders groups for numbering). */
  createdAt: number;
}

export const groupKey = (f: Feedback) => `${f.kind}:${f.threadRootId}`;

/** Group `rows` by thread; `all` (the PR's every feedback row) supplies each thread's context. */
export function groupFeedback(rows: Feedback[], all: Feedback[]): FeedbackGroup[] {
  const byKey = new Map<string, Feedback[]>();
  for (const r of rows) byKey.set(groupKey(r), [...(byKey.get(groupKey(r)) ?? []), r]);
  return [...byKey].map(([key, members]) => {
    const thread = all.filter((f) => groupKey(f) === key).sort((a, b) => a.createdAt - b.createdAt || a.githubId - b.githubId);
    const root = thread.find((f) => f.githubId === f.threadRootId) ?? thread[0] ?? members[0]!;
    return {
      key,
      kind: root.kind,
      threadRootId: root.threadRootId,
      rows: members,
      thread: thread.length > 0 ? thread : members,
      path: root.path,
      line: root.line,
      outdated: root.outdated,
      diffHunk: root.diffHunk,
      reviewState: root.reviewState,
      url: root.url,
      createdAt: root.createdAt,
    };
  });
}

/** How a comment's author shows in prompts: the PR's author and Heron's own replies are marked. */
export function authorLabel(f: Feedback, prAuthor: string): string {
  if (f.status === "ignored") return `${f.author} (Heron, an earlier iteration)`;
  if (f.author.toLowerCase() === prAuthor.toLowerCase()) return `${f.author} (PR author)`;
  return f.author;
}

export function threadForPrompt(group: FeedbackGroup, prAuthor: string): Array<{ author: string; body: string }> {
  return group.thread.map((f) => ({ author: authorLabel(f, prAuthor), body: stripIterationMarker(f.body) }));
}

// ── resolved threads (§15.3) ────────────────────────────────────────────────

/** The PR's inline threads on GitHub, keyed by their first comment's id. */
export type ReviewThreads = Map<number, { id: string; resolved: boolean }>;

/** Why a batch ends `skipped` when the threads it held were all resolved on GitHub. */
export const ALL_RESOLVED = "Every thread left was resolved on GitHub";

/** The PR's inline threads, fetched only when `rows` has an inline comment to check. */
export async function threadsFor(github: GitHubClient, repo: Repo, pr: Pr, rows: ReadonlyArray<{ kind: FeedbackKind }>): Promise<ReviewThreads> {
  return rows.some((f) => f.kind === "inline") ? github.listReviewThreads(repo.owner, repo.name, pr.number) : new Map();
}

/**
 * The inline comments among `rows` whose thread is resolved on GitHub. A thread GitHub doesn't
 * list (its first comment was deleted, so the ids don't match) counts as open.
 */
export function inResolvedThreads(rows: Feedback[], threads: ReviewThreads): Feedback[] {
  return rows.filter((f) => f.kind === "inline" && threads.get(f.threadRootId)?.resolved === true);
}

const threadCount = (rows: Feedback[]) => new Set(rows.map(groupKey)).size;
const threadsLabel = (n: number, adjective: string) => `${n} ${adjective} thread${n === 1 ? "" : "s"}`;

/**
 * Set aside comments whose thread was resolved on GitHub: handled, flagged so an unresolve can
 * bring them back, and out of any batch. A batch that had already triaged them stops counting
 * them, so its "N of M to change" covers only what it ran on.
 */
export function setAsideResolved(db: HeronDb, store: Store, prId: number, rows: Feedback[], iterationId: number | null = null): void {
  if (rows.length === 0) return;
  const now = Date.now();
  db.tx(() => {
    db.updateFeedback(
      rows.map((f) => f.id),
      { status: "handled", handledAt: now, setAsideResolved: true, iterationId: null },
    );
    const byBatch = new Map<number, Feedback[]>();
    for (const f of rows) if (f.iterationId !== null && f.verdict !== null) byBatch.set(f.iterationId, [...(byBatch.get(f.iterationId) ?? []), f]);
    for (const [id, triaged] of byBatch) {
      const it = db.getIteration(id);
      if (!it) continue;
      const change = threadCount(triaged.filter((f) => f.verdict === "change"));
      db.updateIteration(id, { triageTotal: Math.max(0, it.triageTotal - threadCount(triaged)), triageChange: Math.max(0, it.triageChange - change) });
    }
  });
  const threads = threadCount(rows);
  store.activity({
    prId,
    reviewId: null,
    iterationId,
    kind: "feedback.resolved",
    message: `Set aside ${threadsLabel(threads, "resolved")}`,
    data: { ids: rows.map((f) => f.id) },
  });
}

/** Comments set aside for a resolved thread whose thread is open again: unhandled and untriaged, like new ones. */
export function restoreUnresolved(db: HeronDb, store: Store, prId: number, rows: Feedback[]): void {
  if (rows.length === 0) return;
  db.updateFeedback(
    rows.map((f) => f.id),
    { status: "unhandled", handledAt: null, setAsideResolved: false, iterationId: null, verdict: null, reason: null },
  );
  const threads = threadCount(rows);
  store.activity({
    prId,
    reviewId: null,
    kind: "feedback.unresolved",
    message: `${threadsLabel(threads, "unresolved")} back for triage`,
    data: { ids: rows.map((f) => f.id) },
  });
}
