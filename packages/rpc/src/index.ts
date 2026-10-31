import { eventIterator, oc, type ContractRouterClient, type InferContractRouterOutputs } from "@orpc/contract";
import { z } from "zod";
import {
  ACTIVITY_KINDS,
  AGENT_STEP_KINDS,
  CWD_KINDS,
  EFFORT_LEVELS,
  FEEDBACK_KINDS,
  ITEM_STATUSES,
  ITERATION_COMMENTS,
  ITERATION_STATES,
  ITERATION_TRIGGERS,
  PROFILE_KINDS,
  PR_STATES,
  REPO_SCOPES,
  REVIEW_STATES,
  REVIEW_TRIGGERS,
  TRIAGE_VERDICTS,
} from "@heron/core";

// ── shared shapes ────────────────────────────────────────────────────────────

const id = z.number().int();
const reviewState = z.enum(REVIEW_STATES);
const effort = z.enum(EFFORT_LEVELS);
const side = z.enum(["LEFT", "RIGHT"]);

/** What the sidebar dot shows: the latest run's state folded into a few buckets. */
export const PR_STATUSES = [
  "not_reviewed",
  "debouncing",
  "queued",
  "running",
  "posted",
  "completed",
  "failed",
  "cancelled",
  "superseded",
] as const;
export const prStatus = z.enum(PR_STATUSES);

/** The sidebar's second badge: what the PR's iterations need or are doing. */
export const ITERATION_BADGES = ["waiting", "running", "ready", "failed"] as const;
export const iterationBadge = z.enum(ITERATION_BADGES);

export const prListItem = z.object({
  id,
  repoId: id,
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  author: z.string(),
  authorAvatarUrl: z.string().nullable(),
  isDraft: z.boolean(),
  state: z.enum(PR_STATES),
  url: z.string(),
  headSha: z.string(),
  /** The repo's review scope covers it (manual covers every PR). */
  inScope: z.boolean(),
  /** Reviews are turned on for the PR's repo. */
  reviewsOn: z.boolean(),
  /** A push starts a review on its own (reviews on, in scope, not manual, drafts allowed). */
  autoReview: z.boolean(),
  /** Reviews or iterations are on for the PR's repo. */
  repoEnabled: z.boolean(),
  status: prStatus,
  /** True when the latest run is for an older SHA than the current head. */
  headUnreviewed: z.boolean(),
  latestReviewId: id.nullable(),
  latestError: z.string().nullable(),
  /** Iterations run on it: iterations are on for its repo, and it's an open PR you opened from a branch in the same repo. */
  iterationEligible: z.boolean(),
  iteration: iterationBadge.nullable(),
  lastActivityAt: z.number(),
});

export const runSummary = z.object({
  id,
  prId: id,
  headSha: z.string(),
  state: reviewState,
  trigger: z.enum(REVIEW_TRIGGERS),
  profileName: z.string().nullable(),
  model: z.string().nullable(),
  effort: effort.nullable(),
  dryRun: z.boolean(),
  attempt: z.number(),
  runAfter: z.number().nullable(),
  lastError: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  createdAt: z.number(),
  githubReviewUrl: z.string().nullable(),
  usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }).nullable(),
});

const diffContextLine = z.object({
  kind: z.enum(["add", "del", "ctx"]),
  oldLine: z.number().nullable(),
  newLine: z.number().nullable(),
  text: z.string(),
});

const reviewComment = z.object({
  path: z.string(),
  line: z.number(),
  side: side.optional(),
  start_line: z.number().optional(),
  start_side: side.optional(),
  body: z.string(),
});

export const reviewDetail = runSummary.extend({
  sessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  output: z.object({ body: z.string(), comments: z.array(reviewComment) }).nullable(),
  rawOutput: z.string().nullable(),
  payload: z
    .object({
      body: z.string(),
      comments: z.array(reviewComment.extend({ context: z.array(diffContextLine) })),
      movedToBody: z.array(reviewComment),
    })
    .nullable(),
});

const usage = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });

export const iterationSummary = z.object({
  id,
  prId: id,
  state: z.enum(ITERATION_STATES),
  trigger: z.enum(ITERATION_TRIGGERS),
  headSha: z.string().nullable(),
  commitSha: z.string().nullable(),
  commitTitle: z.string().nullable(),
  profileName: z.string().nullable(),
  model: z.string().nullable(),
  effort: effort.nullable(),
  cwdKind: z.enum(CWD_KINDS).nullable(),
  attempt: z.number(),
  runAfter: z.number().nullable(),
  lastError: z.string().nullable(),
  triageTotal: z.number(),
  triageChange: z.number(),
  /** Items the agent addressed, out of `itemCount` (once it has reported). */
  addressed: z.number().nullable(),
  itemCount: z.number().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  createdAt: z.number(),
  usage: usage.nullable(),
});

