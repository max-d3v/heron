import Database from "better-sqlite3";
import {
  DEFAULT_SETTINGS,
  type Activity,
  type ActivityKind,
  type EffortLevel,
  type ObservedPr,
  type Pr,
  type PrState,
  type Profile,
  type ProfileEntry,
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
    enabled: bool(r.enabled),
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
    baseRef: String(r.base_ref),
    baseSha: String(r.base_sha),
    state: r.state as PrState,
    url: String(r.url),
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
    ts: Number(r.ts),
    kind: r.kind as ActivityKind,
    message: String(r.message),
    data: json<Record<string, unknown>>(r.data_json),
  };
}

function toProfile(r: Row): Profile {
  const entry: ProfileEntry =
    r.entry_type === "skill"
      ? { type: "skill", skillId: Number(r.skill_id ?? 0) }
      : { type: "prompt", markdown: String(r.prompt_md ?? "") };
  return {
    id: Number(r.id),
    name: String(r.name),
    isDefault: bool(r.is_default),
    entry,
    model: String(r.model),
    effort: (r.effort as EffortLevel | null) ?? null,
    timeoutMin: Number(r.timeout_min),
    maxTurns: Number(r.max_turns),
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

export interface NewActivity {
  prId: number | null;
  reviewId: number | null;
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
      .prepare("INSERT INTO repos (owner, name, scope, profile_id, created_at) VALUES (?, ?, ?, ?, ?)")
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
        | "enabled"
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
    if (patch.enabled !== undefined) cols.enabled = patch.enabled ? 1 : 0;
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

  getManualPrs(repoId: number): Set<number> {
    const rows = this.sql.prepare("SELECT number FROM manual_prs WHERE repo_id = ?").all(repoId) as Row[];
    return new Set(rows.map((r) => Number(r.number)));
  }

  setManualPrs(repoId: number, numbers: number[]): void {
    this.tx(() => {
      this.sql.prepare("DELETE FROM manual_prs WHERE repo_id = ?").run(repoId);
      const ins = this.sql.prepare("INSERT OR IGNORE INTO manual_prs (repo_id, number) VALUES (?, ?)");
      for (const n of numbers) ins.run(repoId, n);
    });
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
                          base_ref, base_sha, state, url, created_at, updated_at, last_activity_at)
         VALUES (@repoId, @number, @title, @body, @author, @avatar, @draft, @headSha, @headRef,
                 @baseRef, @baseSha, 'open', @url, @createdAt, @updatedAt, @now)
         ON CONFLICT(repo_id, number) DO UPDATE SET
           title = excluded.title, body = excluded.body, author = excluded.author,
           author_avatar_url = excluded.author_avatar_url, is_draft = excluded.is_draft,
           head_sha = excluded.head_sha, head_ref = excluded.head_ref, base_ref = excluded.base_ref,
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

  updatePr(id: number, patch: Partial<Pick<Pr, "state" | "additions" | "deletions" | "changedFiles" | "lastActivityAt">>): void {
    const cols: Record<string, unknown> = {};
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
        `SELECT p.*, r.owner AS r_owner, r.name AS r_name, r.enabled AS r_enabled,
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
      .prepare("INSERT INTO activity (pr_id, review_id, ts, kind, message, data_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(a.prId, a.reviewId, ts, a.kind, a.message, a.data ? JSON.stringify(a.data) : null);
    if (a.prId !== null) this.touchPr(a.prId, ts);
    return { id: Number(info.lastInsertRowid), prId: a.prId, reviewId: a.reviewId, ts, kind: a.kind, message: a.message, data: a.data ?? null };
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

  // ── profiles ────────────────────────────────────────────────────────────

  listProfiles(): Profile[] {
    return (this.sql.prepare("SELECT * FROM profiles ORDER BY is_default DESC, name").all() as Row[]).map(toProfile);
  }

  getProfile(id: number): Profile | null {
    const r = this.sql.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
    return r ? toProfile(r) : null;
  }

  getDefaultProfile(): Profile | null {
    const r = this.sql.prepare("SELECT * FROM profiles WHERE is_default = 1").get() as Row | undefined;
    return r ? toProfile(r) : null;
  }

  saveProfile(p: Omit<Profile, "id"> & { id?: number }): Profile {
    return this.tx(() => {
      const cols = {
        name: p.name,
        entry_type: p.entry.type,
        prompt_md: p.entry.type === "prompt" ? p.entry.markdown : null,
        skill_id: p.entry.type === "skill" ? p.entry.skillId : null,
        model: p.model,
        effort: p.effort,
        timeout_min: p.timeoutMin,
        max_turns: p.maxTurns,
      };
      let id = p.id;
      if (id === undefined) {
        const info = this.sql
          .prepare(
            `INSERT INTO profiles (name, entry_type, prompt_md, skill_id, model, effort, timeout_min, max_turns, created_at)
             VALUES (@name, @entry_type, @prompt_md, @skill_id, @model, @effort, @timeout_min, @max_turns, @created_at)`,
          )
          .run({ ...cols, created_at: Date.now() });
        id = Number(info.lastInsertRowid);
      } else {
        this.updateRow("profiles", id, cols);
      }
      const hasDefault = this.sql.prepare("SELECT 1 FROM profiles WHERE is_default = 1").get();
      if (p.isDefault || !hasDefault) this.setDefaultProfile(id);
      return this.getProfile(id)!;
    });
  }

  setDefaultProfile(id: number): void {
    this.tx(() => {
      this.sql.prepare("UPDATE profiles SET is_default = 0 WHERE is_default = 1").run();
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
