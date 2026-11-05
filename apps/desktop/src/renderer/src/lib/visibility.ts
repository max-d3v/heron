import type { PrListItem } from "@heron/rpc";

/**
 * Which PRs the sidebar lists: by default those in their repo's scope, reviewed at least
 * once, or iterated on (every PR you opened is); with "show all", every open PR.
 * Selection follows the same rule.
 */
export function isListed(pr: PrListItem, showAll: boolean): boolean {
  return showAll || pr.inScope || pr.status !== "not_reviewed" || pr.iterationEligible || pr.iteration !== null;
}

/**
 * Nothing left for you on it, so a newly arrived PR may take the selection: it's closed or
 * merged, or its current head was reviewed with no issues and no iteration is under way.
 */
export function isSettled(pr: PrListItem): boolean {
  if (pr.state !== "open") return true;
  return pr.status === "no_issues" && !pr.headUnreviewed && pr.iteration === null;
}