const threadComment = z.object({ author: z.string(), body: z.string(), createdAt: z.number(), heron: z.boolean() });

export const iterationDetail = iterationSummary.extend({
  sessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  rawOutput: z.string().nullable(),
  /** Set once the commit is on GitHub. */
  commitUrl: z.string().nullable(),
  /** Failed in the repo's local checkout, which the repo still uses: the tab offers a re-run in Heron's worktree. */
  localCheckoutFailed: z.boolean(),
  items: z.array(
    z.object({
      number: z.number(),
      kind: z.enum(FEEDBACK_KINDS),
      path: z.string().nullable(),
      line: z.number().nullable(),
      outdated: z.boolean(),
      url: z.string().nullable(),
      status: z.enum(ITEM_STATUSES).nullable(),
      note: z.string().nullable(),
      comments: z.array(threadComment),
    }),
  ),
});

/** One unit of feedback (an inline thread, a review body or a conversation comment) in the open batch. */
export const feedbackGroup = z.object({
  key: z.string(),
  kind: z.enum(FEEDBACK_KINDS),
  path: z.string().nullable(),
  line: z.number().nullable(),
  outdated: z.boolean(),
  url: z.string().nullable(),
  comments: z.array(threadComment),
  verdict: z.enum(TRIAGE_VERDICTS).nullable(),
  reason: z.string().nullable(),
});

export const feedbackPanel = z.object({
  /** Iterations are turned on for the repo. */
  enabled: z.boolean(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  /** The agent starts on its own after triage; off, batches wait for Iterate. */
  autoStart: z.boolean(),
  comments: z.enum(ITERATION_COMMENTS),
  /** Heron pushed `loopCap` times in a row: the PR waits for Iterate until someone else pushes. */
  loopCapped: z.boolean(),
  pushStreak: z.number(),
  /** The open batch (debouncing, triaging, waiting for Iterate or held), newest first. */
  batches: z.array(iterationSummary),
  groups: z.array(feedbackGroup),
});

export const diffFile = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "deleted", "modified", "renamed"]),
  binary: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  hunks: z.array(z.object({ header: z.string(), lines: z.array(diffContextLine) })),
});

export const prDetail = prListItem.extend({
  body: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  changedFiles: z.number().nullable(),
  createdAt: z.number(),
  profileName: z.string().nullable(),
  runs: z.array(runSummary),
  /** Iterations newest first, without batches merged into another. */
  iterations: z.array(iterationSummary),
});

export const prFile = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

export const activity = z.object({
  id,
  prId: id.nullable(),
  reviewId: id.nullable(),
  iterationId: id.nullable(),
  ts: z.number(),
  kind: z.enum(ACTIVITY_KINDS),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
});

export const agentStep = z.object({
  kind: z.enum(AGENT_STEP_KINDS),
  label: z.string(),
  detail: z.string().optional(),
});

export const agentStepEvent = z.object({
  id,
  reviewId: id.nullable(),
  iterationId: id.nullable(),
  ts: z.number(),
  step: agentStep,
});

export const transcriptEntry = z.object({
  index: z.number(),
  type: z.string(),
  summary: z.string(),
  raw: z.string(),
});

export const repo = z.object({
  id,
  owner: z.string(),
  name: z.string(),
  scope: z.enum(REPO_SCOPES),
  includeDrafts: z.boolean(),
  profileId: id.nullable(),
  trustRepoClaudeConfig: z.boolean(),
  dryRun: z.boolean(),
  reviewEnabled: z.boolean(),
  iterationEnabled: z.boolean(),
  iterationAutoStart: z.boolean(),
  iterationComments: z.enum(ITERATION_COMMENTS),
  iterationProfileId: id.nullable(),
  iterationAutoPush: z.boolean(),
  iterationReply: z.boolean(),
  setupCommand: z.string().nullable(),
  useLocalCheckout: z.boolean(),
  localCheckoutPath: z.string().nullable(),
  openPrCount: z.number(),
  lastPolledAt: z.number().nullable(),
  lastPollError: z.string().nullable(),
});

export const repoPatch = z.object({
  scope: z.enum(REPO_SCOPES).optional(),
  includeDrafts: z.boolean().optional(),
  profileId: id.nullable().optional(),
  trustRepoClaudeConfig: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  reviewEnabled: z.boolean().optional(),
  iterationEnabled: z.boolean().optional(),
  iterationAutoStart: z.boolean().optional(),
  iterationComments: z.enum(ITERATION_COMMENTS).optional(),
  iterationProfileId: id.nullable().optional(),
  iterationAutoPush: z.boolean().optional(),
  iterationReply: z.boolean().optional(),
  setupCommand: z.string().trim().max(2000).nullable().optional(),
  useLocalCheckout: z.boolean().optional(),
  localCheckoutPath: z.string().trim().nullable().optional(),
});

