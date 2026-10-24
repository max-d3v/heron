import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const START = "__HERON_ENV_START__";
const END = "__HERON_ENV_END__";

/**
 * The environment of the user's login shell. Apps opened from Finder get a bare
 * PATH, so `gh`, `git` and `claude` would otherwise not be found. Starting from a
 * minimal env also keeps a dev session's variables (e.g. from a terminal running
 * Claude Code) out of the agent's environment.
 */
export async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL || "/bin/zsh";
  const base: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? homedir(),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: shell,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const script = `printf '%s\\0' '${START}'; /usr/bin/env -0; printf '%s\\0' '${END}'`;
  const parsed = await new Promise<NodeJS.ProcessEnv | null>((resolve) => {
    execFile(shell, ["-ilc", script], { env: base, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const parts = stdout.split("\0");
      const s = parts.indexOf(START);
      const e = parts.indexOf(END);
      if (s < 0 || e < 0) return resolve(null);
      const env: NodeJS.ProcessEnv = {};
      for (const kv of parts.slice(s + 1, e)) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      resolve(env);
    });
  });

  const env = parsed ?? { ...process.env };
  // Drop what the shell set up for its own interactive session.
  for (const k of ["SHLVL", "PWD", "OLDPWD", "_", "TERM_PROGRAM", "TERM_SESSION_ID", "ZSH_EXECUTION_STRING"]) delete env[k];
  env.TERM = "dumb";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local")];
  const path = (env.PATH ?? "").split(":").filter(Boolean);
  for (const p of extra) if (!path.includes(p)) path.push(p);
  env.PATH = path.join(":");
  return env;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a binary on the given PATH (like `which`). */
export function which(bin: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (isExecutable(p)) return p;
  }
  return null;
}

export interface Binaries {
  git: string | null;
  gh: string | null;
  claude: string | null;
}

export function resolveBinaries(env: NodeJS.ProcessEnv): Binaries {
  return {
    git: which("git", env),
    gh: which("gh", env),
    claude: which("claude", env) ?? [join(homedir(), ".claude", "local", "claude")].find(isExecutable) ?? null,
  };
}
