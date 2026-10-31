import Database from "better-sqlite3";
import {
  DEFAULT_SETTINGS,
  type Activity,
  type ActivityKind,
  type EffortLevel,
  type Feedback,
  type FeedbackKind,
  type FeedbackStatus,
  type Iteration,
  type IterationItem,
  type IterationComments,
  type IterationOutput,
  type IterationSnapshot,
  type IterationState,
  type IterationStepState,
  type IterationTrigger,
  type ObservedFeedback,
  type ObservedPr,
  type Pr,
  type PrState,
  type Profile,
  type ProfileEntry,
  type ProfileKind,
  type ProfileSnapshot,
  type Repo,
  type RepoScope,
  type Review,
  type ReviewOutput,
  type ReviewPayload,
  type ReviewState,
  type ReviewTrigger,
  type Settings,
  type Skill,
  type SkillSource,
  type StepState,
  type TokenUsage,
  type TriageVerdict,
} from "@heron/core";
import { MIGRATIONS } from "./migrations.ts";

type Row = Record<string, unknown>;

const bool = (v: unknown) => v === 1 || v === true;
const json = <T>(v: unknown): T | null => (typeof v === "string" && v !== "" ? (JSON.parse(v) as T) : null);
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toRepo(r: Row): Repo {
  return {
    id: Number(r.id),
    owner: String(r.owner),
    name: String(r.name),
    scope: r.scope as RepoScope,
    includeDrafts: bool(r.include_drafts),
    profileId: num(r.profile_id),
    trustRepoClaudeConfig: bool(r.trust_repo_claude_config),
    reviewEnabled: bool(r.review_enabled),
    iterationEnabled: bool(r.iteration_enabled),
    iterationAutoStart: bool(r.iteration_auto_start),
    iterationComments: r.iteration_comments as IterationComments,
    iterationProfileId: num(r.iteration_profile_id),
    iterationAutoPush: bool(r.iteration_auto_push),
    iterationReply: bool(r.iteration_reply),
    setupCommand: str(r.setup_command),
    useLocalCheckout: bool(r.use_local_checkout),
    localCheckoutPath: str(r.local_checkout_path),
    etag: str(r.etag),
    initialSyncDone: bool(r.initial_sync_done),
    lastPolledAt: num(r.last_polled_at),
    lastPollError: str(r.last_poll_error),
    createdAt: Number(r.created_at),
  };
}

function toPr(r: Row): Pr {
  return {
    id: Number(r.id),
    repoId: Number(r.repo_id),
    number: Number(r.number),
    title: String(r.title),
    body: String(r.body ?? ""),
    author: String(r.author),
    authorAvatarUrl: str(r.author_avatar_url),
    isDraft: bool(r.is_draft),
    headSha: String(r.head_sha),
    headRef: String(r.head_ref),
    headRepo: str(r.head_repo),
    baseRef: String(r.base_ref),
    baseSha: String(r.base_sha),
    state: r.state as PrState,
    url: String(r.url),
    heronPushStreak: Number(r.heron_push_streak ?? 0),
    feedbackSyncedAt: num(r.feedback_synced_at),
    additions: num(r.additions),
    deletions: num(r.deletions),
    changedFiles: num(r.changed_files),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastActivityAt: Number(r.last_activity_at),
  };
}