export const accessibleRepo = z.object({
  owner: z.string(),
  name: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  pushedAt: z.number().nullable(),
  added: z.boolean(),
});

export const profileEntry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), markdown: z.string() }),
  z.object({ type: z.literal("skill"), skillId: id }),
]);

export const profile = z.object({
  id,
  name: z.string(),
  kind: z.enum(PROFILE_KINDS),
  isDefault: z.boolean(),
  /** Null for iteration profiles (they run Heron's fixed prompt). */
  entry: profileEntry.nullable(),
  model: z.string(),
  effort: effort.nullable(),
  timeoutMin: z.number(),
  maxTurns: z.number(),
});

export const profileInput = profile.extend({
  id: id.optional(),
  name: z.string().trim().min(1),
  model: z.string().trim().min(1),
  timeoutMin: z.number().int().min(1).max(240),
  maxTurns: z.number().int().min(1).max(1000),
});

export const modelOption = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  efforts: z.array(effort),
});

export const skill = z.object({
  id,
  name: z.string(),
  source: z.enum(["imported", "linked"]),
  path: z.string(),
  contentHash: z.string(),
  /** How profiles invoke it. */
  command: z.string(),
  description: z.string().nullable(),
  exists: z.boolean(),
  usedBy: z.array(z.string()),
});

export const skillFiles = z.object({
  skillMd: z.string(),
  files: z.array(z.string()),
  editable: z.boolean(),
});

export const settings = z.object({
  parallelRuns: z.number().int().min(1).max(8),
  iterationParallelRuns: z.number().int().min(1).max(8),
  pollIntervalSec: z.number().int().min(10).max(3600),
  debounceSec: z.number().int().min(0).max(7200),
  iterationDebounceSec: z.number().int().min(0).max(7200),
  loopCap: z.number().int().min(1).max(20),
  launchAtLogin: z.boolean(),
  notifyPosted: z.boolean(),
  notifyFailed: z.boolean(),
  allScopeWarningAck: z.boolean(),
  manualPause: z.boolean(),
  bundledSkills: z.record(z.string(), z.string()),
});

export const queueStatus = z.object({
  paused: z.boolean(),
  reasons: z.array(z.enum(["manual", "limit", "auth", "doctor"])),
  limitUntil: z.number().nullable(),
  message: z.string().nullable(),
  running: z.number(),
  queued: z.number(),
  debouncing: z.number(),
  readyToPush: z.number(),
});

export const doctorCheck = z.object({
  id: z.enum(["git", "gh", "claude"]),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  fix: z.string().nullable(),
});

export const doctorReport = z.object({
  ok: z.boolean(),
  checkedAt: z.number(),
  checks: z.array(doctorCheck),
  viewer: z.object({ login: z.string(), avatarUrl: z.string().nullable() }).nullable(),
});

export const appEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("openPr"), prId: id, tab: z.enum(["iteration"]).optional() }),
  z.object({ kind: z.literal("openSettings") }),
  z.object({ kind: z.literal("config"), what: z.enum(["repos", "profiles", "skills", "settings"]) }),
]);

const byId = z.object({ id });

// ── contract ─────────────────────────────────────────────────────────────────

