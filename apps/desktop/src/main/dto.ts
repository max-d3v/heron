import {
  feedbackCounts,
  isInScope,
  isIterationActive,
  reviewsAutomatically,
  isTerminal,
  iterationEligibility,
  orderFeedbackItems,
  stripIterationMarker,
  type Feedback,
  type Iteration,
  type IterationState,
  type Pr,
  type Repo,
  type Review,
  type ReviewState,
  type Settings,
} from "@heron/core";
import type { HeronDb, PrListRow } from "@heron/db";
import type {
  FeedbackPanel,
  IterationBadge,
  IterationDetail,
  IterationSummary,
  PrListItem,
  PrStatus,
  RepoDto,
  ReviewDetail,
  RunSummary,
} from "@heron/rpc";
import { groupFeedback } from "./feedback.ts";

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

/** Iterations that aren't finished, for the sidebar badge. */
const LIVE_ITERATION_STATES: readonly IterationState[] = [
  "debouncing",
  "triaging",
  "awaiting_start",
  "held",
  "queued",
  "preparing",
  "running",
  "committing",
  "ready",
  "pushing",
  "replying",
];

/** Ready to push, then feedback waiting for Iterate, then work in progress, then a failure of the latest one. */
function iterationBadgeOf(states: { live: IterationState[]; latest: IterationState | null } | undefined): IterationBadge | null {
  if (!states) return null;
  if (states.live.includes("ready")) return "ready";
  if (states.live.includes("awaiting_start")) return "waiting";
  if (states.live.some((s) => s !== "debouncing")) return "running";
  return states.latest === "failed" ? "failed" : null;
}

export function toPrListItem(
  row: PrListRow,
  repo: { inScope: boolean; reviewsOn: boolean; autoReview: boolean },
  iterationEligible = false,
  iteration: IterationBadge | null = null,
): PrListItem {
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
    inScope: repo.inScope,
    reviewsOn: repo.reviewsOn,
    autoReview: repo.autoReview,
    repoEnabled: row.repoEnabled,
    status: statusOf(latestReview?.state ?? null),
    headUnreviewed: latestReview !== null && isTerminal(latestReview.state) && latestReview.headSha !== pr.headSha,
    latestReviewId: latestReview?.id ?? null,
    latestError: latestReview?.state === "failed" ? latestReview.lastError : null,
    iterationEligible,
    iteration,
    lastActivityAt: pr.lastActivityAt,
  };
}

/** Sidebar rows: open PRs, plus recently closed ones that were reviewed. */
export function listPrItems(db: HeronDb, viewerLogin: string | null): PrListItem[] {
  const repos = new Map(db.listRepos().map((r) => [r.id, r]));
  const cutoff = Date.now() - CLOSED_PR_WINDOW_MS;
  const iterations = db.iterationStatesByPr(LIVE_ITERATION_STATES);
  const out: PrListItem[] = [];
  for (const row of db.listPrRows()) {
    const states = iterations.get(row.pr.id);
    if (row.pr.state !== "open" && ((row.reviewCount === 0 && !states) || row.pr.lastActivityAt < cutoff)) continue;
    const r = repos.get(row.pr.repoId);
    const review = {
      inScope: r ? isInScope(r.scope, row.pr, viewerLogin) : false,
      reviewsOn: r?.reviewEnabled ?? false,
      autoReview: r ? reviewsAutomatically(r, row.pr, viewerLogin) : false,
    };
    const eligible = r ? r.iterationEnabled && iterationEligibility(r, row.pr, viewerLogin).ok : false;
    out.push(toPrListItem(row, review, eligible, iterationBadgeOf(states)));
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
    dryRun: repo.dryRun,
    reviewEnabled: repo.reviewEnabled,
    iterationEnabled: repo.iterationEnabled,
    iterationAutoStart: repo.iterationAutoStart,
    iterationComments: repo.iterationComments,
    iterationProfileId: repo.iterationProfileId,
    iterationAutoPush: repo.iterationAutoPush,
    iterationReply: repo.iterationReply,
    setupCommand: repo.setupCommand,
    useLocalCheckout: repo.useLocalCheckout,
    localCheckoutPath: repo.localCheckoutPath,
    openPrCount: db.listPrsForRepo(repo.id).filter((p) => p.state === "open").length,
    lastPolledAt: repo.lastPolledAt,
    lastPollError: repo.lastPollError,
  };
}