function toReview(r: Row): Review {
  return {
    id: Number(r.id),
    prId: Number(r.pr_id),
    headSha: String(r.head_sha),
    state: r.state as ReviewState,
    trigger: r.trigger_kind as ReviewTrigger,
    runAfter: num(r.run_after),
    attempt: Number(r.attempt),
    retryStep: (r.retry_step as StepState | null) ?? null,
    lastError: str(r.last_error),
    pid: num(r.pid),
    sessionId: str(r.session_id),
    profileSnapshot: json<ProfileSnapshot>(r.profile_snapshot_json),
    resolvedModel: str(r.resolved_model),
    transcriptPath: str(r.transcript_path),
    output: json<ReviewOutput>(r.output_json),
    rawOutput: str(r.raw_output),
    payload: json<ReviewPayload>(r.payload_json),
    githubReviewId: num(r.github_review_id),
    githubReviewUrl: str(r.github_review_url),
    usage: json<TokenUsage>(r.usage_json),
    startedAt: num(r.started_at),
    finishedAt: num(r.finished_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastActivityAt: Number(r.last_activity_at),
  };
}

function toActivity(r: Row): Activity {
  return {
    id: Number(r.id),
    prId: num(r.pr_id),
    reviewId: num(r.review_id),
    iterationId: num(r.iteration_id),
    ts: Number(r.ts),
    kind: r.kind as ActivityKind,
    message: String(r.message),
    data: json<Record<string, unknown>>(r.data_json),
  };
}

function toProfile(r: Row): Profile {
  const kind = (r.kind as ProfileKind | null) ?? "review";
  const entry: ProfileEntry | null =
    kind === "iteration"
      ? null
      : r.entry_type === "skill"
        ? { type: "skill", skillId: Number(r.skill_id ?? 0) }
        : { type: "prompt", markdown: String(r.prompt_md ?? "") };
  return {
    id: Number(r.id),
    name: String(r.name),
    kind,
    isDefault: bool(r.is_default),
    entry,
    model: String(r.model),
    effort: (r.effort as EffortLevel | null) ?? null,
    timeoutMin: Number(r.timeout_min),
    maxTurns: Number(r.max_turns),
  };
}

function toIteration(r: Row): Iteration {
  return {
    id: Number(r.id),
    prId: Number(r.pr_id),
    state: r.state as IterationState,
    trigger: r.trigger_kind as IterationTrigger,
    headSha: str(r.head_sha),
    runAfter: num(r.run_after),
    attempt: Number(r.attempt),
    retryStep: (r.retry_step as IterationStepState | null) ?? null,
    lastError: str(r.last_error),
    pid: num(r.pid),
    sessionId: str(r.session_id),
    profileSnapshot: json<IterationSnapshot>(r.profile_snapshot_json),
    resolvedModel: str(r.resolved_model),
    transcriptPath: str(r.transcript_path),
    cwdKind: (r.cwd_kind as Iteration["cwdKind"]) ?? null,
    items: json<IterationItem[]>(r.items_json),
    output: json<IterationOutput>(r.output_json),
    rawOutput: str(r.raw_output),
    commitSha: str(r.commit_sha),
    triageTotal: Number(r.triage_total),
    triageChange: Number(r.triage_change),
    mergedInto: num(r.merged_into),
    usage: json<TokenUsage>(r.usage_json),
    startedAt: num(r.started_at),
    finishedAt: num(r.finished_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastActivityAt: Number(r.last_activity_at),
  };
}

function toFeedback(r: Row): Feedback {
  return {
    id: Number(r.id),
    prId: Number(r.pr_id),
    githubId: Number(r.github_id),
    kind: r.kind as FeedbackKind,
    threadRootId: Number(r.thread_root_id),
    author: String(r.author),
    body: String(r.body),
    url: str(r.url),
    path: str(r.path),
    line: num(r.line),
    outdated: bool(r.outdated),
    diffHunk: str(r.diff_hunk),
    reviewState: str(r.review_state),
    createdAt: Number(r.created_at),
    verdict: (r.verdict as TriageVerdict | null) ?? null,
    reason: str(r.reason),
    iterationId: num(r.iteration_id),
    status: r.status as FeedbackStatus,
    handledAt: num(r.handled_at),
    observedAt: Number(r.observed_at),
  };
}

function toSkill(r: Row): Skill {
  return {
    id: Number(r.id),
    name: String(r.name),
    source: r.source as SkillSource,
    path: String(r.path),
    contentHash: String(r.content_hash),
  };
}

/** Review fields that can be written directly (camelCase → column). */
export interface ReviewPatch {
  state?: ReviewState;
  runAfter?: number | null;
  attempt?: number;
  retryStep?: StepState | null;
  lastError?: string | null;
  pid?: number | null;
  sessionId?: string | null;
  profileSnapshot?: ProfileSnapshot | null;
  resolvedModel?: string | null;
  transcriptPath?: string | null;
  output?: ReviewOutput | null;
  rawOutput?: string | null;
  payload?: ReviewPayload | null;
  githubReviewId?: number | null;
  githubReviewUrl?: string | null;
  usage?: TokenUsage | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

const REVIEW_COLUMNS: Record<keyof ReviewPatch, [string, (v: never) => unknown]> = {
  state: ["state", (v) => v],
  runAfter: ["run_after", (v) => v],
  attempt: ["attempt", (v) => v],
  retryStep: ["retry_step", (v) => v],
  lastError: ["last_error", (v) => v],
  pid: ["pid", (v) => v],
  sessionId: ["session_id", (v) => v],
  profileSnapshot: ["profile_snapshot_json", (v) => (v === null ? null : JSON.stringify(v))],
  resolvedModel: ["resolved_model", (v) => v],
  transcriptPath: ["transcript_path", (v) => v],
  output: ["output_json", (v) => (v === null ? null : JSON.stringify(v))],
  rawOutput: ["raw_output", (v) => v],
  payload: ["payload_json", (v) => (v === null ? null : JSON.stringify(v))],
  githubReviewId: ["github_review_id", (v) => v],
  githubReviewUrl: ["github_review_url", (v) => v],
  usage: ["usage_json", (v) => (v === null ? null : JSON.stringify(v))],
  startedAt: ["started_at", (v) => v],
  finishedAt: ["finished_at", (v) => v],
};

/** Iteration fields that can be written directly (camelCase → column). */
export interface IterationPatch {
  state?: IterationState;
  headSha?: string | null;
  runAfter?: number | null;
  attempt?: number;
  retryStep?: IterationStepState | null;
  lastError?: string | null;
  pid?: number | null;
  sessionId?: string | null;
  profileSnapshot?: IterationSnapshot | null;
  resolvedModel?: string | null;
  transcriptPath?: string | null;
  cwdKind?: Iteration["cwdKind"];
  items?: IterationItem[] | null;
  output?: IterationOutput | null;
  rawOutput?: string | null;
  commitSha?: string | null;
  triageTotal?: number;
  triageChange?: number;
  mergedInto?: number | null;
  usage?: TokenUsage | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

const asJson = (v: unknown) => (v === null ? null : JSON.stringify(v));

const ITERATION_COLUMNS: Record<keyof IterationPatch, [string, (v: never) => unknown]> = {
  state: ["state", (v) => v],
  headSha: ["head_sha", (v) => v],
  runAfter: ["run_after", (v) => v],
  attempt: ["attempt", (v) => v],
  retryStep: ["retry_step", (v) => v],
  lastError: ["last_error", (v) => v],
  pid: ["pid", (v) => v],
  sessionId: ["session_id", (v) => v],
  profileSnapshot: ["profile_snapshot_json", asJson],
  resolvedModel: ["resolved_model", (v) => v],
  transcriptPath: ["transcript_path", (v) => v],
  cwdKind: ["cwd_kind", (v) => v],
  items: ["items_json", asJson],
  output: ["output_json", asJson],
  rawOutput: ["raw_output", (v) => v],
  commitSha: ["commit_sha", (v) => v],
  triageTotal: ["triage_total", (v) => v],
  triageChange: ["triage_change", (v) => v],
  mergedInto: ["merged_into", (v) => v],
  usage: ["usage_json", asJson],
  startedAt: ["started_at", (v) => v],
  finishedAt: ["finished_at", (v) => v],
};

/** Feedback fields the pipeline writes. */
export interface FeedbackPatch {
  verdict?: TriageVerdict | null;
  reason?: string | null;
  iterationId?: number | null;
  status?: FeedbackStatus;
  handledAt?: number | null;
}

const FEEDBACK_COLUMNS: Record<keyof FeedbackPatch, string> = {
  verdict: "verdict",
  reason: "reason",
  iterationId: "iteration_id",
  status: "status",
  handledAt: "handled_at",
};

export interface NewActivity {
  prId: number | null;
  reviewId: number | null;
  iterationId?: number | null;
  kind: ActivityKind;
  message: string;
  data?: Record<string, unknown> | null;
  ts?: number;
}

export interface PrListRow {
  pr: Pr;
  owner: string;
  repoName: string;
  repoEnabled: boolean;
  latestReview: Pick<Review, "id" | "state" | "headSha" | "updatedAt" | "lastError"> | null;
  reviewCount: number;
}

export class HeronDb {
  readonly sql: Database.Database;

  constructor(file: string) {
    this.sql = new Database(file);
    this.sql.pragma("journal_mode = WAL");
    this.sql.pragma("foreign_keys = ON");
    this.sql.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.sql.close();
  }

  private migrate(): void {
    const current = this.sql.pragma("user_version", { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.sql.transaction(() => {
        this.sql.exec(MIGRATIONS[v]!);
        this.sql.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  /** Run `fn` in one transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    return this.sql.transaction(fn)();
  }

  // ── settings ────────────────────────────────────────────────────────────

  getSettings(): Settings {
    const rows = this.sql.prepare("SELECT key, value_json FROM settings").all() as Row[];
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      const key = String(r.key) as keyof Settings;
      if (key in out) (out as unknown as Record<string, unknown>)[key] = JSON.parse(String(r.value_json));
    }
    return out;
  }

  setSettings(patch: Partial<Settings>): Settings {
    const stmt = this.sql.prepare(
      "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
    );
    this.tx(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) stmt.run(k, JSON.stringify(v));
      }
    });
    return this.getSettings();
  }

  // ── repos ───────────────────────────────────────────────────────────────

  listRepos(): Repo[] {
    return (this.sql.prepare("SELECT * FROM repos ORDER BY owner, name").all() as Row[]).map(toRepo);
  }

  getRepo(id: number): Repo | null {
    const r = this.sql.prepare("SELECT * FROM repos WHERE id = ?").get(id) as Row | undefined;
    return r ? toRepo(r) : null;
  }

  addRepo(input: { owner: string; name: string; scope: RepoScope; profileId: number | null }): Repo {
    const info = this.sql
      .prepare("INSERT INTO repos (owner, name, scope, profile_id, iteration_comments, created_at) VALUES (?, ?, ?, ?, 'all', ?)")
      .run(input.owner, input.name, input.scope, input.profileId, Date.now());
    return this.getRepo(Number(info.lastInsertRowid))!;
  }

  updateRepo(
    id: number,
    patch: Partial<
      Pick<
        Repo,
        | "scope"
        | "includeDrafts"
        | "profileId"
        | "trustRepoClaudeConfig"
        | "reviewEnabled"
        | "iterationEnabled"
        | "iterationAutoStart"
        | "iterationComments"
        | "iterationProfileId"
        | "iterationAutoPush"
        | "iterationReply"
        | "setupCommand"
        | "useLocalCheckout"
        | "localCheckoutPath"
        | "etag"
        | "initialSyncDone"
        | "lastPolledAt"
        | "lastPollError"
      >
    >,
  ): Repo {
    const cols: Record<string, unknown> = {};
    if (patch.scope !== undefined) cols.scope = patch.scope;
    if (patch.includeDrafts !== undefined) cols.include_drafts = patch.includeDrafts ? 1 : 0;
    if (patch.profileId !== undefined) cols.profile_id = patch.profileId;
    if (patch.trustRepoClaudeConfig !== undefined) cols.trust_repo_claude_config = patch.trustRepoClaudeConfig ? 1 : 0;
    if (patch.reviewEnabled !== undefined) cols.review_enabled = patch.reviewEnabled ? 1 : 0;
    if (patch.iterationEnabled !== undefined) cols.iteration_enabled = patch.iterationEnabled ? 1 : 0;
    if (patch.iterationAutoStart !== undefined) cols.iteration_auto_start = patch.iterationAutoStart ? 1 : 0;
    if (patch.iterationComments !== undefined) cols.iteration_comments = patch.iterationComments;
    if (patch.iterationProfileId !== undefined) cols.iteration_profile_id = patch.iterationProfileId;
    if (patch.iterationAutoPush !== undefined) cols.iteration_auto_push = patch.iterationAutoPush ? 1 : 0;
    if (patch.iterationReply !== undefined) cols.iteration_reply = patch.iterationReply ? 1 : 0;
    if (patch.setupCommand !== undefined) cols.setup_command = patch.setupCommand;
    if (patch.useLocalCheckout !== undefined) cols.use_local_checkout = patch.useLocalCheckout ? 1 : 0;
    if (patch.localCheckoutPath !== undefined) cols.local_checkout_path = patch.localCheckoutPath;
    if (patch.etag !== undefined) cols.etag = patch.etag;
    if (patch.initialSyncDone !== undefined) cols.initial_sync_done = patch.initialSyncDone ? 1 : 0;
    if (patch.lastPolledAt !== undefined) cols.last_polled_at = patch.lastPolledAt;
    if (patch.lastPollError !== undefined) cols.last_poll_error = patch.lastPollError;
    this.updateRow("repos", id, cols);
    return this.getRepo(id)!;
  }

  deleteRepo(id: number): void {
    this.sql.prepare("DELETE FROM repos WHERE id = ?").run(id);
  }

  // ── prs ─────────────────────────────────────────────────────────────────

  getPr(id: number): Pr | null {
    const r = this.sql.prepare("SELECT * FROM prs WHERE id = ?").get(id) as Row | undefined;
    return r ? toPr(r) : null;
  }

  listPrsForRepo(repoId: number): Pr[] {
    return (this.sql.prepare("SELECT * FROM prs WHERE repo_id = ? ORDER BY number DESC").all(repoId) as Row[]).map(toPr);
  }

  listOpenPrs(): Pr[] {
    return (this.sql.prepare("SELECT * FROM prs WHERE state = 'open'").all() as Row[]).map(toPr);
  }

  /** Insert or refresh a PR from GitHub's open list. */
  upsertObservedPr(repoId: number, o: ObservedPr): Pr {
    const now = Date.now();
    this.sql
      .prepare(
        `INSERT INTO prs (repo_id, number, title, body, author, author_avatar_url, is_draft, head_sha, head_ref,
                          head_repo, base_ref, base_sha, state, url, created_at, updated_at, last_activity_at)
         VALUES (@repoId, @number, @title, @body, @author, @avatar, @draft, @headSha, @headRef,
                 @headRepo, @baseRef, @baseSha, 'open', @url, @createdAt, @updatedAt, @now)
         ON CONFLICT(repo_id, number) DO UPDATE SET
           title = excluded.title, body = excluded.body, author = excluded.author,
           author_avatar_url = excluded.author_avatar_url, is_draft = excluded.is_draft,
           head_sha = excluded.head_sha, head_ref = excluded.head_ref, head_repo = excluded.head_repo,
           base_ref = excluded.base_ref,
           base_sha = excluded.base_sha, state = 'open', url = excluded.url, updated_at = excluded.updated_at`,
      )
      .run({
        repoId,
        number: o.number,
        title: o.title,
        body: o.body,
        author: o.author,
        avatar: o.authorAvatarUrl,
        draft: o.isDraft ? 1 : 0,
        headSha: o.headSha,
        headRef: o.headRef,
        headRepo: o.headRepo,
        baseRef: o.baseRef,
        baseSha: o.baseSha,
        url: o.url,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        now,
      });
    const r = this.sql.prepare("SELECT * FROM prs WHERE repo_id = ? AND number = ?").get(repoId, o.number) as Row;
    return toPr(r);
  }

  updatePr(
    id: number,
    patch: Partial<Pick<Pr, "state" | "additions" | "deletions" | "changedFiles" | "lastActivityAt" | "heronPushStreak" | "feedbackSyncedAt">>,
  ): void {
    const cols: Record<string, unknown> = {};
    if (patch.heronPushStreak !== undefined) cols.heron_push_streak = patch.heronPushStreak;
    if (patch.feedbackSyncedAt !== undefined) cols.feedback_synced_at = patch.feedbackSyncedAt;
    if (patch.state !== undefined) cols.state = patch.state;
    if (patch.additions !== undefined) cols.additions = patch.additions;
    if (patch.deletions !== undefined) cols.deletions = patch.deletions;
    if (patch.changedFiles !== undefined) cols.changed_files = patch.changedFiles;
    if (patch.lastActivityAt !== undefined) cols.last_activity_at = patch.lastActivityAt;
    this.updateRow("prs", id, cols);
  }

  touchPr(id: number, ts = Date.now()): void {
    this.sql.prepare("UPDATE prs SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?").run(ts, id);
  }

  /** Every PR with its repo and latest review, newest activity first. */
  listPrRows(): PrListRow[] {
    const rows = this.sql
      .prepare(
        `SELECT p.*, r.owner AS r_owner, r.name AS r_name, (r.review_enabled OR r.iteration_enabled) AS r_enabled,
                lr.id AS lr_id, lr.state AS lr_state, lr.head_sha AS lr_head_sha,
                lr.updated_at AS lr_updated_at, lr.last_error AS lr_last_error,
                (SELECT COUNT(*) FROM reviews x WHERE x.pr_id = p.id) AS review_count
         FROM prs p
         JOIN repos r ON r.id = p.repo_id
         LEFT JOIN reviews lr ON lr.id = (SELECT id FROM reviews WHERE pr_id = p.id ORDER BY id DESC LIMIT 1)
         ORDER BY p.last_activity_at DESC, p.updated_at DESC`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      pr: toPr(r),
      owner: String(r.r_owner),
      repoName: String(r.r_name),
      repoEnabled: bool(r.r_enabled),
      latestReview:
        r.lr_id === null || r.lr_id === undefined
          ? null
          : {
              id: Number(r.lr_id),
              state: r.lr_state as ReviewState,
              headSha: String(r.lr_head_sha),
              updatedAt: Number(r.lr_updated_at),
              lastError: str(r.lr_last_error),
            },
      reviewCount: Number(r.review_count),
    }));
  }

  // ── reviews ─────────────────────────────────────────────────────────────

  getReview(id: number): Review | null {
    const r = this.sql.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Row | undefined;
    return r ? toReview(r) : null;
  }

  listReviewsForPr(prId: number): Review[] {
    return (this.sql.prepare("SELECT * FROM reviews WHERE pr_id = ? ORDER BY id DESC").all(prId) as Row[]).map(toReview);
  }

  listReviewsInStates(states: readonly ReviewState[]): Review[] {
    const q = `SELECT * FROM reviews WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY COALESCE(run_after, created_at), id`;
    return (this.sql.prepare(q).all(...states) as Row[]).map(toReview);
  }

  countByState(): Record<string, number> {
    const rows = this.sql.prepare("SELECT state, COUNT(*) AS n FROM reviews GROUP BY state").all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.n)]));
  }

  createReview(input: {
    prId: number;
    headSha: string;
    state: ReviewState;
    trigger: ReviewTrigger;
    runAfter: number | null;
  }): Review {
    const now = Date.now();
    const info = this.sql
      .prepare(
        `INSERT INTO reviews (pr_id, head_sha, state, trigger_kind, run_after, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.prId, input.headSha, input.state, input.trigger, input.runAfter, now, now, now);
    return this.getReview(Number(info.lastInsertRowid))!;
  }

  /**
   * Update a review. With `expectState`, only applies when the row is still in one
   * of those states (guards against a concurrent supersede/cancel) and returns null otherwise.
   */
  updateReview(id: number, patch: ReviewPatch, expectState?: readonly ReviewState[]): Review | null {
    const now = Date.now();
    const sets: string[] = ["updated_at = ?", "last_activity_at = ?"];
    const values: unknown[] = [now, now];
    for (const [key, value] of Object.entries(patch) as [keyof ReviewPatch, never][]) {
      if (value === undefined) continue;
      const [col, enc] = REVIEW_COLUMNS[key];
      sets.push(`${col} = ?`);
      values.push(enc(value));
    }
    let where = "id = ?";
    values.push(id);
    if (expectState && expectState.length > 0) {
      where += ` AND state IN (${expectState.map(() => "?").join(",")})`;
      values.push(...expectState);
    }
    const info = this.sql.prepare(`UPDATE reviews SET ${sets.join(", ")} WHERE ${where}`).run(...values);
    if (info.changes === 0) return null;
    return this.getReview(id);
  }

  /** Add a run's tokens to the review's total (a retried run spends them again). */
  addReviewUsage(id: number, usage: TokenUsage): void {
    this.tx(() => {
      const prev = this.getReview(id)?.usage;
      this.updateReview(id, {
        usage: prev
          ? {
              input: prev.input + usage.input,
              output: prev.output + usage.output,
              cacheRead: prev.cacheRead + usage.cacheRead,
              cacheWrite: prev.cacheWrite + usage.cacheWrite,
            }
          : usage,
      });
    });
  }

  // ── activity ────────────────────────────────────────────────────────────

  appendActivity(a: NewActivity): Activity {
    const ts = a.ts ?? Date.now();
    const info = this.sql
      .prepare("INSERT INTO activity (pr_id, review_id, iteration_id, ts, kind, message, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(a.prId, a.reviewId, a.iterationId ?? null, ts, a.kind, a.message, a.data ? JSON.stringify(a.data) : null);
    if (a.prId !== null) this.touchPr(a.prId, ts);
    return {
      id: Number(info.lastInsertRowid),
      prId: a.prId,
      reviewId: a.reviewId,
      iterationId: a.iterationId ?? null,
      ts,
      kind: a.kind,
      message: a.message,
      data: a.data ?? null,
    };
  }

  listActivityForPr(prId: number, opts: { afterId?: number; limit?: number; includeSteps?: boolean } = {}): Activity[] {
    const steps = opts.includeSteps ? "" : "AND kind != 'agent.step'";
    const rows = this.sql
      .prepare(
        `SELECT * FROM (
           SELECT * FROM activity WHERE pr_id = ? AND id > ? ${steps} ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(prId, opts.afterId ?? 0, opts.limit ?? 500) as Row[];
    return rows.map(toActivity);
  }

  listActivityForReview(reviewId: number, opts: { kind?: ActivityKind; afterId?: number } = {}): Activity[] {
    const kind = opts.kind ? "AND kind = ?" : "";
    const params: unknown[] = [reviewId, opts.afterId ?? 0];
    if (opts.kind) params.push(opts.kind);
    const rows = this.sql
      .prepare(`SELECT * FROM activity WHERE review_id = ? AND id > ? ${kind} ORDER BY id ASC`)
      .all(...params) as Row[];
    return rows.map(toActivity);
  }

  listActivityForIteration(iterationId: number, opts: { kind?: ActivityKind; afterId?: number } = {}): Activity[] {
    const kind = opts.kind ? "AND kind = ?" : "";
    const params: unknown[] = [iterationId, opts.afterId ?? 0];
    if (opts.kind) params.push(opts.kind);
    const rows = this.sql
      .prepare(`SELECT * FROM activity WHERE iteration_id = ? AND id > ? ${kind} ORDER BY id ASC`)
      .all(...params) as Row[];
    return rows.map(toActivity);
  }

  // ── profiles ────────────────────────────────────────────────────────────

  listProfiles(kind?: ProfileKind): Profile[] {
    const rows = kind
      ? this.sql.prepare("SELECT * FROM profiles WHERE kind = ? ORDER BY is_default DESC, name").all(kind)
      : this.sql.prepare("SELECT * FROM profiles ORDER BY kind DESC, is_default DESC, name").all();
    return (rows as Row[]).map(toProfile);
  }

  getProfile(id: number): Profile | null {
    const r = this.sql.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
    return r ? toProfile(r) : null;
  }

  getDefaultProfile(kind: ProfileKind = "review"): Profile | null {
    const r = this.sql.prepare("SELECT * FROM profiles WHERE is_default = 1 AND kind = ?").get(kind) as Row | undefined;
    return r ? toProfile(r) : null;
  }

  /** A profile's kind never changes once created. */
  saveProfile(p: Omit<Profile, "id"> & { id?: number }): Profile {
    return this.tx(() => {
      // Iteration profiles have no entry; the NOT NULL entry_type column gets a placeholder.
      const cols = {
        name: p.name,
        entry_type: p.entry?.type ?? "prompt",
        prompt_md: p.entry?.type === "prompt" ? p.entry.markdown : null,
        skill_id: p.entry?.type === "skill" ? p.entry.skillId : null,
        model: p.model,
        effort: p.effort,
        timeout_min: p.timeoutMin,
        max_turns: p.maxTurns,
      };
      let id = p.id;
      let kind = p.kind;
      if (id === undefined) {
        const info = this.sql
          .prepare(
            `INSERT INTO profiles (name, kind, entry_type, prompt_md, skill_id, model, effort, timeout_min, max_turns, created_at)
             VALUES (@name, @kind, @entry_type, @prompt_md, @skill_id, @model, @effort, @timeout_min, @max_turns, @created_at)`,
          )
          .run({ ...cols, kind, created_at: Date.now() });
        id = Number(info.lastInsertRowid);
      } else {
        kind = this.getProfile(id)?.kind ?? kind;
        this.updateRow("profiles", id, cols);
      }
      const hasDefault = this.sql.prepare("SELECT 1 FROM profiles WHERE is_default = 1 AND kind = ?").get(kind);
      if (p.isDefault || !hasDefault) this.setDefaultProfile(id);
      return this.getProfile(id)!;
    });
  }

  /** Make a profile the default of its kind. */
  setDefaultProfile(id: number): void {
    this.tx(() => {
      const p = this.getProfile(id);
      if (!p) return;
      this.sql.prepare("UPDATE profiles SET is_default = 0 WHERE is_default = 1 AND kind = ?").run(p.kind);
      this.sql.prepare("UPDATE profiles SET is_default = 1 WHERE id = ?").run(id);
    });
  }

  deleteProfile(id: number): void {
    this.tx(() => {
      const p = this.getProfile(id);
      if (!p) return;
      if (p.isDefault) throw new Error("The default profile can't be deleted. Make another profile the default first.");
      this.sql.prepare("DELETE FROM profiles WHERE id = ?").run(id);
    });
  }

  // ── iterations ──────────────────────────────────────────────────────────

  getIteration(id: number): Iteration | null {
    const r = this.sql.prepare("SELECT * FROM iterations WHERE id = ?").get(id) as Row | undefined;
    return r ? toIteration(r) : null;
  }

  listIterationsForPr(prId: number): Iteration[] {
    return (this.sql.prepare("SELECT * FROM iterations WHERE pr_id = ? ORDER BY id DESC").all(prId) as Row[]).map(toIteration);
  }

  listIterationsInStates(states: readonly IterationState[]): Iteration[] {
    const q = `SELECT * FROM iterations WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY COALESCE(run_after, created_at), id`;
    return (this.sql.prepare(q).all(...states) as Row[]).map(toIteration);
  }

  countIterationsByState(): Record<string, number> {
    const rows = this.sql.prepare("SELECT state, COUNT(*) AS n FROM iterations GROUP BY state").all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.n)]));
  }

  /** Per PR: the states of its live iterations and of its latest one that wasn't merged or skipped (the sidebar badge). */
  iterationStatesByPr(live: readonly IterationState[]): Map<number, { live: IterationState[]; latest: IterationState | null }> {
    const out = new Map<number, { live: IterationState[]; latest: IterationState | null }>();
    const entry = (prId: number) => {
      let e = out.get(prId);
      if (!e) out.set(prId, (e = { live: [], latest: null }));
      return e;
    };
    const liveRows = this.sql
      .prepare(`SELECT pr_id, state FROM iterations WHERE state IN (${live.map(() => "?").join(",")})`)
      .all(...live) as Row[];
    for (const r of liveRows) entry(Number(r.pr_id)).live.push(r.state as IterationState);
    const latest = this.sql
      .prepare(
        `SELECT i.pr_id, i.state FROM iterations i
         WHERE i.id = (SELECT MAX(id) FROM iterations x WHERE x.pr_id = i.pr_id AND x.merged_into IS NULL AND x.state != 'skipped')`,
      )
      .all() as Row[];
    for (const r of latest) entry(Number(r.pr_id)).latest = r.state as IterationState;
    return out;
  }

  createIteration(input: { prId: number; state: IterationState; trigger: IterationTrigger; runAfter: number | null; transcriptPath: (id: number) => string }): Iteration {
    return this.tx(() => {
      const now = Date.now();
      const info = this.sql
        .prepare(
          `INSERT INTO iterations (pr_id, state, trigger_kind, run_after, created_at, updated_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.prId, input.state, input.trigger, input.runAfter, now, now, now);
      const id = Number(info.lastInsertRowid);
      this.sql.prepare("UPDATE iterations SET transcript_path = ? WHERE id = ?").run(input.transcriptPath(id), id);
      return this.getIteration(id)!;
    });
  }

  /** Like `updateReview`: with `expectState`, applies only while the row is still in one of those states. */
  updateIteration(id: number, patch: IterationPatch, expectState?: readonly IterationState[]): Iteration | null {
    const now = Date.now();
    const sets: string[] = ["updated_at = ?", "last_activity_at = ?"];
    const values: unknown[] = [now, now];
    for (const [key, value] of Object.entries(patch) as [keyof IterationPatch, never][]) {
      if (value === undefined) continue;
      const [col, enc] = ITERATION_COLUMNS[key];
      sets.push(`${col} = ?`);
      values.push(enc(value));
    }
    let where = "id = ?";
    values.push(id);
    if (expectState && expectState.length > 0) {
      where += ` AND state IN (${expectState.map(() => "?").join(",")})`;
      values.push(...expectState);
    }
    const info = this.sql.prepare(`UPDATE iterations SET ${sets.join(", ")} WHERE ${where}`).run(...values);
    if (info.changes === 0) return null;
    return this.getIteration(id);
  }

  addIterationUsage(id: number, usage: TokenUsage): void {
    this.tx(() => {
      const prev = this.getIteration(id)?.usage;
      this.updateIteration(id, {
        usage: prev
          ? {
              input: prev.input + usage.input,
              output: prev.output + usage.output,
              cacheRead: prev.cacheRead + usage.cacheRead,
              cacheWrite: prev.cacheWrite + usage.cacheWrite,
            }
          : usage,
      });
    });
  }

  /** Commits Heron made on this PR (to tell its own pushes from everyone else's). */
  iterationCommitShas(prId: number): Set<string> {
    const rows = this.sql.prepare("SELECT commit_sha FROM iterations WHERE pr_id = ? AND commit_sha IS NOT NULL").all(prId) as Row[];
    return new Set(rows.map((r) => String(r.commit_sha)));
  }

  // ── feedback ────────────────────────────────────────────────────────────

  /** Record comments seen on GitHub. New ones are inserted; known ones only get their text refreshed. Returns the new rows. */
  upsertFeedback(prId: number, observed: ObservedFeedback[]): Feedback[] {
    return this.tx(() => {
      const now = Date.now();
      const find = this.sql.prepare("SELECT id FROM feedback WHERE pr_id = ? AND kind = ? AND github_id = ?");
      const refresh = this.sql.prepare("UPDATE feedback SET body = ?, line = ?, outdated = ? WHERE id = ?");
      const insert = this.sql.prepare(
        `INSERT INTO feedback (pr_id, github_id, kind, thread_root_id, author, body, url, path, line, outdated, diff_hunk,
                               review_state, created_at, status, observed_at)
         VALUES (@prId, @githubId, @kind, @threadRootId, @author, @body, @url, @path, @line, @outdated, @diffHunk,
                 @reviewState, @createdAt, @status, @now)`,
      );
      const added: Feedback[] = [];
      for (const o of observed) {
        const existing = find.get(prId, o.kind, o.githubId) as Row | undefined;
        if (existing) {
          refresh.run(o.body, o.line, o.outdated ? 1 : 0, Number(existing.id));
          continue;
        }
        const info = insert.run({
          prId,
          githubId: o.githubId,
          kind: o.kind,
          threadRootId: o.threadRootId,
          author: o.author,
          body: o.body,
          url: o.url,
          path: o.path,
          line: o.line,
          outdated: o.outdated ? 1 : 0,
          diffHunk: o.diffHunk,
          reviewState: o.reviewState,
          createdAt: o.createdAt,
          status: o.heronReply ? "ignored" : "unhandled",
          now,
        });
        added.push(this.getFeedback(Number(info.lastInsertRowid))!);
      }
      return added;
    });
  }

  getFeedback(id: number): Feedback | null {
    const r = this.sql.prepare("SELECT * FROM feedback WHERE id = ?").get(id) as Row | undefined;
    return r ? toFeedback(r) : null;
  }

  listFeedbackForPr(prId: number, status?: FeedbackStatus): Feedback[] {
    const rows = status
      ? this.sql.prepare("SELECT * FROM feedback WHERE pr_id = ? AND status = ? ORDER BY created_at, id").all(prId, status)
      : this.sql.prepare("SELECT * FROM feedback WHERE pr_id = ? ORDER BY created_at, id").all(prId);
    return (rows as Row[]).map(toFeedback);
  }

  listFeedbackForIteration(iterationId: number): Feedback[] {
    return (this.sql.prepare("SELECT * FROM feedback WHERE iteration_id = ? ORDER BY created_at, id").all(iterationId) as Row[]).map(toFeedback);
  }

  updateFeedback(ids: readonly number[], patch: FeedbackPatch): void {
    if (ids.length === 0) return;
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof FeedbackPatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${FEEDBACK_COLUMNS[key]} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    const stmt = this.sql.prepare(`UPDATE feedback SET ${sets.join(", ")} WHERE id = ?`);
    this.tx(() => {
      for (const id of ids) stmt.run(...values, id);
    });
  }

  /** An iteration ended pushed, no_changes, discarded or uncommitted: the comments it took on are handled. */
  handleIterationFeedback(iterationId: number, at: number): void {
    this.sql
      .prepare("UPDATE feedback SET status = 'handled', handled_at = ? WHERE iteration_id = ? AND status = 'unhandled'")
      .run(at, iterationId);
  }

  // ── skills ──────────────────────────────────────────────────────────────

  listSkills(): Skill[] {
    return (this.sql.prepare("SELECT * FROM skills ORDER BY name").all() as Row[]).map(toSkill);
  }

  getSkill(id: number): Skill | null {
    const r = this.sql.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Row | undefined;
    return r ? toSkill(r) : null;
  }

  addSkill(s: Omit<Skill, "id">): Skill {
    const info = this.sql
      .prepare("INSERT INTO skills (name, source, path, content_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(s.name, s.source, s.path, s.contentHash, Date.now());
    return this.getSkill(Number(info.lastInsertRowid))!;
  }

  updateSkillHash(id: number, contentHash: string): void {
    this.sql.prepare("UPDATE skills SET content_hash = ? WHERE id = ?").run(contentHash, id);
  }

  deleteSkill(id: number): void {
    this.sql.prepare("DELETE FROM skills WHERE id = ?").run(id);
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private updateRow(table: string, id: number, cols: Record<string, unknown>): void {
    const keys = Object.keys(cols);
    if (keys.length === 0) return;
    this.sql
      .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`)
      .run({ ...cols, id });
  }
}
