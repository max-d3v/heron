import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthError,
  OutputParseError,
  PermanentError,
  classifyError,
  errorMessage,
  isIterationInFlight,
  iterationEligibility,
  iterationMarker,
  iterationPrompt,
  iterationTrailer,
  orderFeedbackItems,
  parseIterationOutput,
  type Feedback,
  type Iteration,
  type CwdKind,
  type IterationItem,
  type IterationOutput,
  type IterationOutputItem,
  type IterationSnapshot,
  type IterationState,
  type Pr,
  type Repo,
  type Settings,
  type TriageVerdict,
} from "@heron/core";
import type { HeronDb, IterationPatch } from "@heron/db";
import { GitError, type GitClient } from "@heron/git";
import type { GitHubClient } from "@heron/github";
import { runIteration, runSetupCommand, runTriage, type PrContext, type TriageItem } from "@heron/harness";
import { groupFeedback, threadForPrompt } from "./feedback.ts";
import type { Paths } from "./paths.ts";
import { PrClosedError } from "./pipeline.ts";
import type { Store } from "./store.ts";

/** The PR head moved on while the iteration was in flight or waiting for Push (§15.6). */
export class StaleError extends Error {
  constructor(readonly newSha: string | null) {
    super(newSha ? `PR head moved to ${newSha.slice(0, 7)}` : "The branch moved on GitHub, so the push was rejected");
    this.name = "StaleError";
  }
}

export interface IterationPipelineDeps {
  db: HeronDb;
  store: Store;
  github: GitHubClient;
  git: GitClient;
  paths: Paths;
  version: string;
  env: () => NodeJS.ProcessEnv;
  claudePath: () => string | null;
  settings: () => Settings;
  viewerLogin: () => string | null;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Runs an iteration through its steps (§15.5, §15.6): triage, then preparing → running →
 * committing → pushing → replying. Like the review pipeline, each step saves its output in
 * the transaction that moves the iteration on, so a crash or quit resumes at that step.
 */
export class IterationPipeline {
  constructor(private readonly d: IterationPipelineDeps) {}

  // ── triage ────────────────────────────────────────────────────────────────

  /** One Haiku call over the groups that have rows without a verdict. Returns a verdict per group key. */
  async triage(it: Iteration, rows: Feedback[], signal: AbortSignal): Promise<Map<string, { verdict: TriageVerdict; reason: string }>> {
    const { db, paths } = this.d;
    const { pr } = this.context(it);
    const groups = groupFeedback(rows, db.listFeedbackForPr(pr.id)).filter((g) => g.rows.some((r) => r.verdict === null));
    const out = new Map<string, { verdict: TriageVerdict; reason: string }>();
    if (groups.length === 0) return out;

    const items: TriageItem[] = groups.map((g, i) => ({
      id: i + 1,
      kind: g.kind,
      path: g.path,
      line: g.line,
      outdated: g.outdated,
      diffHunk: g.diffHunk,
      reviewState: g.reviewState,
      comments: threadForPrompt(g, pr.author),
    }));
    const claudePath = this.d.claudePath();
    if (!claudePath) throw new AuthError("claude", "Claude Code isn't installed");
    const result = await runTriage({
      claudePath,
      cwd: paths.root,
      baseEnv: this.d.env(),
      ghConfigDir: paths.ghConfig,
      signal,
      transcriptPath: it.transcriptPath ?? paths.iterationTranscript(it.id),
      clientApp: `heron/${this.d.version}`,
      prTitle: pr.title,
      items,
      onSpawn: (pid) => db.updateIteration(it.id, { pid }),
      onUsage: (usage) => db.addIterationUsage(it.id, usage),
    }).finally(() => db.updateIteration(it.id, { pid: null }));

    const byId = new Map(result.verdicts.map((v) => [v.id, v]));
    groups.forEach((g, i) => {
      const v = byId.get(i + 1);
      // A group the model skipped goes to the agent: triage only sets aside what clearly needs nothing.
      out.set(g.key, v ? { verdict: v.verdict, reason: v.reason } : { verdict: "change", reason: "No verdict from triage" });
    });
    return out;
  }

  // ── the agent run ─────────────────────────────────────────────────────────

