import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { envKey, splitPath } from "./env.ts";
import { windows } from "./os.ts";

/**
 * git when it isn't on PATH: macOS's `/usr/bin/git` (the Command Line Tools shim). Windows has
 * nothing to fall back on; a missing git fails the Doctor, so the queue never runs it (§17.3).
 */
export const FALLBACK_GIT = windows ? "git.exe" : "/usr/bin/git";

function isExecutable(p: string): boolean {
  try {
    // Windows has no execute bit (X_OK only checks that the path exists), so there it must be a file.
    if (windows) return statSync(p).isFile();
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATHEXT's extensions in lower case (`.exe`), so `git` resolves to `git.exe`. */
function pathExts(env: NodeJS.ProcessEnv): string[] {
  return (env[envKey(env, "PATHEXT")] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
}

/**
 * Resolve a binary on the given PATH (like `which`). On Windows each PATHEXT extension is tried in
 * each folder, unless `bin` already has one.
 */
export function which(bin: string, env: NodeJS.ProcessEnv): string | null {
  const exts = windows && !extname(bin) ? pathExts(env) : [""];
  for (const dir of splitPath(env[envKey(env, "PATH")])) {
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

/**
 * The `claude` executable (§17.4). On Windows only the native `claude.exe` will do, never a `.cmd`:
 * cmd.exe re-parses a wrapper's arguments, and they can't be escaped reliably. It's looked for on
 * Path, then where the native installer puts it.
 */
export function findClaude(env: NodeJS.ProcessEnv): string | null {
  if (!windows) return which("claude", env) ?? [join(homedir(), ".claude", "local", "claude")].find(isExecutable) ?? null;
  const native = which("claude.exe", env) ?? [join(homedir(), ".local", "bin", "claude.exe")].find(isExecutable);
  if (native) return native;
  // npm installs the same native binary, but puts a `claude.cmd` wrapper on Path. Run what it launches.
  const wrapper = which("claude", env);
  return wrapper && /\.(cmd|bat)$/i.test(wrapper) ? exeFromWrapper(wrapper) : null;
}

/**
 * The quoted `.exe` a `.cmd` wrapper launches, when it exists. npm's ends in
 * `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`.
 */
function exeFromWrapper(wrapper: string): string | null {
  let text: string;
  try {
    text = readFileSync(wrapper, "utf8");
  } catch {
    return null;
  }
  for (const m of text.matchAll(/"([^"\r\n]+?\.exe)"/gi)) {
    const exe = resolve(dirname(wrapper), m[1]!.replace(/%~?dp0%?[\\/]?/gi, ""));
    // Wrappers of JavaScript packages launch node.exe, which isn't Claude Code.
    if (basename(exe).toLowerCase() === "node.exe") continue;
    if (isExecutable(exe)) return exe;
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
    claude: findClaude(env),
  };
}