export const contract = {
  app: {
    info: oc.output(
      z.object({ version: z.string(), dataDir: z.string(), viewerLogin: z.string().nullable(), claudePath: z.string().nullable() }),
    ),
    openExternal: oc.input(z.object({ url: z.url() })),
    revealPath: oc.input(z.object({ path: z.string() })),
    events: oc.output(eventIterator(appEvent)),
  },
  doctor: {
    get: oc.output(doctorReport.nullable()),
    check: oc.output(doctorReport),
  },
  repos: {
    list: oc.output(z.array(repo)),
    available: oc.output(z.array(accessibleRepo)),
    add: oc.input(z.object({ owner: z.string(), name: z.string() })).output(repo),
    update: oc.input(z.object({ id, patch: repoPatch })).output(repo),
    remove: oc.input(byId),
    /** Opens a folder picker for the local checkout; null when cancelled. */
    pickCheckout: oc.input(byId).output(z.string().nullable()),
  },
  profiles: {
    list: oc.output(z.array(profile)),
    save: oc.input(profileInput).output(profile),
    remove: oc.input(byId),
    setDefault: oc.input(byId),
    models: oc.output(z.array(modelOption)),
    outputContract: oc.output(z.string()),
    iterationContract: oc.output(z.string()),
  },
  skills: {
    list: oc.output(z.array(skill)),
    /** Opens a folder picker in the main process and copies the chosen skill in. */
    importFromDialog: oc.output(skill.nullable()),
    linkable: oc.output(z.array(z.object({ name: z.string(), description: z.string().nullable(), linked: z.boolean() }))),
    link: oc.input(z.object({ name: z.string() })).output(skill),
    remove: oc.input(byId),
    files: oc.input(byId).output(skillFiles),
    writeSkillMd: oc.input(z.object({ id, content: z.string() })).output(skill),
    reveal: oc.input(byId),
  },
  settings: {
    get: oc.output(settings),
    update: oc.input(settings.partial()).output(settings),
    diskUsage: oc.output(z.object({ reposBytes: z.number(), worktreesBytes: z.number(), transcriptsBytes: z.number() })),
    clearWorktreeCache: oc.output(z.object({ freedBytes: z.number() })),
  },
  prs: {
    list: oc.output(z.array(prListItem)),
    get: oc.input(byId).output(prDetail),
    files: oc.input(byId).output(z.array(prFile)),
    activity: oc.input(byId).output(z.array(activity)),
    watch: oc.output(eventIterator(z.array(prListItem))),
  },
  reviews: {
    get: oc.input(byId).output(reviewDetail),
    reviewNow: oc.input(z.object({ prId: id })).output(runSummary),
    rerun: oc.input(z.object({ reviewId: id })).output(runSummary),
    cancel: oc.input(z.object({ reviewId: id })),
    transcript: oc.input(byId).output(z.object({ entries: z.array(transcriptEntry), truncated: z.boolean() })),
    steps: oc.input(byId).output(z.array(agentStepEvent)),
    activity: oc.input(z.object({ prId: id })).output(eventIterator(activity)),
    agentSteps: oc.input(z.object({ reviewId: id })).output(eventIterator(agentStepEvent)),
  },
  iterations: {
    get: oc.input(byId).output(iterationDetail),
    feedback: oc.input(z.object({ prId: id })).output(feedbackPanel),
    iterate: oc.input(z.object({ prId: id })).output(iterationSummary),
    push: oc.input(byId).output(iterationSummary),
    discard: oc.input(byId),
    /** Local checkout mode: soft-reset the ready commit off the branch, keeping its changes staged. */
    uncommit: oc.input(byId),
    /** `worktree`: run in Heron's worktree this time, even when the repo uses a local checkout. */
    rerun: oc.input(z.object({ id, worktree: z.boolean().optional() })).output(iterationSummary),
    cancel: oc.input(byId),
    diff: oc.input(byId).output(z.array(diffFile)),
    transcript: oc.input(byId).output(z.object({ entries: z.array(transcriptEntry), truncated: z.boolean() })),
    steps: oc.input(byId).output(z.array(agentStepEvent)),
    agentSteps: oc.input(z.object({ iterationId: id })).output(eventIterator(agentStepEvent)),
  },
  queue: {
    pause: oc,
    resume: oc,
    status: oc.output(eventIterator(queueStatus)),
  },
};

export type Contract = typeof contract;
export type HeronClient = ContractRouterClient<Contract>;
export type Outputs = InferContractRouterOutputs<Contract>;

export type PrStatus = z.infer<typeof prStatus>;
export type PrListItem = z.infer<typeof prListItem>;
export type PrDetail = z.infer<typeof prDetail>;
export type RunSummary = z.infer<typeof runSummary>;
export type ReviewDetail = z.infer<typeof reviewDetail>;
export type IterationBadge = z.infer<typeof iterationBadge>;
export type IterationSummary = z.infer<typeof iterationSummary>;
export type IterationDetail = z.infer<typeof iterationDetail>;
export type FeedbackGroupDto = z.infer<typeof feedbackGroup>;
export type FeedbackPanel = z.infer<typeof feedbackPanel>;
export type DiffFileDto = z.infer<typeof diffFile>;
export type PrFileDto = z.infer<typeof prFile>;
export type ActivityDto = z.infer<typeof activity>;
export type AgentStepEvent = z.infer<typeof agentStepEvent>;
export type TranscriptEntry = z.infer<typeof transcriptEntry>;
export type RepoDto = z.infer<typeof repo>;
export type RepoPatch = z.infer<typeof repoPatch>;
export type AccessibleRepo = z.infer<typeof accessibleRepo>;
export type ProfileDto = z.infer<typeof profile>;
export type ProfileInput = z.infer<typeof profileInput>;
export type ModelOption = z.infer<typeof modelOption>;
export type SkillDto = z.infer<typeof skill>;
export type SkillFiles = z.infer<typeof skillFiles>;
export type SettingsDto = z.infer<typeof settings>;
export type QueueStatusDto = z.infer<typeof queueStatus>;
export type DoctorReport = z.infer<typeof doctorReport>;
export type DoctorCheck = z.infer<typeof doctorCheck>;
export type AppEvent = z.infer<typeof appEvent>;
