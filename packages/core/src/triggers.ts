import type { IterationComments, Pr, Repo, RepoScope, Review } from "./types.ts";

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
  /** `owner/name` of the head branch's repo; null when the fork was deleted. */
  headRepo: string | null;
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

/** Is the PR one the repo's scope covers (the sidebar lists it)? Manual covers every PR; it just never reviews one on its own. */
export function isInScope(scope: RepoScope, pr: Pr, viewerLogin: string | null): boolean {
  switch (scope) {
    case "all":
    case "manual":
      return true;
    case "mine":
      return viewerLogin !== null && pr.author.toLowerCase() === viewerLogin.toLowerCase();
  }
}

/** Drafts are skipped unless the repo allows them. */
export function isDraftAllowed(repo: Repo, pr: Pr): boolean {
  return !pr.isDraft || repo.includeDrafts;
}

/** Does a push start a review of this PR on its own? Not with reviews off or in manual scope (there, reviews start with Review now). */
export function reviewsAutomatically(repo: Repo, pr: Pr, viewerLogin: string | null): boolean {
  return repo.reviewEnabled && repo.scope !== "manual" && isInScope(repo.scope, pr, viewerLogin) && isDraftAllowed(repo, pr);
}

/** Should this PR be reviewed automatically at all (ignoring which SHAs were reviewed)? */
export function isEligible(repo: Repo, pr: Pr, viewerLogin: string | null): boolean {
  return pr.state === "open" && reviewsAutomatically(repo, pr, viewerLogin);
}

/** A SHA counts as reviewed once any run for it got past being superseded or cancelled. */
export function hasReviewForSha(reviews: Review[], sha: string): boolean {
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

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Iterations run on open PRs the viewer opened, from a branch in the same repo; forks are skipped (§15.1). */
export function iterationEligibility(repo: Repo, pr: Pr, viewerLogin: string | null): { ok: true } | { ok: false; reason: string } {
  if (viewerLogin === null || !sameLogin(pr.author, viewerLogin)) return { ok: false, reason: "Iterations only run on PRs you opened." };
  if (pr.headRepo === null || !sameLogin(pr.headRepo, `${repo.owner}/${repo.name}`)) {
    return { ok: false, reason: "This PR comes from a fork. Iterations only run on branches in the same repo." };
  }
  if (pr.state !== "open") return { ok: false, reason: `This PR is ${pr.state}.` };
  return { ok: true };
}

/** Does a comment by `author` count under the repo's iteration comments? `mine` keeps the viewer's own (Heron's reviews post as the viewer). */
export function feedbackCounts(comments: IterationComments, author: string, viewerLogin: string | null): boolean {
  if (comments === "all") return true;
  return viewerLogin !== null && sameLogin(author, viewerLogin);
}
