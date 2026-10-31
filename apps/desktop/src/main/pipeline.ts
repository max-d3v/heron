import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthError,
  OutputParseError,
  PermanentError,
  isEmptyPayload,
  isInFlight,
  nextStep,
  parseDiff,
  parseReviewOutput,
  validateAgainstDiff,
  type Pr,
  type ProfileSnapshot,
  type Repo,
  type Review,
  type Settings,
} from "@heron/core";
import type { HeronDb, ReviewPatch } from "@heron/db";
import type { GitClient } from "@heron/git";
import type { GitHubClient } from "@heron/github";
import { runReview, type HarnessEntry } from "@heron/harness";
import type { Paths } from "./paths.ts";
import { skillCommand, type SkillService } from "./skills.ts";
import type { Store } from "./store.ts";

/** The PR moved on before this run started; the poller will owe the new head. */
export class SupersededError extends Error {
  constructor(readonly newSha: string) {
    super(`PR head moved to ${newSha.slice(0, 7)}`);
    this.name = "SupersededError";
  }
}

/** The PR was merged or closed before the poller noticed; the run is cancelled, not failed. */
export class PrClosedError extends Error {
  constructor(readonly state: "closed" | "merged") {
    super(`PR is ${state}`);
    this.name = "PrClosedError";
  }
}

export interface PipelineDeps {
  db: HeronDb;
  store: Store;
  github: GitHubClient;
  git: GitClient;
  paths: Paths;
  skills: SkillService;
  version: string;
  env: () => NodeJS.ProcessEnv;
  claudePath: () => string | null;
  settings: () => Settings;
}

interface HeronMeta {
  sinceLastReviewFrom: string | null;
  previousReviewCount: number;
}

/**
 * Runs a review through its steps (§6.2). Each step is idempotent and its output is
 * saved in the same transaction that moves the review to the next state, so a crash
 * or quit resumes at the start of the step that was in progress.
 */
export class Pipeline {
  constructor(private readonly d: PipelineDeps) {}

