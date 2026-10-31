import type { PrListItem } from "@heron/rpc";

/**
 * Which PRs the sidebar lists: by default those in their repo's scope, reviewed at least
 * once, or iterated on (every PR you opened is); with "show all", every open PR.
 * Selection follows the same rule.
 */
export function isListed(pr: PrListItem, showAll: boolean): boolean {
  return showAll || pr.inScope || pr.status !== "not_reviewed" || pr.iterationEligible || pr.iteration !== null;
}
