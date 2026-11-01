import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    cloneDir: (owner: string, name: string) => join(root, "repos", owner, name),
    worktreeDir: (owner: string, name: string, number: number) => join(root, "worktrees", owner, name, String(number)),
    transcript: (reviewId: number) => join(root, "transcripts", `${reviewId}.jsonl`),
    /** Copy of the diff a run reviewed, kept for validation and the UI after the worktree moves on. */
    runDiff: (reviewId: number) => join(root, "transcripts", `${reviewId}.diff`),
    /** Iterations get their own worktree per PR, apart from the review one. */
    iterationWorktreeDir: (owner: string, name: string, number: number) => join(root, "worktrees", "iterations", owner, name, String(number)),
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
  // Imported skills are served to Claude Code as the "heron" plugin: /heron:<name>.
  mkdirSync(join(paths.plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(paths.plugin, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "heron", version, description: "Review skills imported into Heron" }, null, 2)}\n`,
  );
}