export function toIterationSummary(it: Iteration): IterationSummary {
  const snap = it.profileSnapshot;
  return {
    id: it.id,
    prId: it.prId,
    state: it.state,
    trigger: it.trigger,
    headSha: it.headSha,
    commitSha: it.commitSha,
    commitTitle: it.output?.commitTitle ?? null,
    profileName: snap?.name ?? null,
    model: it.resolvedModel ?? snap?.model ?? null,
    effort: snap?.effort ?? null,
    cwdKind: it.cwdKind,
    attempt: it.attempt,
    runAfter: it.runAfter,
    lastError: it.lastError,
    triageTotal: it.triageTotal,
    triageChange: it.triageChange,
    addressed: it.output ? it.output.items.filter((i) => i.status === "addressed").length : null,
    itemCount: it.items?.length ?? null,
    startedAt: it.startedAt,
    finishedAt: it.finishedAt,
    createdAt: it.createdAt,
    usage: it.usage,
  };
}

function threadComment(f: Feedback) {
  return { author: f.author, body: stripIterationMarker(f.body), createdAt: f.createdAt, heron: f.status === "ignored" };
}

export function toIterationDetail(db: HeronDb, it: Iteration, repo: Repo): IterationDetail {
  const all = db.listFeedbackForPr(it.prId);
  const onGitHub = it.commitSha && (it.state === "replying" || it.state === "pushed");
  return {
    ...toIterationSummary(it),
    sessionId: it.sessionId,
    transcriptPath: it.transcriptPath,
    rawOutput: it.rawOutput,
    commitUrl: onGitHub ? `https://github.com/${repo.owner}/${repo.name}/commit/${it.commitSha}` : null,
    localCheckoutFailed: it.state === "failed" && !!it.profileSnapshot?.localCheckoutPath && repo.useLocalCheckout,
    items: (it.items ?? []).map((item) => {
      const out = it.output?.items.find((o) => o.number === item.number);
      const thread = all.filter((f) => f.kind === item.kind && f.threadRootId === item.threadRootId).sort((a, b) => a.createdAt - b.createdAt);
      return {
        number: item.number,
        kind: item.kind,
        path: item.path,
        line: item.line,
        outdated: item.outdated,
        url: item.url,
        status: out?.status ?? null,
        note: out?.note ?? null,
        comments: thread.map(threadComment),
      };
    }),
  };
}

const OPEN_BATCH: readonly IterationState[] = ["debouncing", "triaging", "awaiting_start", "held"];

/** The Iteration tab's Feedback section: the open batch's comments (with verdicts) and those waiting for the next one. */
export function toFeedbackPanel(db: HeronDb, pr: Pr, repo: Repo, viewerLogin: string | null, settings: Settings): FeedbackPanel {
  const eligibility = iterationEligibility(repo, pr, viewerLogin);
  const its = db.listIterationsForPr(pr.id);
  const batches = its.filter((i) => OPEN_BATCH.includes(i.state));
  const batchIds = new Set(batches.map((b) => b.id));
  const live = new Set(its.filter((i) => isIterationActive(i.state)).map((i) => i.id));
  const all = db.listFeedbackForPr(pr.id);
  const rows = all.filter(
    (f) =>
      f.status !== "ignored" &&
      ((f.iterationId !== null && batchIds.has(f.iterationId)) ||
        (f.status === "unhandled" && (f.iterationId === null || !live.has(f.iterationId)) && feedbackCounts(repo.iterationComments, f.author, viewerLogin))),
  );
  const groups = orderFeedbackItems(groupFeedback(rows, all)).map((g) => {
    const pending = g.rows.some((r) => r.verdict === null);
    const last = g.rows[g.rows.length - 1]!;
    return {
      key: g.key,
      kind: g.kind,
      path: g.path,
      line: g.line,
      outdated: g.outdated,
      url: g.url,
      comments: g.thread.map(threadComment),
      verdict: pending ? null : last.verdict,
      reason: pending ? null : last.reason,
    };
  });
  return {
    enabled: repo.iterationEnabled,
    eligible: eligibility.ok,
    reason: eligibility.ok ? null : eligibility.reason,
    autoStart: repo.iterationAutoStart,
    comments: repo.iterationComments,
    loopCapped: pr.heronPushStreak >= settings.loopCap,
    pushStreak: pr.heronPushStreak,
    batches: batches.map(toIterationSummary),
    groups: eligibility.ok ? groups : [],
  };
}