  async execute(iterationId: number, signal: AbortSignal): Promise<Iteration | null> {
    const { db, store } = this.d;
    let it = db.getIteration(iterationId);
    if (!it) return null;

    if (it.state === "queued") {
      // A run always starts from a clean checkout, so a retry of the agent redoes preparing.
      const start = it.retryStep === null || it.retryStep === "running" ? "preparing" : it.retryStep;
      it = store.transitionIteration(it, start, {
        patch: { retryStep: null, runAfter: null, startedAt: it.startedAt ?? Date.now() },
        message: it.retryStep ? `Resuming at ${start}` : undefined,
      });
    } else if (it.state === "running") {
      // Interrupted mid-run (quit or crash): the checkout may hold half the edits.
      it = store.transitionIteration(it, "preparing", { message: "Starting over from a clean checkout" });
    }
    if (!it) return null;

    const snap = it.profileSnapshot ?? this.snapshot(it);
    if (!it.profileSnapshot) {
      it = store.saveIteration(it, { profileSnapshot: snap });
      if (!it) return null;
    }
    // Setup time counts toward the timeout.
    const deadline = Date.now() + snap.timeoutMin * 60_000;

    while (it && isIterationInFlight(it.state)) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
      const { pr, repo } = this.context(it);
      let step: { patch: IterationPatch; to: IterationState };
      switch (it.state) {
        case "preparing":
          step = { patch: await this.prepare(it, snap, pr, repo, signal, deadline), to: "running" };
          break;
        case "running":
          step = { patch: await this.run(it, snap, pr, repo, signal, deadline), to: "committing" };
          break;
        case "committing":
          step = await this.commit(it, snap, pr, repo);
          break;
        case "pushing":
          step = { patch: await this.push(it, pr, repo), to: "replying" };
          break;
        case "replying":
          step = { patch: await this.reply(it, snap, pr, repo), to: it.commitSha ? "pushed" : "no_changes" };
          break;
      }
      const settled = step.to === "ready" || step.to === "no_changes" || step.to === "pushed";
      it = store.transitionIteration(it, step.to, {
        patch: { ...step.patch, ...(settled && it.finishedAt === null ? { finishedAt: Date.now() } : {}) },
        data: step.patch.commitSha ? { commitSha: step.patch.commitSha } : undefined,
      });
    }
    return it;
  }

  private context(it: Iteration): { pr: Pr; repo: Repo } {
    const pr = this.d.db.getPr(it.prId);
    const repo = pr ? this.d.db.getRepo(pr.repoId) : null;
    if (!pr || !repo) throw new PermanentError("The PR or repo was removed");
    return { pr, repo };
  }

  /** `worktree`: run in Heron's worktree even when the repo uses a local checkout. */
  snapshot(it: Iteration, opts: { worktree?: boolean } = {}): IterationSnapshot {
    const { repo } = this.context(it);
    const picked = repo.iterationProfileId !== null ? this.d.db.getProfile(repo.iterationProfileId) : null;
    const profile = picked?.kind === "iteration" ? picked : this.d.db.getDefaultProfile("iteration");
    if (!profile) throw new PermanentError("No iteration profile is set up");
    const useLocal = repo.useLocalCheckout && !opts.worktree;
    const local = useLocal ? repo.localCheckoutPath?.trim() || null : null;
    if (useLocal && !local) throw new PermanentError("Local checkout is on but no folder is chosen (Settings → Repos)");
    return {
      profileId: profile.id,
      name: profile.name,
      model: profile.model,
      effort: profile.effort,
      timeoutMin: profile.timeoutMin,
      maxTurns: profile.maxTurns,
      trustRepoClaudeConfig: repo.trustRepoClaudeConfig,
      dryRun: this.d.settings().dryRun,
      autoPush: repo.iterationAutoPush,
      reply: repo.iterationReply,
      // The setup command is for Heron's worktree; a local checkout is the user's to keep set up.
      setupCommand: local ? null : repo.setupCommand?.trim() || null,
      localCheckoutPath: local,
    };
  }

  /** The snapshot's local checkout when it has one (`prepare` then sets `cwdKind` to `local`), else Heron's worktree. */
  private cwd(snap: IterationSnapshot, pr: Pr, repo: Repo): string {
    return snap.localCheckoutPath ?? this.d.paths.iterationWorktreeDir(repo.owner, repo.name, pr.number);
  }

  // ── preparing ─────────────────────────────────────────────────────────────