  async execute(reviewId: number, signal: AbortSignal): Promise<Review | null> {
    let review = this.d.db.getReview(reviewId);
    if (!review) return null;

    if (review.state === "queued") {
      const start = review.retryStep ?? "preparing";
      review = this.d.store.transition(review, start, {
        patch: { retryStep: null, runAfter: null, startedAt: review.startedAt ?? Date.now() },
        message: review.retryStep ? `Resuming at ${start}` : undefined,
      });
      if (!review) return null;
    }

    if (!review.profileSnapshot) {
      const snapshot = await this.snapshot(review);
      review = this.d.store.save(review, { profileSnapshot: snapshot });
      if (!review) return null;
    }

    while (review && isInFlight(review.state)) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
      const { pr, repo } = this.context(review);
      let patch: ReviewPatch;
      switch (review.state) {
        case "preparing":
          patch = await this.prepare(review, pr, repo, signal);
          break;
        case "running":
          patch = await this.run(review, pr, repo, signal);
          break;
        case "validating":
          patch = await this.validate(review, pr, repo);
          break;
        case "posting":
          patch = await this.post(review, pr, repo);
          break;
      }
      const to = nextStep(review.state, posts(review));
      const done = to === "posted" || to === "completed";
      review = this.d.store.transition(review, to, {
        patch: { ...patch, ...(done ? { finishedAt: Date.now() } : {}) },
        message: to === "completed" && !review.profileSnapshot!.dryRun ? "No issues found, nothing posted" : undefined,
        data: to === "posted" ? { url: patch.githubReviewUrl ?? null } : undefined,
      });
    }
    return review;
  }

  private context(review: Review): { pr: Pr; repo: Repo } {
    const pr = this.d.db.getPr(review.prId);
    const repo = pr ? this.d.db.getRepo(pr.repoId) : null;
    if (!pr || !repo) throw new PermanentError("The PR or repo was removed");
    return { pr, repo };
  }

  private async snapshot(review: Review): Promise<ProfileSnapshot> {
    const { repo } = this.context(review);
    const picked = repo.profileId !== null ? this.d.db.getProfile(repo.profileId) : null;
    const profile = picked?.kind === "review" ? picked : this.d.db.getDefaultProfile("review");
    if (!profile?.entry) throw new PermanentError("No review profile is set up");
    let entry: ProfileSnapshot["entry"];
    if (profile.entry.type === "skill") {
      const skill = this.d.db.getSkill(profile.entry.skillId);
      if (!skill) throw new PermanentError(`Profile "${profile.name}" points at a skill that no longer exists`);
      const fresh = await this.d.skills.refreshHash(skill);
      entry = { type: "skill", skillId: skill.id, skillName: skill.name, source: skill.source, contentHash: fresh.contentHash };
    } else {
      entry = { type: "prompt", markdown: profile.entry.markdown };
    }
    return {
      profileId: profile.id,
      name: profile.name,
      entry,
      model: profile.model,
      effort: profile.effort,
      timeoutMin: profile.timeoutMin,
      maxTurns: profile.maxTurns,
      trustRepoClaudeConfig: repo.trustRepoClaudeConfig,
      dryRun: this.d.settings().dryRun,
    };
  }

  // ── preparing ─────────────────────────────────────────────────────────────

  private async prepare(review: Review, pr: Pr, repo: Repo, signal: AbortSignal): Promise<ReviewPatch> {
    const { github, git, paths } = this.d;
    const { owner, name } = repo;
    const detail = await github.getPull(owner, name, pr.number);
    this.d.db.updatePr(pr.id, { additions: detail.additions, deletions: detail.deletions, changedFiles: detail.changedFiles });
    if (detail.state !== "open") throw new PrClosedError(detail.state);
    if (review.trigger !== "rerun" && detail.headSha !== review.headSha) throw new SupersededError(detail.headSha);
    signal.throwIfAborted();

    const clone = paths.cloneDir(owner, name);
    const worktree = paths.worktreeDir(owner, name, pr.number);
    await git.ensureClone(clone, owner, name);
    await git.fetchPr(clone, pr.number, detail.baseRef);
    if (!(await git.ensureCommit(clone, review.headSha))) {
      throw new PermanentError(`Commit ${review.headSha.slice(0, 7)} is no longer on GitHub`);
    }
    await git.addExclude(clone, ".heron/");
    signal.throwIfAborted();
    await git.checkoutWorktree(clone, worktree, review.headSha);

    // The diff GitHub shows (base…head). Computing it locally as well pulls the blobs
    // both sides need into the partial clone, so the agent's own git commands work.
    const base = (await git.hasCommit(clone, detail.baseSha)) ? detail.baseSha : `refs/heron/base/${detail.baseRef}`;
    const mergeBase = await git.mergeBase(clone, base, review.headSha);
    const localDiff = mergeBase ? await git.diff(clone, mergeBase, review.headSha) : null;
    const remoteDiff = detail.headSha === review.headSha ? await github.getPullDiff(owner, name, pr.number) : null;
    const diff = remoteDiff ?? localDiff;
    if (diff === null) throw new PermanentError("Couldn't compute the PR diff");
    signal.throwIfAborted();

    // Changes since our last review, only when that SHA is an ancestor (not after a force-push).
    const prior = this.d.db
      .listReviewsForPr(pr.id)
      .find((r) => r.id !== review.id && (r.state === "posted" || r.state === "completed") && r.headSha !== review.headSha);
    let since: { from: string; diff: string } | null = null;
    if (prior && (await git.isAncestor(clone, prior.headSha, review.headSha))) {
      since = { from: prior.headSha, diff: await git.diff(clone, prior.headSha, review.headSha) };
    }

    const conversation = await github.getConversation(owner, name, pr.number);
    signal.throwIfAborted();

    const dir = join(worktree, ".heron");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const meta: HeronMeta = { sinceLastReviewFrom: since?.from ?? null, previousReviewCount: conversation.ours.length };
    await writeFile(join(dir, "pr.diff"), diff);
    if (since) await writeFile(join(dir, "since-last-review.diff"), since.diff);
    await writeFile(join(dir, "previous-reviews.json"), `${JSON.stringify(conversation.ours, null, 2)}\n`);
    await writeFile(join(dir, "pr-comments.json"), `${JSON.stringify(conversation.humans, null, 2)}\n`);
    await writeFile(
      join(dir, "pr.json"),
      `${JSON.stringify(
        {
          repo: `${owner}/${name}`,
          number: pr.number,
          title: detail.title,
          body: detail.body,
          author: detail.author,
          url: detail.url,
          draft: detail.isDraft,
          base: { ref: detail.baseRef, sha: detail.baseSha },
          head: { ref: detail.headRef, sha: review.headSha },
          additions: detail.additions,
          deletions: detail.deletions,
          changedFiles: detail.changedFiles,
          createdAt: new Date(detail.createdAt).toISOString(),
          updatedAt: new Date(detail.updatedAt).toISOString(),
          heron: meta,
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(paths.transcripts, { recursive: true });
    await writeFile(paths.runDiff(review.id), diff);
    return {};
  }

  // ── running ───────────────────────────────────────────────────────────────

  private async run(review: Review, pr: Pr, repo: Repo, signal: AbortSignal): Promise<ReviewPatch> {
    const { git, paths, db, store } = this.d;
    const worktree = paths.worktreeDir(repo.owner, repo.name, pr.number);
    const prJson = join(worktree, ".heron", "pr.json");
    if ((await git.headSha(worktree)) !== review.headSha || !existsSync(prJson)) {
      // The worktree moved or was cleared since preparing (e.g. after a restart): redo it.
      await this.prepare(review, pr, repo, signal);
    }
    const meta = (JSON.parse(await readFile(prJson, "utf8")) as { heron: HeronMeta }).heron;
    const snap = review.profileSnapshot!;

    let entry: HarnessEntry;
    if (snap.entry.type === "skill") {
      const skill = db.getSkill(snap.entry.skillId);
      if (!skill) throw new PermanentError(`Skill "${snap.entry.skillName}" was removed`);
      entry = { type: "skill", command: skillCommand(skill), skillFile: join(skill.path, "SKILL.md") };
    } else {
      entry = { type: "prompt", markdown: snap.entry.markdown };
    }

    const claudePath = this.d.claudePath();
    if (!claudePath) throw new AuthError("claude", "Claude Code isn't installed");
    const transcriptPath = paths.transcript(review.id);
    db.updateReview(review.id, { transcriptPath });

    try {
      const result = await runReview({
        claudePath,
        cwd: worktree,
        baseEnv: this.d.env(),
        ghConfigDir: paths.ghConfig,
        pluginDir: paths.plugin,
        trustRepoClaudeConfig: snap.trustRepoClaudeConfig,
        entry,
        model: snap.model,
        effort: snap.effort,
        maxTurns: snap.maxTurns,
        timeoutMs: snap.timeoutMin * 60_000,
        signal,
        pr: {
          repo: `${repo.owner}/${repo.name}`,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          author: pr.author,
          url: pr.url,
          baseRef: pr.baseRef,
          baseSha: pr.baseSha,
          headRef: pr.headRef,
          headSha: review.headSha,
        },
        files: {
          sinceLastReview: meta.sinceLastReviewFrom ? { fromSha: meta.sinceLastReviewFrom } : null,
          previousReviewCount: meta.previousReviewCount,
        },
        transcriptPath,
        clientApp: `heron/${this.d.version}`,
        onSpawn: (pid) => db.updateReview(review.id, { pid }),
        onInit: ({ sessionId, model }) => db.updateReview(review.id, { sessionId, resolvedModel: model }),
        onUsage: (usage) => db.addReviewUsage(review.id, usage),
        onStep: (step) => store.step(review, step),
      });
      return { rawOutput: JSON.stringify(result.structuredOutput, null, 2), pid: null };
    } finally {
      db.updateReview(review.id, { pid: null });
    }
  }

  // ── validating ────────────────────────────────────────────────────────────

  private async validate(review: Review, pr: Pr, repo: Repo): Promise<ReviewPatch> {
    const raw = review.rawOutput ?? "";
    const parsed = parseReviewOutput(raw);
    if (!parsed.ok) throw new OutputParseError(`The output doesn't match the review format: ${parsed.error}`, raw);
    const diffFile = existsSync(this.d.paths.runDiff(review.id))
      ? this.d.paths.runDiff(review.id)
      : join(this.d.paths.worktreeDir(repo.owner, repo.name, pr.number), ".heron", "pr.diff");
    const diff = existsSync(diffFile) ? await readFile(diffFile, "utf8") : "";
    const payload = validateAgainstDiff(parsed.output, parseDiff(diff));
    if (payload.movedToBody.length > 0) {
      this.d.store.activity({
        prId: review.prId,
        reviewId: review.id,
        kind: "review.state",
        message: `Moved ${payload.movedToBody.length} comment${payload.movedToBody.length === 1 ? "" : "s"} outside the diff into the body`,
      });
    }
    return { output: parsed.output, payload };
  }

  // ── posting ───────────────────────────────────────────────────────────────

  private async post(review: Review, pr: Pr, repo: Repo): Promise<ReviewPatch> {
    if (!posts(review)) return {};
    if (!review.payload) throw new PermanentError("Nothing to post (validation output missing)");
    const { github } = this.d;
    // Idempotent: a crash after POST but before saving must not post twice.
    const existing = await github.findMarkerReview(repo.owner, repo.name, pr.number, review.headSha, review.id);
    if (existing) return { githubReviewId: existing.id, githubReviewUrl: existing.url };
    const posted = await github.postReview(repo.owner, repo.name, pr.number, review.headSha, review.id, review.payload);
    if (posted.folded) {
      this.d.store.activity({
        prId: review.prId,
        reviewId: review.id,
        kind: "review.state",
        message: "GitHub rejected the inline comments, so they were posted in the body",
      });
    }
    return { githubReviewId: posted.id, githubReviewUrl: posted.url };
  }
}

/** Dry runs, and reviews that found nothing to raise, finish as `completed` without posting. */
function posts(review: Review): boolean {
  if (review.profileSnapshot!.dryRun) return false;
  return !review.payload || !isEmptyPayload(review.payload);
}
