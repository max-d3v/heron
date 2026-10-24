import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ORPCError, implement } from "@orpc/server";
import type { Settings } from "@heron/core";
import type { HeronDb } from "@heron/db";
import { diskUsage, type GitClient } from "@heron/git";
import type { GitHubClient, PrFile } from "@heron/github";
import { OUTPUT_CONTRACT_SUMMARY } from "@heron/harness";
import { contract, type DoctorReport, type ModelOption, type SkillDto, type TranscriptEntry } from "@heron/rpc";
import type { Bus } from "./bus.ts";
import { listPrItems, toRepoDto, toReviewDetail, toRunSummary } from "./dto.ts";
import type { Paths } from "./paths.ts";
import type { Poller } from "./poller.ts";
import type { Scheduler } from "./scheduler.ts";
import { skillCommand, type SkillService } from "./skills.ts";
import type { Store } from "./store.ts";

export interface Services {
  db: HeronDb;
  store: Store;
  bus: Bus;
  scheduler: Scheduler;
  poller: Poller;
  github: GitHubClient;
  git: GitClient;
  skills: SkillService;
  paths: Paths;
  version: string;
  claudePath: () => string | null;
  viewerLogin: () => string | null;
  doctor: { last: () => DoctorReport | null; run: () => Promise<DoctorReport> };
  models: () => Promise<ModelOption[]>;
  updateSettings: (patch: Partial<Settings>) => Settings;
  pickFolder: (defaultPath: string) => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
  reveal: (path: string) => void;
}

/** Errors thrown by services carry a message meant for the user; don't let oRPC mask it. */
const os = implement(contract).use(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (err instanceof ORPCError) throw err;
    throw new ORPCError("BAD_REQUEST", { message: err instanceof Error ? err.message : String(err), cause: err });
  }
});

