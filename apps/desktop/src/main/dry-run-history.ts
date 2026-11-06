import { UNREPORTED_NOTE, dryRunFeedbackId, isHeldBack, type Feedback, type Iteration, type Review, type ReviewPayload, type Side } from "@heron/core";

// Heron's earlier dry runs on a PR, for a review's `.heron/previous-reviews.json` (§7.3). Posted
// reviews come from GitHub with their replies, which say what the author did about each comment.
// Dry runs were never posted, so their findings and what came of them live only in Heron.

/** What came of one dry-run finding, when anything did. */
export type DryRunOutcome =
  /** Triage found nothing to change (a question, a summary, something already done). */
  | { by: "triage"; status: "no_change"; reason: string }
  /** An iteration changed the code for it; `commit` is null when it ended without one. */
  | { by: "iteration"; status: "addressed"; note: string; commit: string | null }
  /** An iteration's agent left it alone, for this reason. */
  | { by: "iteration"; status: "not_addressed"; note: string };

export interface DryRunComment {
  path: string;
  line: number;
  side?: Side;
  start_line?: number;
  start_side?: Side;
  body: string;
  outcome: DryRunOutcome | null;
}

/** One earlier dry run, next to the posted reviews from GitHub in the same file. */
export interface DryRunEntry {
  /** Never posted: the PR shows none of it. */
  dryRun: true;
  sha: string;
  submittedAt: string | null;
  body: string;
  /** What came of the body, which counts as one finding of its own. */
  bodyOutcome: DryRunOutcome | null;
  comments: DryRunComment[];
}

/** Iterations whose result stands: the agent ran, and its report is final. */
const SETTLED: ReadonlySet<Iteration["state"]> = new Set(["pushed", "no_changes"]);

/**
 * The PR's dry runs that held back a review, older than review `before`, oldest first. Each
 * finding carries what came of it: the newest settled iteration that worked on it, else a
 * triage verdict of no change. Findings no one has acted on (iterations off, still waiting,
 * discarded, replaced by a newer review) have none.
 */
export function dryRunHistory(reviews: Review[], feedback: Feedback[], iterations: Iteration[], before: number): DryRunEntry[] {
  const rows = new Map(feedback.filter((f) => f.reviewId !== null).map((f) => [f.githubId, f]));
  const settled = iterations.filter((i) => SETTLED.has(i.state)).sort((a, b) => b.id - a.id);
  const outcome = (f: Feedback | undefined): DryRunOutcome | null => (f ? outcomeOf(f, settled) : null);

  return reviews
    .filter((r): r is Review & { payload: ReviewPayload } => r.id < before && r.payload !== null && isHeldBack(r.state, r.payload))
    .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt) || a.id - b.id)
    .map((r) => ({
      dryRun: true,
      sha: r.headSha,
      submittedAt: r.finishedAt === null ? null : new Date(r.finishedAt).toISOString(),
      body: r.payload.body,
      bodyOutcome: r.payload.body.trim() ? outcome(rows.get(dryRunFeedbackId(r.id, 0))) : null,
      comments: r.payload.comments.map((c, i) => ({
        path: c.path,
        line: c.line,
        ...(c.side ? { side: c.side } : {}),
        ...(c.start_line !== undefined ? { start_line: c.start_line, ...(c.start_side ? { start_side: c.start_side } : {}) } : {}),
        body: c.body,
        outcome: outcome(rows.get(dryRunFeedbackId(r.id, i + 1))),
      })),
    }));
}

function outcomeOf(f: Feedback, settled: Iteration[]): DryRunOutcome | null {
  for (const it of settled) {
    const item = it.items?.find((i) => i.feedbackIds.includes(f.id));
    const out = item ? it.output?.items.find((o) => o.number === item.number) : undefined;
    if (!out) continue;
    // Left out of the agent's report: nothing was decided about it.
    if (out.note === UNREPORTED_NOTE) return null;
    return out.status === "addressed"
      ? { by: "iteration", status: "addressed", note: out.note, commit: it.state === "pushed" ? it.commitSha : null }
      : { by: "iteration", status: "not_addressed", note: out.note };
  }
  if (f.verdict === "no-change") return { by: "triage", status: "no_change", reason: f.reason ?? "" };
  return null;
}
