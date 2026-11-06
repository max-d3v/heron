import type { DiffContextLine, ObservedFeedback, ReviewPayload } from "./types.ts";

// Iterating on dry-run reviews (§15.3, `iterationDryRuns`): a dry run's findings become feedback
// without ever being posted, so the PR gets the iteration's commit and nothing else: no review,
// no threads, no replies.

/** Findings per review that can get an id of their own; a review with more is cut off there. */
const MAX_FINDINGS = 999;

/**
 * The made-up `githubId` of a dry-run finding: 0 is the review's body, 1… its inline comments.
 * Negative, so it never meets a real GitHub id; unique per review, so recording a review twice
 * adds nothing.
 */
export function dryRunFeedbackId(reviewId: number, index: number): number {
  return -(reviewId * (MAX_FINDINGS + 1) + index);
}

function hunk(lines: DiffContextLine[]): string | null {
  if (lines.length === 0) return null;
  return lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`).join("\n");
}

/**
 * A dry-run review's findings as feedback: its body (comments outside the diff were already
 * folded into it) and each inline comment. `author` is the viewer: Heron's reviews post as them.
 */
export function dryRunFeedback(reviewId: number, payload: ReviewPayload, author: string, at: number): ObservedFeedback[] {
  const out: ObservedFeedback[] = [];
  const common = { author, url: null, reviewState: null, createdAt: at, heronReply: false, outdated: false };
  const body = payload.body.trim();
  if (body) {
    const id = dryRunFeedbackId(reviewId, 0);
    out.push({ ...common, kind: "review", githubId: id, threadRootId: id, body, path: null, line: null, diffHunk: null });
  }
  payload.comments.slice(0, MAX_FINDINGS).forEach((c, i) => {
    const id = dryRunFeedbackId(reviewId, i + 1);
    out.push({ ...common, kind: "inline", githubId: id, threadRootId: id, body: c.body, path: c.path, line: c.line, diffHunk: hunk(c.context) });
  });
  return out;
}
