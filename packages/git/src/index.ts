import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuthError, PermanentError, TransientError } from "@heron/core";

export interface GitOptions {
  gitPath: () => string;
  /** Base environment (the user's PATH etc.). */
  env: () => NodeJS.ProcessEnv;
  /** Token used for HTTPS fetches. Supplied per call so a refreshed token is picked up. */
  getToken: () => Promise<string>;
}

interface RunOptions {
  cwd?: string;
  auth?: boolean;
  /** Exit codes treated as success (e.g. 1 for `merge-base --is-ancestor`). */
  okCodes?: number[];
  timeoutMs?: number;
}

const MAX_BUFFER = 512 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Partial clones and per-PR worktrees under app-managed folders (§9). */
export class GitClient {
  constructor(private readonly opts: GitOptions) {}

  private async env(auth: boolean): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      ...this.opts.env(),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      LC_ALL: "C",
    };
    if (auth) {
      // Pass the token as an HTTP header through env-provided config, so it never
      // shows up in `ps` output or gets written to the clone's .git/config.
      const token = await this.opts.getToken();
      const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
      env.GIT_CONFIG_COUNT = "2";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
      env.GIT_CONFIG_KEY_1 = "credential.helper";
      env.GIT_CONFIG_VALUE_1 = "";
    }
    return env;
  }

  async run(args: string[], o: RunOptions = {}): Promise<{ stdout: string; code: number }> {
    const env = await this.env(o.auth ?? false);
    return new Promise((resolve, reject) => {
      execFile(
        this.opts.gitPath(),
        args,
        { cwd: o.cwd, env, maxBuffer: MAX_BUFFER, timeout: o.timeoutMs ?? 10 * 60_000, encoding: "utf8" },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
          if (!err || (code !== null && o.okCodes?.includes(code))) {
            resolve({ stdout, code: code ?? 0 });
            return;
          }
          const msg = `git ${args.slice(0, 3).join(" ")} failed${code !== null ? ` (${code})` : ""}: ${stderr.trim().split("\n").slice(-3).join(" ")}`;
          const gitErr = new GitError(msg, code, stderr);
          // Network trouble is worth retrying; anything else (bad ref, missing repo) is not.
          if (/Could not resolve host|Connection (reset|refused|timed out)|early EOF|RPC failed|unable to access|The requested URL returned error: 5\d\d/i.test(stderr)) {
            reject(new TransientError(msg, { cause: gitErr }));
          } else if (/Authentication failed|could not read Username|returned error: 40[13]/i.test(stderr)) {
            reject(new AuthError("github", `${msg} (check \`gh auth status\`)`, { cause: gitErr }));
          } else if (/Repository not found|returned error: 404/i.test(stderr)) {
            reject(new PermanentError(msg, { cause: gitErr }));
          } else {
            reject(gitErr);
          }
        },
      );
    });
  }

  async version(): Promise<string> {
    return (await this.run(["--version"])).stdout.trim();
  }

  /** Make sure the bare partial clone exists. */
  async ensureClone(cloneDir: string, owner: string, name: string): Promise<void> {
    if (existsSync(join(cloneDir, "HEAD"))) return;
    await rm(cloneDir, { recursive: true, force: true });
    await mkdir(dirname(cloneDir), { recursive: true });
    await this.run(
      ["clone", "--bare", "--filter=blob:none", "--no-tags", `https://github.com/${owner}/${name}.git`, cloneDir],
      { auth: true },
    );
  }

  /** Fetch the PR head and its base branch into heron-owned refs. */
  async fetchPr(cloneDir: string, number: number, baseRef: string): Promise<void> {
    await this.run(
      [
        "fetch",
        "--filter=blob:none",
        "--no-tags",
        "--force",
        "origin",
        `+refs/pull/${number}/head:refs/heron/pull/${number}`,
        `+refs/heads/${baseRef}:refs/heron/base/${baseRef}`,
      ],
      { cwd: cloneDir, auth: true },
    );
  }

  /** Ensure `commit` is present (e.g. re-running an older SHA that was force-pushed away). */
  async ensureCommit(cloneDir: string, sha: string): Promise<boolean> {
    if (await this.hasCommit(cloneDir, sha)) return true;
    try {
      await this.run(["fetch", "--filter=blob:none", "--no-tags", "origin", sha], { cwd: cloneDir, auth: true });
    } catch {
      return false;
    }
    return this.hasCommit(cloneDir, sha);
  }

  async hasCommit(cloneDir: string, sha: string): Promise<boolean> {
    const { code } = await this.run(["cat-file", "-e", `${sha}^{commit}`], { cwd: cloneDir, okCodes: [1, 128] });
    return code === 0;
  }

  /** Add the worktree at `sha`, or reset an existing one to it (dropping any edits the agent made). */
  async checkoutWorktree(cloneDir: string, worktreeDir: string, sha: string): Promise<void> {
    const valid = existsSync(join(worktreeDir, ".git"));
    if (valid) {
      try {
        // Blob fetches for the new tree happen here (partial clone), so this needs auth.
        await this.run(["checkout", "--detach", "--force", sha], { cwd: worktreeDir, auth: true });
        await this.run(["clean", "-ffdx", "-e", ".heron/"], { cwd: worktreeDir });
        return;
      } catch {
        // Fall through and recreate it.
      }
    }
    await rm(worktreeDir, { recursive: true, force: true });
    await this.run(["worktree", "prune"], { cwd: cloneDir });
    await mkdir(dirname(worktreeDir), { recursive: true });
    await this.run(["worktree", "add", "--detach", "--force", worktreeDir, sha], { cwd: cloneDir, auth: true });
  }

  async removeWorktree(cloneDir: string, worktreeDir: string): Promise<void> {
    if (existsSync(cloneDir)) {
      await this.run(["worktree", "remove", "--force", worktreeDir], { cwd: cloneDir, okCodes: [128] }).catch(() => undefined);
    }
    await rm(worktreeDir, { recursive: true, force: true });
    if (existsSync(cloneDir)) await this.run(["worktree", "prune"], { cwd: cloneDir }).catch(() => undefined);
  }

  async headSha(worktreeDir: string): Promise<string | null> {
    try {
      return (await this.run(["rev-parse", "HEAD"], { cwd: worktreeDir })).stdout.trim();
    } catch {
      return null;
    }
  }

  async isAncestor(cloneDir: string, ancestor: string, descendant: string): Promise<boolean> {
    if (!(await this.hasCommit(cloneDir, ancestor))) return false;
    const { code } = await this.run(["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: cloneDir,
      okCodes: [1, 128],
    });
    return code === 0;
  }

  async mergeBase(cloneDir: string, a: string, b: string): Promise<string | null> {
    try {
      return (await this.run(["merge-base", a, b], { cwd: cloneDir })).stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * `git diff from to`. Also pulls the blobs both sides need into the partial clone,
   * so the agent's own `git diff`/`git show` on these files works offline.
   */
  async diff(cloneDir: string, from: string, to: string): Promise<string> {
    return (await this.run(["diff", "--no-color", "--no-ext-diff", "-M", from, to], { cwd: cloneDir, auth: true })).stdout;
  }

  /** Keep a path out of `git status` in every worktree of the clone. */
  async addExclude(cloneDir: string, pattern: string): Promise<void> {
    const file = join(cloneDir, "info", "exclude");
    await mkdir(dirname(file), { recursive: true });
    const current = existsSync(file) ? await readFile(file, "utf8") : "";
    if (current.split("\n").includes(pattern)) return;
    await writeFile(file, `${current.replace(/\n?$/, "\n")}${pattern}\n`);
  }
}

/** Disk usage of a folder in bytes (`du -sk`), 0 when it doesn't exist. */
export async function diskUsage(path: string): Promise<number> {
  try {
    await stat(path);
  } catch {
    return 0;
  }
  return new Promise((resolve) => {
    execFile("/usr/bin/du", ["-sk", path], (err, stdout) => {
      if (err) return resolve(0);
      resolve(Number(stdout.split(/\s+/)[0] ?? 0) * 1024);
    });
  });
}
