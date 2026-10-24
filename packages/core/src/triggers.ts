import type { Pr, Repo, Review } from "./types.ts";

/** A PR as seen in GitHub's open-PR list. */
export interface ObservedPr {
  number: number;
  title: string;
  body: string;
  author: string;
  authorAvatarUrl: string | null;
  isDraft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha: string;
  url: string;
  createdAt: number;
  updatedAt: number;
}

export type PrChange =
  | { type: "PrObserved"; pr: ObservedPr }
  | { type: "PrReopened"; prev: Pr; pr: ObservedPr; headChanged: boolean }
  | {
      type: "PrUpdated";
      prev: Pr;
      pr: ObservedPr;
      headChanged: boolean;
      /** Set when the draft flag flipped. */
      draft: "to_ready" | "to_draft" | null;
    }
  | { type: "PrClosed"; prev: Pr };

/**
 * Compare stored PRs with the current open list.
 * `known` must hold every stored PR of the repo, open or not.
 */
export function diffPrs(known: Pr[], observed: ObservedPr[]): PrChange[] {
  const byNumber = new Map(known.map((p) => [p.number, p]));
  const seen = new Set<number>();
  const changes: PrChange[] = [];

  for (const pr of observed) {
    seen.add(pr.number);
    const prev = byNumber.get(pr.number);
    if (!prev) {
      changes.push({ type: "PrObserved", pr });
      continue;
    }
    const headChanged = prev.headSha !== pr.headSha;
    if (prev.state !== "open") {
      changes.push({ type: "PrReopened", prev, pr, headChanged });
      continue;
    }
    const draft = prev.isDraft === pr.isDraft ? null : pr.isDraft ? "to_draft" : "to_ready";
    const metaChanged =
      prev.title !== pr.title ||
      prev.body !== pr.body ||
      prev.baseRef !== pr.baseRef ||
      prev.baseSha !== pr.baseSha ||
      prev.headRef !== pr.headRef ||
      prev.updatedAt !== pr.updatedAt;
    if (headChanged || draft || metaChanged) {
      changes.push({ type: "PrUpdated", prev, pr, headChanged, draft });
    }
  }

  for (const prev of known) {
    if (prev.state === "open" && !seen.has(prev.number)) changes.push({ type: "PrClosed", prev });
  }
  return changes;
}

export function isInScope(
  repo: Pick<Repo, "scope">,
  pr: Pick<Pr, "author" | "number">,
  viewerLogin: string | null,
  manualPrs: ReadonlySet<number>,
): boolean {
  switch (repo.scope) {
    case "all":
      return true;
    case "mine":
      return viewerLogin !== null && pr.author.toLowerCase() === viewerLogin.toLowerCase();
    case "manual":
      return manualPrs.has(pr.number);
  }
}

/** Drafts are skipped unless the repo allows them; a hand-picked draft is always reviewed. */
export function isDraftAllowed(
  repo: Pick<Repo, "scope" | "includeDrafts">,
  pr: Pick<Pr, "isDraft" | "number">,
  manualPrs: ReadonlySet<number>,
): boolean {
  if (!pr.isDraft) return true;
  if (repo.includeDrafts) return true;
  return repo.scope === "manual" && manualPrs.has(pr.number);
}

/** Should this PR be reviewed automatically at all (ignoring which SHAs were reviewed)? */
export function isEligible(
  repo: Pick<Repo, "scope" | "includeDrafts" | "enabled">,
  pr: Pick<Pr, "author" | "number" | "isDraft" | "state">,
  viewerLogin: string | null,
  manualPrs: ReadonlySet<number>,
): boolean {
  return (
    repo.enabled &&
    pr.state === "open" &&
    isInScope(repo, pr, viewerLogin, manualPrs) &&
    isDraftAllowed(repo, pr, manualPrs)
  );
}

/** A SHA counts as reviewed once any run for it got past being superseded or cancelled. */
export function hasReviewForSha(reviews: Pick<Review, "headSha" | "state">[], sha: string): boolean {
  return reviews.some((r) => r.headSha === sha && r.state !== "superseded" && r.state !== "cancelled");
}

/** Does this change start a review of the PR's new head? (No backfill: PrObserved only fires after the initial sync.) */
export function changeTriggersReview(change: PrChange): boolean {
  switch (change.type) {
    case "PrObserved":
      return true;
    case "PrReopened":
      return true;
    case "PrUpdated":
      return change.headChanged || change.draft === "to_ready";
    case "PrClosed":
      return false;
  }
}
