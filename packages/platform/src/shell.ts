import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { envKey } from "./env.ts";
import { system32, windows } from "./os.ts";
import { which } from "./tools.ts";

export interface SetupShell {
  /** What Settings and the Doctor call it: "zsh", "Git Bash", "PowerShell". */
  name: string;
  path: string;
  /** The arguments before the command itself. */
  args: string[];
}

/**
 * The shell a repo's setup command runs in (§17.6). macOS: the user's own. Windows: Git Bash, so a
 * command written on macOS (`pnpm install && pnpm build`) works unchanged; PowerShell without it.
 */
export function setupShell(env: NodeJS.ProcessEnv, gitPath: string | null): SetupShell {
  if (!windows) {
    const path = env.SHELL || "/bin/zsh";
    return { name: basename(path), path, args: ["-c"] };
  }
  const bash = gitBash(env, gitPath);
  if (bash) return { name: "Git Bash", path: bash, args: ["-c"] };
  // Windows PowerShell 5.1 has no `&&`; PowerShell 7 does.
  const args = ["-NoProfile", "-NonInteractive", "-Command"];
  const pwsh = which("pwsh", env);
  if (pwsh) return { name: "PowerShell", path: pwsh, args };
  return { name: "Windows PowerShell", path: which("powershell", env) ?? system32("WindowsPowerShell", "v1.0", "powershell.exe"), args };
}

/** Git Bash, found the way Claude Code finds it. */
function gitBash(env: NodeJS.ProcessEnv, gitPath: string | null): string | null {
  const v = (name: string) => env[envKey(env, name)];
  const programFiles = v("ProgramFiles");
  const localAppData = v("LOCALAPPDATA");
  const candidates = [
    v("CLAUDE_CODE_GIT_BASH_PATH"),
    programFiles && join(programFiles, "Git", "bin", "bash.exe"),
    localAppData && join(localAppData, "Programs", "Git", "bin", "bash.exe"),
    // The Git install the `git` on Path belongs to: <root>\cmd\git.exe → <root>\bin\bash.exe.
    gitPath && join(dirname(dirname(gitPath)), "bin", "bash.exe"),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}