  private async prepare(it: Iteration, snap: IterationSnapshot, pr: Pr, repo: Repo, signal: AbortSignal, deadline: number): Promise<IterationPatch> {
    const { db, store, github, git, paths } = this.d;
    const { owner, name } = repo;
    const detail = await github.getPull(owner, name, pr.number);
    if (detail.state !== "open") throw new PrClosedError(detail.state);
    const eligible = iterationEligibility(repo, { ...pr, author: detail.author, headRepo: detail.headRepo }, this.d.viewerLogin());
    if (!eligible.ok) throw new PermanentError(eligible.reason);
    if (it.headSha && detail.headSha !== it.headSha) throw new StaleError(detail.headSha);
    const headSha = detail.headSha;
    signal.throwIfAborted();

    // Heron's clone is needed in both modes: the commit is pushed from it.
    const clone = paths.cloneDir(owner, name);
    await git.ensureClone(clone, owner, name);
    await git.fetchPr(clone, pr.number, detail.baseRef);
    if (!(await git.ensureCommit(clone, headSha))) throw new PermanentError(`Commit ${short(headSha)} is no longer on GitHub`);
    signal.throwIfAborted();

    let cwdKind: CwdKind;
    if (snap.localCheckoutPath) {
      // An earlier attempt ran the agent here (a retry, or a restart after a crash): its edits are left over.
      if (it.cwdKind === "local" && it.headSha) await this.setAsideLeftovers(it, snap.localCheckoutPath, detail.headRef, headSha);
      await this.checkLocalCheckout(snap.localCheckoutPath, detail.headRef, headSha);
      cwdKind = "local";
    } else {
      const worktree = paths.iterationWorktreeDir(owner, name, pr.number);
      // Checked out at the head and cleaned (`clean -ffdx`), so the setup command runs in full every time.
      await git.checkoutWorktree(clone, worktree, headSha);
      cwdKind = "worktree";
      if (snap.setupCommand) {
        store.iterationStep(it, { kind: "bash", label: `Running setup: ${snap.setupCommand}`, detail: snap.setupCommand });
        const transcript = it.transcriptPath ?? paths.iterationTranscript(it.id);
        let log = Promise.resolve();
        try {
          await runSetupCommand({
            command: snap.setupCommand,
            cwd: worktree,
            baseEnv: this.d.env(),
            ghConfigDir: paths.ghConfig,
            clientApp: `heron/${this.d.version}`,
            timeoutMs: deadline - Date.now(),
            signal,
            onSpawn: (pid) => db.updateIteration(it.id, { pid }),
            onOutput: (text) => {
              log = log.then(() => appendFile(transcript, `${JSON.stringify({ type: "setup", text })}\n`)).catch(() => undefined);
            },
          });
        } finally {
          db.updateIteration(it.id, { pid: null });
          await log;
        }
      }
    }
    signal.throwIfAborted();

    // The batch: the claimed comments triage marked for a change, one numbered item per thread.
    const rows = db.listFeedbackForIteration(it.id).filter((f) => f.status === "unhandled" && f.verdict === "change");
    if (rows.length === 0) throw new PermanentError("There's no feedback left to address");
    const groups = orderFeedbackItems(groupFeedback(rows, db.listFeedbackForPr(pr.id)));
    const items: IterationItem[] = groups.map((g, i) => ({
      number: i + 1,
      kind: g.kind,
      threadRootId: g.threadRootId,
      feedbackIds: g.rows.map((r) => r.id),
      path: g.path,
      line: g.line,
      outdated: g.outdated,
      url: g.url,
    }));
    const promptItems = groups.map((g, i) => ({ number: i + 1, kind: g.kind, path: g.path, line: g.line, outdated: g.outdated, comments: threadForPrompt(g, pr.author) }));

    // Context files live outside the checkout in both modes.
    const base = (await git.hasCommit(clone, detail.baseSha)) ? detail.baseSha : `refs/heron/base/${detail.baseRef}`;
    const mergeBase = await git.mergeBase(clone, base, headSha);
    const diff = (await github.getPullDiff(owner, name, pr.number)) ?? (mergeBase ? await git.diff(clone, mergeBase, headSha) : "");
    const conversation = await github.getConversation(owner, name, pr.number);
    signal.throwIfAborted();

    const dir = paths.iterationDir(it.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    await writeFile(
      join(dir, "pr.json"),
      json({
        repo: `${owner}/${name}`,
        number: pr.number,
        title: detail.title,
        body: detail.body,
        author: detail.author,
        url: detail.url,
        draft: detail.isDraft,
        base: { ref: detail.baseRef, sha: detail.baseSha },
        head: { ref: detail.headRef, sha: headSha },
        additions: detail.additions,
        deletions: detail.deletions,
        changedFiles: detail.changedFiles,
      }),
    );
    await writeFile(join(dir, "pr.diff"), diff);
    await writeFile(join(dir, "pr-comments.json"), json(conversation));
    await writeFile(join(dir, "feedback.json"), json(promptItems.map((p, i) => ({ ...p, url: items[i]!.url }))));
    await writeFile(join(dir, "prompt.md"), iterationPrompt(promptItems));
    return { headSha, cwdKind, items };
  }

  /** Local checkout mode runs only on the PR's head branch, clean, at the PR's head (§15.5). */
  private async checkLocalCheckout(dir: string, branch: string, headSha: string): Promise<void> {
    const { git } = this.d;
    if (!existsSync(dir)) throw new PermanentError(`The local checkout ${dir} doesn't exist`);
    let current: string | null;
    try {
      current = await git.currentBranch(dir);
    } catch {
      throw new PermanentError(`${dir} isn't a git checkout`);
    }
    if (current !== branch) {
      throw new PermanentError(`The local checkout is on ${current ? `branch ${current}` : "a detached HEAD"}, not the PR's branch ${branch}`);
    }
    if ((await git.status(dir)).trim()) throw new PermanentError("The local checkout has uncommitted changes. Commit or stash them, then Re-run.");
    const head = await git.headSha(dir);
    if (head !== headSha) {
      throw new PermanentError(`The local checkout is at ${short(head ?? "?")}, not the PR head ${short(headSha)}. Pull (or push) first, then Re-run.`);
    }
  }

  /**
   * Put the previous attempt's edits in a stash, so the run starts again from a clean checkout at
   * the head (`prepare` has checked it's still the head that attempt ran on). The checkout was clean
   * at the head when that attempt started, so while it's still there everything uncommitted is the agent's.
   */
  private async setAsideLeftovers(it: Iteration, dir: string, branch: string, headSha: string): Promise<void> {
    const { git, store } = this.d;
    // Not the checkout the agent ran in any more: `checkLocalCheckout` says why.
    if (!existsSync(dir) || (await git.currentBranch(dir).catch(() => null)) !== branch) return;
    // HEAD moved: the user may have committed or pulled during a long pause, and commits can't be told
    // apart from any the agent made. Nothing is touched; the user is asked to sort it out.
    const head = await git.headSha(dir).catch(() => null);
    if (head !== headSha) {
      // Commits on top of the head may be the agent's (it's told not to commit, but sometimes does):
      // `checkLocalCheckout`'s "Pull (or push)" would get them pushed to the PR.
      if (head && (await git.isAncestor(dir, headSha, head).catch(() => false))) {
        throw new PermanentError(
          `The local checkout has commits on top of the PR head ${short(headSha)}. They may be the agent's from the last attempt. Check them, and \`git reset --soft ${short(headSha)}\` if they are, then Re-run.`,
        );
      }
      return;
    }
    try {
      if (!(await git.status(dir)).trim()) return;
      await git.stash(dir, `Heron iteration ${it.id}: the agent's edits from an unfinished attempt`);
    } catch (err) {
      throw new PermanentError(
        `The local checkout still has the agent's edits from the last attempt, and Heron couldn't stash them (${errorMessage(err)}). Stash or discard them, then Re-run.`,
        { cause: err },
      );
    }
    store.activity({
      prId: it.prId,
      reviewId: null,
      iterationId: it.id,
      kind: "iteration.state",
      message: "Stashed the agent's edits from the last attempt in the local checkout (see `git stash list`)",
    });
  }

  // ── running ───────────────────────────────────────────────────────────────

  private async run(it: Iteration, snap: IterationSnapshot, pr: Pr, repo: Repo, signal: AbortSignal, deadline: number): Promise<IterationPatch> {
    const { db, store, paths } = this.d;
    const dir = paths.iterationDir(it.id);
    const prompt = await readFile(join(dir, "prompt.md"), "utf8");
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new PermanentError(`Timed out after ${snap.timeoutMin} min (the setup command used it up)`);
    const claudePath = this.d.claudePath();
    if (!claudePath) throw new AuthError("claude", "Claude Code isn't installed");
    const pid = (p: number | null) => db.updateIteration(it.id, { pid: p });

    try {
      const result = await runIteration({
        claudePath,
        cwd: this.cwd(snap, pr, repo),
        baseEnv: this.d.env(),
        ghConfigDir: paths.ghConfig,
        pluginDir: paths.plugin,
        trustRepoClaudeConfig: snap.trustRepoClaudeConfig,
        model: snap.model,
        effort: snap.effort,
        maxTurns: snap.maxTurns,
        timeoutMs,
        signal,
        prompt,
        pr: prContext(repo, pr, it.headSha!),
        workspace: { kind: it.cwdKind ?? "worktree", contextDir: dir, setupCommand: snap.setupCommand },
        transcriptPath: it.transcriptPath ?? paths.iterationTranscript(it.id),
        clientApp: `heron/${this.d.version}`,
        onSpawn: pid,
        onInit: ({ sessionId, model }) => db.updateIteration(it.id, { sessionId, resolvedModel: model }),
        onUsage: (usage) => db.addIterationUsage(it.id, usage),
        onStep: (step) => store.iterationStep(it, step),
      });
      const raw = JSON.stringify(result.structuredOutput, null, 2);
      const parsed = parseIterationOutput(result.structuredOutput);
      if (!parsed.ok) throw new OutputParseError(`The output doesn't match the iteration format: ${parsed.error}`, raw);
      return { rawOutput: raw, output: normalizeOutput(parsed.output, it.items ?? []), pid: null };
    } finally {
      pid(null);
    }
  }

  // ── committing ────────────────────────────────────────────────────────────

  private async commit(it: Iteration, snap: IterationSnapshot, pr: Pr, repo: Repo): Promise<{ patch: IterationPatch; to: IterationState }> {
    const { git, paths } = this.d;
    const output = it.output;
    if (!output || !it.headSha) throw new PermanentError("Nothing to commit (the agent's output is missing)");
    const cwd = this.cwd(snap, pr, repo);
    const trailer = iterationTrailer(it.id);

    // A commit made before a crash is found again by its trailer.
    let sha = await git.headCommitWithTrailer(cwd, it.headSha, trailer);
    if (!sha) {
      try {
        sha = await git.commitAll(cwd, it.headSha, { title: output.commitTitle.split("\n")[0]!.trim(), body: commitBody(it, output), trailer });
      } catch (err) {
        if (err instanceof GitError) throw new PermanentError(`Couldn't commit: ${err.message}`, { cause: err });
        throw err;
      }
    }
    // No commit, but the threads the agent left alone still get their reason.
    if (!sha) return { patch: {}, to: this.replyTargets(it, snap).length > 0 ? "replying" : "no_changes" };

    // Kept under a ref in Heron's clone, so resetting the checkout never loses it (and the push goes from there).
    const clone = paths.cloneDir(repo.owner, repo.name);
    const ref = `refs/heron/iterations/${it.id}`;
    if (it.cwdKind === "local") {
      await git.fetchFromPath(clone, cwd, "HEAD", ref);
      if (!(await git.hasCommit(clone, sha))) throw new PermanentError("Couldn't copy the commit from the local checkout into Heron's clone");
    } else {
      await git.updateRef(clone, ref, sha);
    }
    await writeFile(paths.iterationDiff(it.id), await git.diff(clone, it.headSha, sha));
    return { patch: { commitSha: sha }, to: snap.dryRun || !snap.autoPush ? "ready" : "pushing" };
  }

  // ── pushing ───────────────────────────────────────────────────────────────

  private async push(it: Iteration, pr: Pr, repo: Repo): Promise<IterationPatch> {
    const { github, git, paths } = this.d;
    if (this.d.settings().dryRun) throw new PermanentError("Dry run is on, so Heron doesn't push");
    if (!it.commitSha || !it.headSha) throw new PermanentError("Nothing to push");
    const detail = await github.getPull(repo.owner, repo.name, pr.number);
    if (detail.state !== "open") throw new PrClosedError(detail.state);
    // Already there: pushed before a crash, or by hand from the local checkout.
    if (detail.headSha === it.commitSha) return {};
    if (detail.headSha !== it.headSha) throw new StaleError(detail.headSha);
    const res = await git.push(paths.cloneDir(repo.owner, repo.name), repo.owner, repo.name, it.commitSha, detail.headRef);
    if (!res.ok) {
      if (res.reason === "rejected") throw new StaleError(null);
      throw new PermanentError(`GitHub refused the push to ${detail.headRef}: ${res.message}`);
    }
    return {};
  }

  // ── replying ──────────────────────────────────────────────────────────────

  /**
   * "Addressed in abc1234 — <note>" on each addressed inline thread, then resolve the thread;
   * "Not addressed — <note>" on each one the agent left alone, which stays open for the reviewer.
   * Other notes stay in the app.
   */
  private async reply(it: Iteration, snap: IterationSnapshot, pr: Pr, repo: Repo): Promise<IterationPatch> {
    const { github, store } = this.d;
    const targets = this.replyTargets(it, snap);
    if (targets.length === 0) return {};

    // The marker makes a retry skip the threads it already answered.
    const done = await github.listIterationReplies(repo.owner, repo.name, pr.number, it.id);
    const resolve: number[] = [];
    for (const t of targets) {
      if (!done.has(t.rootId)) {
        try {
          await github.replyToReviewComment(repo.owner, repo.name, pr.number, t.rootId, `${t.body}\n\n${iterationMarker(it.id)}`);
        } catch (err) {
          // A deleted comment shouldn't fail the iteration (its commit may already be pushed).
          if (classifyError(err) !== "permanent") throw err;
          store.activity({ prId: it.prId, reviewId: null, iterationId: it.id, kind: "iteration.error", message: `Couldn't reply on a thread: ${errorMessage(err)}` });
          continue;
        }
      }
      if (t.resolve) resolve.push(t.rootId);
    }
    if (resolve.length > 0) await this.resolveThreads(it, pr, repo, resolve);
    return {};
  }

  /** The inline threads to reply on. Addressed ones need the commit; an item the agent didn't report on gets nothing. */
  private replyTargets(it: Iteration, snap: IterationSnapshot): ReplyTarget[] {
    if (!snap.reply || this.d.settings().dryRun || !it.output) return [];
    return it.output.items.flatMap<ReplyTarget>((o) => {
      const item = it.items?.find((i) => i.number === o.number);
      if (item?.kind !== "inline") return [];
      if (o.status === "addressed") {
        return it.commitSha ? [{ rootId: item.threadRootId, body: `Addressed in ${short(it.commitSha)} — ${o.note}`, resolve: true }] : [];
      }
      return o.note === UNREPORTED_NOTE ? [] : [{ rootId: item.threadRootId, body: `Not addressed — ${o.note}`, resolve: false }];
    });
  }

  /** Resolve the threads Heron answered. Already-resolved ones are left alone, so a retry is harmless. */
  private async resolveThreads(it: Iteration, pr: Pr, repo: Repo, rootIds: number[]): Promise<void> {
    const { github, store } = this.d;
    const failed = (err: unknown) => {
      if (classifyError(err) !== "permanent") throw err;
      store.activity({ prId: it.prId, reviewId: null, iterationId: it.id, kind: "iteration.error", message: `Couldn't resolve a thread: ${errorMessage(err)}` });
    };
    let threads: Map<number, { id: string; resolved: boolean }>;
    try {
      threads = await github.listReviewThreads(repo.owner, repo.name, pr.number);
    } catch (err) {
      return failed(err);
    }
    for (const rootId of rootIds) {
      const thread = threads.get(rootId);
      if (!thread || thread.resolved) continue;
      try {
        await github.resolveReviewThread(thread.id);
      } catch (err) {
        failed(err);
      }
    }
  }
}

/** A reply on an inline thread; addressed threads are also resolved. */
interface ReplyTarget {
  rootId: number;
  body: string;
  resolve: boolean;
}

function prContext(repo: Repo, pr: Pr, headSha: string): PrContext {
  return {
    repo: `${repo.owner}/${repo.name}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author,
    url: pr.url,
    baseRef: pr.baseRef,
    baseSha: pr.baseSha,
    headRef: pr.headRef,
    headSha,
  };
}

/** The note on an item the agent left out of its output. It's no reason to give a reviewer, so it's never posted. */
const UNREPORTED_NOTE = "The agent didn't report on this item.";

/** One entry per item, in order: unknown numbers dropped, duplicates collapsed, missing ones reported as not addressed. */
function normalizeOutput(output: IterationOutput, items: IterationItem[]): IterationOutput {
  const byNumber = new Map<number, IterationOutputItem>();
  for (const o of output.items) if (!byNumber.has(o.number)) byNumber.set(o.number, o);
  return {
    commitTitle: output.commitTitle,
    items: items.map((i) => byNumber.get(i.number) ?? { number: i.number, status: "not_addressed", note: UNREPORTED_NOTE }),
  };
}

/** The commit body: each addressed comment's note and link. */
function commitBody(it: Iteration, output: IterationOutput): string {
  return output.items
    .filter((o) => o.status === "addressed")
    .map((o) => {
      const url = it.items?.find((i) => i.number === o.number)?.url;
      return `- ${o.note.trim()}${url ? `\n  ${url}` : ""}`;
    })
    .join("\n");
}