function summarizeTranscriptLine(obj: Record<string, unknown>): { type: string; summary: string } {
  const type = String(obj.type ?? "unknown");
  const subtype = typeof obj.subtype === "string" ? `:${obj.subtype}` : "";
  const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");
  if (type === "assistant" || type === "user") {
    const content = (obj.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return { type, summary: clip(content) };
    if (Array.isArray(content)) {
      const parts = content.map((b: Record<string, unknown>) => {
        if (b.type === "text") return clip(String(b.text ?? ""));
        if (b.type === "tool_use") return `→ ${String(b.name)} ${clip(JSON.stringify(b.input ?? {}), 120)}`;
        if (b.type === "tool_result") {
          const c = b.content;
          const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join(" ") : "";
          return `← ${clip(text, 160)}`;
        }
        if (b.type === "thinking") return "(thinking)";
        return String(b.type);
      });
      return { type, summary: parts.join(" · ") };
    }
  }
  if (type === "result") return { type: type + subtype, summary: clip(String(obj.result ?? (obj.errors as string[] | undefined)?.join("; ") ?? "")) };
  if (type === "system" && obj.subtype === "init") return { type: type + subtype, summary: `model ${String(obj.model)}` };
  if (type === "stderr") return { type, summary: clip(String(obj.text ?? "")) };
  if (type === "heron") return { type, summary: String(obj.event ?? "") };
  return { type: type + subtype, summary: "" };
}

export function createRouter(s: Services) {
  const { db } = s;
  const fileCache = new Map<string, PrFile[]>();

  const skillDto = async (id: number): Promise<SkillDto> => {
    const skill = s.skills.require(id);
    const { description, exists } = await s.skills.describe(skill);
    const usedBy = db.listProfiles().filter((p) => p.entry.type === "skill" && p.entry.skillId === id).map((p) => p.name);
    return { ...skill, command: `/${skillCommand(skill)}`, description, exists, usedBy };
  };

  const requirePr = (id: number) => {
    const pr = db.getPr(id);
    if (!pr) throw new ORPCError("NOT_FOUND", { message: "PR not found" });
    return pr;
  };
  const requireRepo = (id: number) => {
    const repo = db.getRepo(id);
    if (!repo) throw new ORPCError("NOT_FOUND", { message: "Repo not found" });
    return repo;
  };

  return os.router({
    app: {
      info: os.app.info.handler(() => ({
        version: s.version,
        dataDir: s.paths.root,
        viewerLogin: s.viewerLogin(),
        claudePath: s.claudePath(),
      })),
      openExternal: os.app.openExternal.handler(async ({ input }) => {
        if (!/^https:\/\//.test(input.url)) throw new ORPCError("BAD_REQUEST", { message: "Only https links open externally" });
        await s.openExternal(input.url);
      }),
      revealPath: os.app.revealPath.handler(({ input }) => {
        const p = resolve(input.path);
        const allowed = [s.paths.root, join(homedir(), ".claude")];
        if (!isAbsolute(input.path) || !allowed.some((root) => p.startsWith(root))) {
          throw new ORPCError("BAD_REQUEST", { message: "Can only reveal Heron's own files" });
        }
        s.reveal(p);
      }),
      events: os.app.events.handler(async function* ({ signal }) {
        for await (const e of s.bus.subscribe("app", { signal })) yield e;
      }),
    },

    doctor: {
      get: os.doctor.get.handler(() => s.doctor.last()),
      check: os.doctor.check.handler(() => s.doctor.run()),
    },

    repos: {
      list: os.repos.list.handler(() => db.listRepos().map((r) => toRepoDto(db, r))),
      available: os.repos.available.handler(async () => {
        const added = new Set(db.listRepos().map((r) => `${r.owner}/${r.name}`.toLowerCase()));
        const repos = await s.github.listRepos();
        return repos.map((r) => ({ ...r, added: added.has(`${r.owner}/${r.name}`.toLowerCase()) }));
      }),
      add: os.repos.add.handler(({ input }) => {
        const existing = db.listRepos().find((r) => r.owner.toLowerCase() === input.owner.toLowerCase() && r.name.toLowerCase() === input.name.toLowerCase());
        if (existing) return toRepoDto(db, existing);
        const repo = db.addRepo({ owner: input.owner, name: input.name, scope: "mine", profileId: null });
        s.bus.publish("app", { kind: "config", what: "repos" });
        // First poll records the PRs that are already open (listed, not reviewed).
        void s.poller.pollRepo(repo).then(() => {
          s.bus.publish("app", { kind: "config", what: "repos" });
          s.store.prsChanged();
        });
        return toRepoDto(db, repo);
      }),
      update: os.repos.update.handler(({ input }) => {
        requireRepo(input.id);
        const repo = db.updateRepo(input.id, input.patch);
        s.bus.publish("app", { kind: "config", what: "repos" });
        s.store.prsChanged();
        s.scheduler.tick();
        return toRepoDto(db, repo);
      }),
      remove: os.repos.remove.handler(async ({ input }) => {
        const repo = requireRepo(input.id);
        s.scheduler.stopRepo(repo.id);
        db.deleteRepo(repo.id);
        s.bus.publish("app", { kind: "config", what: "repos" });
        s.store.prsChanged();
        await rm(join(s.paths.worktrees, repo.owner, repo.name), { recursive: true, force: true });
        await rm(s.paths.cloneDir(repo.owner, repo.name), { recursive: true, force: true });
      }),
      openPrs: os.repos.openPrs.handler(({ input }) =>
        db
          .listPrsForRepo(input.id)
          .filter((p) => p.state === "open")
          .map((p) => ({ number: p.number, title: p.title, author: p.author, isDraft: p.isDraft })),
      ),
      setManualPrs: os.repos.setManualPrs.handler(({ input }) => {
        const repo = requireRepo(input.id);
        const before = db.getManualPrs(repo.id);
        db.setManualPrs(repo.id, input.numbers);
        const added = input.numbers.filter((n) => !before.has(n));
        if (repo.scope === "manual" && added.length > 0) s.scheduler.onManualPicks(repo, added);
        s.bus.publish("app", { kind: "config", what: "repos" });
        s.store.prsChanged();
        return toRepoDto(db, repo);
      }),
    },

    profiles: {
      list: os.profiles.list.handler(() => db.listProfiles()),
      save: os.profiles.save.handler(({ input }) => {
        if (input.entry.type === "skill" && !db.getSkill(input.entry.skillId)) {
          throw new ORPCError("BAD_REQUEST", { message: "Pick a skill for this profile" });
        }
        const saved = db.saveProfile(input);
        s.bus.publish("app", { kind: "config", what: "profiles" });
        return saved;
      }),
      remove: os.profiles.remove.handler(({ input }) => {
        db.deleteProfile(input.id);
        s.bus.publish("app", { kind: "config", what: "profiles" });
      }),
      setDefault: os.profiles.setDefault.handler(({ input }) => {
        db.setDefaultProfile(input.id);
        s.bus.publish("app", { kind: "config", what: "profiles" });
      }),
      models: os.profiles.models.handler(() => s.models()),
      outputContract: os.profiles.outputContract.handler(() => OUTPUT_CONTRACT_SUMMARY),
    },

    skills: {
      list: os.skills.list.handler(async () => Promise.all(db.listSkills().map((sk) => skillDto(sk.id)))),
      importFromDialog: os.skills.importFromDialog.handler(async () => {
        const dir = await s.pickFolder(join(homedir(), ".claude", "skills"));
        if (!dir) return null;
        const skill = await s.skills.importFolder(dir);
        s.bus.publish("app", { kind: "config", what: "skills" });
        return skillDto(skill.id);
      }),
      linkable: os.skills.linkable.handler(() => s.skills.listLinkable()),
      link: os.skills.link.handler(async ({ input }) => {
        const skill = await s.skills.link(input.name);
        s.bus.publish("app", { kind: "config", what: "skills" });
        return skillDto(skill.id);
      }),
      remove: os.skills.remove.handler(async ({ input }) => {
        await s.skills.remove(input.id);
        s.bus.publish("app", { kind: "config", what: "skills" });
      }),
      files: os.skills.files.handler(({ input }) => s.skills.files(input.id)),
      writeSkillMd: os.skills.writeSkillMd.handler(async ({ input }) => {
        const skill = await s.skills.writeSkillMd(input.id, input.content);
        s.bus.publish("app", { kind: "config", what: "skills" });
        return skillDto(skill.id);
      }),
      reveal: os.skills.reveal.handler(({ input }) => {
        const skill = s.skills.require(input.id);
        s.reveal(join(skill.path, "SKILL.md"));
      }),
    },

    settings: {
      get: os.settings.get.handler(() => db.getSettings()),
      update: os.settings.update.handler(({ input }) => s.updateSettings(input)),
      diskUsage: os.settings.diskUsage.handler(async () => ({
        reposBytes: await diskUsage(s.paths.repos),
        worktreesBytes: await diskUsage(s.paths.worktrees),
        transcriptsBytes: await diskUsage(s.paths.transcripts),
      })),
      clearWorktreeCache: os.settings.clearWorktreeCache.handler(async () => {
        if (s.scheduler.runningCount > 0) {
          throw new ORPCError("CONFLICT", { message: "Reviews are running. Pause the queue and wait for them to finish first." });
        }
        const before = (await diskUsage(s.paths.repos)) + (await diskUsage(s.paths.worktrees));
        await rm(s.paths.worktrees, { recursive: true, force: true });
        await rm(s.paths.repos, { recursive: true, force: true });
        const after = (await diskUsage(s.paths.repos)) + (await diskUsage(s.paths.worktrees));
        return { freedBytes: Math.max(0, before - after) };
      }),
    },

    prs: {
      list: os.prs.list.handler(() => listPrItems(db, s.viewerLogin())),
      get: os.prs.get.handler(({ input }) => {
        const pr = requirePr(input.id);
        const repo = requireRepo(pr.repoId);
        const item = listPrItems(db, s.viewerLogin()).find((p) => p.id === pr.id);
        const profile = (repo.profileId !== null ? db.getProfile(repo.profileId) : null) ?? db.getDefaultProfile();
        const runs = db.listReviewsForPr(pr.id);
        return {
          ...(item ?? {
            id: pr.id,
            repoId: pr.repoId,
            repo: `${repo.owner}/${repo.name}`,
            number: pr.number,
            title: pr.title,
            author: pr.author,
            authorAvatarUrl: pr.authorAvatarUrl,
            isDraft: pr.isDraft,
            state: pr.state,
            url: pr.url,
            headSha: pr.headSha,
            inScope: false,
            repoEnabled: repo.enabled,
            status: "not_reviewed" as const,
            headUnreviewed: false,
            latestReviewId: runs[0]?.id ?? null,
            latestError: null,
            lastActivityAt: pr.lastActivityAt,
          }),
          body: pr.body,
          headRef: pr.headRef,
          baseRef: pr.baseRef,
          baseSha: pr.baseSha,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          createdAt: pr.createdAt,
          profileName: profile?.name ?? null,
          runs: runs.map(toRunSummary),
        };
      }),
      files: os.prs.files.handler(async ({ input }) => {
        const pr = requirePr(input.id);
        const repo = requireRepo(pr.repoId);
        const key = `${pr.id}:${pr.headSha}`;
        const cached = fileCache.get(key);
        if (cached) return cached;
        const files = await s.github.listPullFiles(repo.owner, repo.name, pr.number);
        fileCache.set(key, files);
        return files;
      }),
      activity: os.prs.activity.handler(({ input }) => db.listActivityForPr(input.id, { limit: 500 })),
      watch: os.prs.watch.handler(async function* ({ signal }) {
        const events = s.bus.subscribe("prs", { signal });
        yield listPrItems(db, s.viewerLogin());
        for await (const _ of events) yield listPrItems(db, s.viewerLogin());
      }),
    },

    reviews: {
      get: os.reviews.get.handler(({ input }) => {
        const r = db.getReview(input.id);
        if (!r) throw new ORPCError("NOT_FOUND", { message: "Review not found" });
        return toReviewDetail(r);
      }),
      reviewNow: os.reviews.reviewNow.handler(({ input }) => toRunSummary(s.scheduler.reviewNow(input.prId))),
      rerun: os.reviews.rerun.handler(({ input }) => toRunSummary(s.scheduler.rerun(input.reviewId))),
      cancel: os.reviews.cancel.handler(({ input }) => s.scheduler.cancel(input.reviewId)),
      transcript: os.reviews.transcript.handler(async ({ input }) => {
        const r = db.getReview(input.id);
        const path = r?.transcriptPath ?? s.paths.transcript(input.id);
        if (!existsSync(path)) return { entries: [], truncated: false };
        const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
        const max = 3000;
        const entries: TranscriptEntry[] = lines.slice(0, max).map((line, index) => {
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line) as Record<string, unknown>;
          } catch {
            obj = { type: "unparsed" };
          }
          return { index, ...summarizeTranscriptLine(obj), raw: line.length > 50_000 ? `${line.slice(0, 50_000)}…` : line };
        });
        return { entries, truncated: lines.length > max };
      }),
      steps: os.reviews.steps.handler(({ input }) =>
        db.listActivityForReview(input.id, { kind: "agent.step" }).map((a) => ({
          id: a.id,
          reviewId: input.id,
          ts: a.ts,
          step: { kind: (a.data?.kind as never) ?? "other", label: a.message, ...(a.data?.detail ? { detail: String(a.data.detail) } : {}) },
        })),
      ),
      activity: os.reviews.activity.handler(async function* ({ input, signal }) {
        // Subscribe first so nothing falls between the backlog read and the live feed.
        const live = s.bus.subscribe("activity", { signal });
        const backlog = db.listActivityForPr(input.prId, { limit: 300 });
        let last = 0;
        for (const a of backlog) {
          last = a.id;
          yield a;
        }
        for await (const a of live) {
          if (a.prId !== input.prId || a.kind === "agent.step" || a.id <= last) continue;
          yield a;
        }
      }),
      agentSteps: os.reviews.agentSteps.handler(async function* ({ input, signal }) {
        const live = s.bus.subscribe("step", { signal });
        let last = 0;
        for (const a of db.listActivityForReview(input.reviewId, { kind: "agent.step" })) {
          last = a.id;
          yield {
            id: a.id,
            reviewId: input.reviewId,
            ts: a.ts,
            step: { kind: (a.data?.kind as never) ?? "other", label: a.message, ...(a.data?.detail ? { detail: String(a.data.detail) } : {}) },
          };
        }
        for await (const e of live) {
          if (e.reviewId !== input.reviewId || e.id <= last) continue;
          yield e;
        }
      }),
    },

    queue: {
      pause: os.queue.pause.handler(() => s.scheduler.pauseManual(true)),
      resume: os.queue.resume.handler(() => s.scheduler.pauseManual(false)),
      status: os.queue.status.handler(async function* ({ signal }) {
        const live = s.bus.subscribe("queue", { signal });
        yield s.scheduler.status();
        for await (const status of live) yield status;
      }),
    },
  });
}

export type AppRouter = ReturnType<typeof createRouter>;
