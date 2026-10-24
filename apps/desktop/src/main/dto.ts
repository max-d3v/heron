import { isInScope, isTerminal, type Repo, type Review, type ReviewState } from "@heron/core";
import type { HeronDb, PrListRow } from "@heron/db";
import type { PrListItem, PrStatus, RepoDto, ReviewDetail, RunSummary } from "@heron/rpc";

const CLOSED_PR_WINDOW_MS = 14 * 24 * 3600_000;

export function statusOf(state: ReviewState | null): PrStatus {
  switch (state) {
    case null:
      return "not_reviewed";
    case "preparing":
    case "running":
    case "validating":
    case "posting":
      return "running";
    default:
      return state;
  }
}

export function toPrListItem(row: PrListRow, inScope: boolean): PrListItem {
  const { pr, latestReview } = row;
  return {
    id: pr.id,
    repoId: pr.repoId,
    repo: `${row.owner}/${row.repoName}`,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    authorAvatarUrl: pr.authorAvatarUrl,
    isDraft: pr.isDraft,
    state: pr.state,
    url: pr.url,
    headSha: pr.headSha,
    inScope,
    repoEnabled: row.repoEnabled,
    status: statusOf(latestReview?.state ?? null),
    headUnreviewed: latestReview !== null && isTerminal(latestReview.state) && latestReview.headSha !== pr.headSha,
    latestReviewId: latestReview?.id ?? null,
    latestError: latestReview?.state === "failed" ? latestReview.lastError : null,
    lastActivityAt: pr.lastActivityAt,
  };
}

/** Sidebar rows: open PRs, plus recently closed ones that were reviewed. */
export function listPrItems(db: HeronDb, viewerLogin: string | null): PrListItem[] {
  const repos = new Map(db.listRepos().map((r) => [r.id, { repo: r, manual: db.getManualPrs(r.id) }]));
  const cutoff = Date.now() - CLOSED_PR_WINDOW_MS;
  const out: PrListItem[] = [];
  for (const row of db.listPrRows()) {
    if (row.pr.state !== "open" && (row.reviewCount === 0 || row.pr.lastActivityAt < cutoff)) continue;
    const r = repos.get(row.pr.repoId);
    const inScope = r ? isInScope(r.repo, row.pr, viewerLogin, r.manual) : false;
    out.push(toPrListItem(row, inScope));
  }
  return out;
}

export function toRunSummary(r: Review): RunSummary {
  const snap = r.profileSnapshot;
  return {
    id: r.id,
    prId: r.prId,
    headSha: r.headSha,
    state: r.state,
    trigger: r.trigger,
    profileName: snap?.name ?? null,
    model: r.resolvedModel ?? snap?.model ?? null,
    effort: snap?.effort ?? null,
    dryRun: snap?.dryRun ?? false,
    attempt: r.attempt,
    runAfter: r.runAfter,
    lastError: r.lastError,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    createdAt: r.createdAt,
    githubReviewUrl: r.githubReviewUrl,
    usage: r.usage,
  };
}

export function toReviewDetail(r: Review): ReviewDetail {
  return {
    ...toRunSummary(r),
    sessionId: r.sessionId,
    transcriptPath: r.transcriptPath,
    output: r.output,
    rawOutput: r.rawOutput,
    payload: r.payload,
  };
}

export function toRepoDto(db: HeronDb, repo: Repo): RepoDto {
  return {
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    scope: repo.scope,
    includeDrafts: repo.includeDrafts,
    profileId: repo.profileId,
    trustRepoClaudeConfig: repo.trustRepoClaudeConfig,
    enabled: repo.enabled,
    manualPrs: [...db.getManualPrs(repo.id)].sort((a, b) => b - a),
    openPrCount: db.listPrsForRepo(repo.id).filter((p) => p.state === "open").length,
    lastPolledAt: repo.lastPolledAt,
    lastPollError: repo.lastPollError,
  };
}
