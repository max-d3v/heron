import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Everything Heron stores lives under Application Support/Heron (%LOCALAPPDATA%\Heron on Windows, §17.7). */
export function makePaths(root: string) {
  const paths = {
    root,
    db: join(root, "heron.db"),
    repos: join(root, "repos"),
    worktrees: join(root, "worktrees"),
    transcripts: join(root, "transcripts"),
    iterations: join(root, "iterations"),
    plugin: join(root, "plugin"),
    pluginSkills: join(root, "plugin", "skills"),
    ghConfig: join(root, "gh-config-empty"),
    /** macOS: the newer release's .dmg, downloaded until it's installed (§13.1). */
    updates: join(root, "updates"),
    /**
     * A repo's folder: its bare clone in `.git`, its iteration worktrees in `.claude/worktrees`. That's the
     * layout the Claude app recognizes as a repo's worktrees, so a session continued there ("Open in Claude")
     * lands in the repo's project rather than a new one named after the worktree's folder.
     */
    repoDir: (owner: string, name: string) => join(root, "repos", owner, name),
    cloneDir: (owner: string, name: string) => join(root, "repos", owner, name, ".git"),
    worktreeDir: (owner: string, name: string, number: number) => join(root, "worktrees", owner, name, String(number)),
    transcript: (reviewId: number) => join(root, "transcripts", `${reviewId}.jsonl`),
    /** Copy of the diff a run reviewed, kept for validation and the UI after the worktree moves on. */
    runDiff: (reviewId: number) => join(root, "transcripts", `${reviewId}.diff`),
    /** A repo's iteration worktrees, one per iteration, each named `heron-pr-<n>-<id>`. */
    iterationWorktreesDir: (owner: string, name: string) => join(root, "repos", owner, name, ".claude", "worktrees"),
    /** The prefix of a PR's iteration worktree names, so they can be removed together when it closes. */
    prIterationWorktreePrefix: (number: number) => `heron-pr-${number}-`,
    /**
     * Each iteration gets its own worktree, apart from the review one, so a later run never resets it.
     * One from before the move to `.claude/worktrees` stays where it is: its saved session ran there.
     */
    iterationWorktreeDir: (owner: string, name: string, number: number, iterationId: number) => {
      const legacy = join(root, "worktrees", "iterations", owner, name, String(number), String(iterationId));
      return existsSync(legacy) ? legacy : join(paths.iterationWorktreesDir(owner, name), `${paths.prIterationWorktreePrefix(number)}${iterationId}`);
    },
    /** Where a PR's iteration worktrees used to go, removed when it closes. Heron kept one shared worktree here before that. */
    legacyPrIterationWorktreesDir: (owner: string, name: string, number: number) => join(root, "worktrees", "iterations", owner, name, String(number)),
    /** An iteration's context files (pr.json, pr.diff, pr-comments.json, feedback.json), outside the checkout. */
    iterationDir: (iterationId: number) => join(root, "iterations", String(iterationId)),
    iterationTranscript: (iterationId: number) => join(root, "transcripts", `iteration-${iterationId}.jsonl`),
    /** The iteration's commit as a diff, for the UI. */
    iterationDiff: (iterationId: number) => join(root, "transcripts", `iteration-${iterationId}.diff`),
  };
  return paths;
}

export type Paths = ReturnType<typeof makePaths>;

export function ensureLayout(paths: Paths, version: string): void {
  for (const dir of [paths.root, paths.repos, paths.worktrees, paths.transcripts, paths.iterations, paths.pluginSkills, paths.ghConfig]) {
    mkdirSync(dir, { recursive: true });
  }
  migrateClones(paths);
  // Imported skills are served to Claude Code as the "heron" plugin: /heron:<name>.
  mkdirSync(join(paths.plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(paths.plugin, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "heron", version, description: "Review skills imported into Heron" }, null, 2)}\n`,
  );
}

/**
 * Clones used to be bare repos at `repos/<owner>/<name>` itself; they now live in its `.git`. Moves each
 * old one's files in (HEAD last, so an interrupted move is picked up on the next launch), then points its
 * linked worktrees at the new place, as `git worktree repair` would. Refs (iteration results) are kept.
 */
function migrateClones(paths: Paths): void {
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  for (const owner of list(paths.repos)) {
    for (const name of list(join(paths.repos, owner))) {
      const repo = join(paths.repos, owner, name);
      if (!existsSync(join(repo, "HEAD"))) continue;
      try {
        const clone = join(repo, ".git");
        mkdirSync(clone, { recursive: true });
        const entries = readdirSync(repo).filter((e) => e !== ".git" && e !== ".claude" && e !== "HEAD");
        for (const entry of [...entries, "HEAD"]) renameSync(join(repo, entry), join(clone, entry));
        for (const id of list(join(clone, "worktrees"))) {
          const admin = join(clone, "worktrees", id);
          // `gitdir` names the worktree's `.git` file, which names this folder back.
          const pointer = join(admin, "gitdir");
          const dotGit = existsSync(pointer) ? readFileSync(pointer, "utf8").trim() : "";
          // Gone, or made by a git with relative paths (no Heron worktree): `worktree prune` deals with it.
          if (isAbsolute(dotGit) && existsSync(dotGit)) writeFileSync(dotGit, `gitdir: ${admin.replace(/\\/g, "/")}\n`);
        }
      } catch (err) {
        console.error(`Couldn't move the clone in ${repo} to its .git folder`, err);
      }
    }
  }
}
