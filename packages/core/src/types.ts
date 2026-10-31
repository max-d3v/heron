// Domain types shared by every package. Plain data only: no behaviour, no I/O.

export const REPO_SCOPES = ["all", "mine", "manual"] as const;
export type RepoScope = (typeof REPO_SCOPES)[number];

export const PR_STATES = ["open", "closed", "merged"] as const;
export type PrState = (typeof PR_STATES)[number];

export const REVIEW_STATES = [
  "debouncing",
  "queued",
  "preparing",
  "running",
  "validating",
  "posting",
  "posted",
  "completed",
  "failed",
  "superseded",
  "cancelled",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The pipeline steps that do work. A review in one of these states is "in flight". */
export const STEP_STATES = ["preparing", "running", "validating", "posting"] as const;
export type StepState = (typeof STEP_STATES)[number];

export const REVIEW_TRIGGERS = ["auto", "manual", "rerun"] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

export const ITERATION_STATES = [
  "debouncing",
  "triaging",
  "skipped",
  "awaiting_start",
  "held",
  "queued",
  "preparing",
  "running",
  "committing",
  "ready",
  "pushing",
  "replying",
  "pushed",
  "no_changes",
  "discarded",
  "uncommitted",
  "failed",
  "stale",
  "cancelled",
] as const;
export type IterationState = (typeof ITERATION_STATES)[number];

/** The iteration steps that do work. An iteration in one of these states is "in flight". */
export const ITERATION_STEP_STATES = ["preparing", "running", "committing", "pushing", "replying"] as const;
export type IterationStepState = (typeof ITERATION_STEP_STATES)[number];

/** feedback: new comments were triaged; rerun: Re-run; stale: the head moved, so the same comments run again. */
export const ITERATION_TRIGGERS = ["feedback", "rerun", "stale"] as const;
export type IterationTrigger = (typeof ITERATION_TRIGGERS)[number];

/** Which comments an iteration works on: all (anyone's, bots included) or mine (yours, Heron's reviews included). */
export const ITERATION_COMMENTS = ["all", "mine"] as const;
export type IterationComments = (typeof ITERATION_COMMENTS)[number];

export const PROFILE_KINDS = ["review", "iteration"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface Repo {
  id: number;
  owner: string;
  name: string;
  scope: RepoScope;
  includeDrafts: boolean;
  profileId: number | null;
  trustRepoClaudeConfig: boolean;
  /** Reviews run on this repo's PRs (on by default). */
  reviewEnabled: boolean;
  /** Iterations run on this repo's PRs (off by default). With both off, the repo isn't polled. */
  iterationEnabled: boolean;
  /** The agent starts on its own after triage; off, the batch waits for Iterate. */
  iterationAutoStart: boolean;
  iterationComments: IterationComments;
  iterationProfileId: number | null;
  iterationAutoPush: boolean;
  iterationReply: boolean;
  /** Run in the iteration worktree before the agent (e.g. `pnpm install`). Not used with a local checkout. */
  setupCommand: string | null;
  /** Iterate in the user's own checkout (`localCheckoutPath`) instead of a worktree of Heron's clone. */
  useLocalCheckout: boolean;
  /** Remembered while `useLocalCheckout` is off. */
  localCheckoutPath: string | null;
  etag: string | null;
  /** False until the first poll has recorded the PRs that were already open (no backfill). */
  initialSyncDone: boolean;
  lastPolledAt: number | null;
  lastPollError: string | null;
  createdAt: number;
}

export interface Pr {
  id: number;
  repoId: number;
  number: number;
  title: string;
  body: string;
  author: string;
  authorAvatarUrl: string | null;
  isDraft: boolean;
  headSha: string;
  headRef: string;
  /** `owner/name` of the repo the head branch lives in; differs from the PR's repo for forks. */
  headRepo: string | null;
  baseRef: string;
  baseSha: string;
  state: PrState;
  url: string;
  /** Heron pushes in a row with no other push in between (the loop cap). */
  heronPushStreak: number;
  /** The PR's `updatedAt` when its comments were last fetched into `feedback`. */
  feedbackSyncedAt: number | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every review/activity change; the sidebar sorts by it. */
  lastActivityAt: number;
}

export type ProfileEntry =
  | { type: "prompt"; markdown: string }
  | { type: "skill"; skillId: number };

export interface Profile {
  id: number;
  name: string;
  kind: ProfileKind;
  /** One default per kind. */
  isDefault: boolean;
  /** Review profiles only: iteration profiles run Heron's fixed prompt. */
  entry: ProfileEntry | null;
  model: string;
  effort: EffortLevel | null;
  timeoutMin: number;
  maxTurns: number;
}

export type SkillSource = "imported" | "linked";

export interface Skill {
  id: number;
  name: string;
  source: SkillSource;
  path: string;
  contentHash: string;
}

/** Frozen copy of everything that shaped a run, so later edits don't rewrite history. */
export interface ProfileSnapshot {
  profileId: number;
  name: string;
  entry:
    | { type: "prompt"; markdown: string }
    | { type: "skill"; skillId: number; skillName: string; source: SkillSource; contentHash: string };
  model: string;
  effort: EffortLevel | null;
  timeoutMin: number;
  maxTurns: number;
  trustRepoClaudeConfig: boolean;
  dryRun: boolean;
}

/** Frozen copy of the iteration profile and repo settings an iteration runs with. */
export interface IterationSnapshot {
  profileId: number;
  name: string;
  model: string;
  effort: EffortLevel | null;
  timeoutMin: number;
  maxTurns: number;
  trustRepoClaudeConfig: boolean;
  dryRun: boolean;
  autoPush: boolean;
  reply: boolean;
  setupCommand: string | null;
  localCheckoutPath: string | null;
}

/** Tokens a run spent, summed over every model call (subagents included). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Review {
  id: number;
  prId: number;
  headSha: string;
  state: ReviewState;
  trigger: ReviewTrigger;
  runAfter: number | null;
  attempt: number;
  /** When a retry is scheduled, the step it resumes at (instead of starting over). */
  retryStep: StepState | null;
  lastError: string | null;
  pid: number | null;
  sessionId: string | null;
  profileSnapshot: ProfileSnapshot | null;
  resolvedModel: string | null;
  transcriptPath: string | null;
  /** What the agent returned (validated against the output schema). */
  output: ReviewOutput | null;
  /** The agent's raw final text, kept when the structured output could not be parsed. */
  rawOutput: string | null;
  /** What we post: the output after diff validation. */
  payload: ReviewPayload | null;
  githubReviewId: number | null;
  githubReviewUrl: string | null;
  /** Summed across attempts, since a retried run spends tokens again. */
  usage: TokenUsage | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}

/** review: a review's body; inline: a review comment or a reply in its thread; conversation: a comment on the PR itself. */
export const FEEDBACK_KINDS = ["review", "inline", "conversation"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** ignored: Heron's own iteration replies, which never count. */
export const FEEDBACK_STATUSES = ["unhandled", "handled", "ignored"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const TRIAGE_VERDICTS = ["change", "no-change"] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

/** A comment as fetched from GitHub. */
export interface ObservedFeedback {
  kind: FeedbackKind;
  githubId: number;
  /** Inline: the thread's first comment (GitHub's `in_reply_to_id` always points there). Others: the comment itself. */
  threadRootId: number;
  author: string;
  body: string;
  url: string | null;
  path: string | null;
  line: number | null;
  /** Inline comments on code that has changed since. */
  outdated: boolean;
  diffHunk: string | null;
  /** Review bodies: APPROVED, CHANGES_REQUESTED, COMMENTED… */
  reviewState: string | null;
  createdAt: number;
  /** Carries Heron's iteration marker. */
  heronReply: boolean;
}

export interface Feedback extends Omit<ObservedFeedback, "heronReply"> {
  id: number;
  prId: number;
  verdict: TriageVerdict | null;
  reason: string | null;
  /** The iteration that claimed it (the latest one). */
  iterationId: number | null;
  status: FeedbackStatus;
  handledAt: number | null;
  observedAt: number;
}

/** One numbered entry of an iteration's prompt: an inline thread, a review body or a conversation comment. */
export interface IterationItem {
  number: number;
  kind: FeedbackKind;
  threadRootId: number;
  /** The claimed feedback rows it stands for. */
  feedbackIds: number[];
  path: string | null;
  line: number | null;
  outdated: boolean;
  url: string | null;
}

export const ITEM_STATUSES = ["addressed", "not_addressed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface IterationOutputItem {
  number: number;
  status: ItemStatus;
  note: string;
}

export interface IterationOutput {
  commitTitle: string;
  items: IterationOutputItem[];
}

/** Where an iteration's agent runs: Heron's worktree of the PR head, or the user's own checkout. */
export const CWD_KINDS = ["worktree", "local"] as const;
export type CwdKind = (typeof CWD_KINDS)[number];

export interface Iteration {
  id: number;
  prId: number;
  state: IterationState;
  trigger: IterationTrigger;
  /** The PR head the agent started from (set while preparing). */
  headSha: string | null;
  runAfter: number | null;
  attempt: number;
  /** When a retry is scheduled, the step it resumes at. */
  retryStep: IterationStepState | null;
  lastError: string | null;
  pid: number | null;
  sessionId: string | null;
  profileSnapshot: IterationSnapshot | null;
  resolvedModel: string | null;
  transcriptPath: string | null;
  cwdKind: CwdKind | null;
  items: IterationItem[] | null;
  output: IterationOutput | null;
  rawOutput: string | null;
  commitSha: string | null;
  /** Items triaged for this run, and how many of them asked for a change (merged batches add up). */
  triageTotal: number;
  triageChange: number;
  /** Set when this batch was folded into another waiting one. */
  mergedInto: number | null;
  usage: TokenUsage | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}

export type Side = "LEFT" | "RIGHT";

export interface ReviewComment {
  path: string;
  line: number;
  side?: Side;
  start_line?: number;
  start_side?: Side;
  body: string;
}

export interface ReviewOutput {
  body: string;
  comments: ReviewComment[];
}

export interface DiffContextLine {
  kind: "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface PayloadComment extends ReviewComment {
  /** A few diff lines around the comment, for display in the app. */
  context: DiffContextLine[];
}

export interface ReviewPayload {
  /** Final body, including comments moved out of the diff, without the hidden marker. */
  body: string;
  comments: PayloadComment[];
  /** Comments that pointed outside the diff and were folded into the body. */
  movedToBody: ReviewComment[];
}

export const ACTIVITY_KINDS = [
  "pr.observed",
  "pr.head_changed",
  "pr.draft_changed",
  "pr.closed",
  "pr.reopened",
  "review.created",
  "review.state",
  "review.retry",
  "review.error",
  "review.posted",
  "feedback.observed",
  "feedback.triaged",
  "iteration.created",
  "iteration.state",
  "iteration.retry",
  "iteration.error",
  "agent.step",
  "queue.paused",
  "queue.resumed",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface Activity {
  id: number;
  prId: number | null;
  reviewId: number | null;
  iterationId: number | null;
  ts: number;
  kind: ActivityKind;
  message: string;
  data: Record<string, unknown> | null;
}

export const AGENT_STEP_KINDS = [
  "read",
  "search",
  "bash",
  "edit",
  "web",
  "task",
  "skill",
  "plan",
  "text",
  "output",
  "system",
  "other",
] as const;
export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

export interface AgentStep {
  kind: AgentStepKind;
  label: string;
  detail?: string;
}

export type PauseReason = "manual" | "limit" | "auth" | "doctor";

export interface QueueStatus {
  paused: boolean;
  reasons: PauseReason[];
  /** For a limit pause: when the queue resumes on its own (epoch ms). */
  limitUntil: number | null;
  message: string | null;
  /** Agent runs in progress, reviews and iterations. */
  running: number;
  queued: number;
  debouncing: number;
  /** Iterations whose commit waits for Push. */
  readyToPush: number;
}

export interface Settings {
  parallelRuns: number;
  pollIntervalSec: number;
  debounceSec: number;
  /** An iteration's batch starts this long after the newest unhandled comment. */
  iterationDebounceSec: number;
  /** Heron pushes in a row (with no other push) after which a PR waits for Iterate. */
  loopCap: number;
  dryRun: boolean;
  launchAtLogin: boolean;
  notifyPosted: boolean;
  notifyFailed: boolean;
  /** The one-time "all scope" warning was acknowledged. */
  allScopeWarningAck: boolean;
  /** Pause from the menu bar survives a restart. */
  manualPause: boolean;
  /** Each skill that ships with Heron → hash of the version last installed. Removing one doesn't bring it back. */
  bundledSkills: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  parallelRuns: 2,
  pollIntervalSec: 10,
  debounceSec: 5,
  iterationDebounceSec: 30,
  loopCap: 3,
  dryRun: false,
  launchAtLogin: false,
  notifyPosted: true,
  notifyFailed: true,
  allScopeWarningAck: false,
  manualPause: false,
  bundledSkills: {},
};

export const DEFAULT_PROFILE = {
  timeoutMin: 20,
  maxTurns: 100,
} as const;

export const DEFAULT_ITERATION_PROFILE = {
  timeoutMin: 30,
  maxTurns: 150,
} as const;
