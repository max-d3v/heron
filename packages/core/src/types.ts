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
  enabled: boolean;
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
  baseRef: string;
  baseSha: string;
  state: PrState;
  url: string;
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
  isDefault: boolean;
  entry: ProfileEntry;
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
  "agent.step",
  "queue.paused",
  "queue.resumed",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface Activity {
  id: number;
  prId: number | null;
  reviewId: number | null;
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
  running: number;
  queued: number;
  debouncing: number;
}

export interface Settings {
  parallelRuns: number;
  pollIntervalSec: number;
  debounceMin: number;
  dryRun: boolean;
  launchAtLogin: boolean;
  notifyPosted: boolean;
  notifyFailed: boolean;
  /** The one-time "all scope" warning was acknowledged. */
  allScopeWarningAck: boolean;
  /** Pause from the menu bar survives a restart. */
  manualPause: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  parallelRuns: 2,
  pollIntervalSec: 60,
  debounceMin: 5,
  dryRun: false,
  launchAtLogin: false,
  notifyPosted: true,
  notifyFailed: true,
  allScopeWarningAck: false,
  manualPause: false,
};

export const DEFAULT_PROFILE = {
  timeoutMin: 20,
  maxTurns: 100,
} as const;
