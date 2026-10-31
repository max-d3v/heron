import { spawn } from "node:child_process";
import { PermanentError } from "@heron/core";
import { groupSpawnOptions, setupShell, stopTree } from "@heron/platform";
import { stripEnv } from "./env.ts";
import { RunAbortedError } from "./runner.ts";

export interface SetupCommandOptions {
  command: string;
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  /** The git on PATH; on Windows, Git Bash is looked for in the same install (§17.6). */
  gitPath: string | null;
  ghConfigDir: string;
  clientApp: string;
  timeoutMs: number;
  signal: AbortSignal;
  onSpawn?: (pid: number) => void;
  /** Output as it arrives (stdout and stderr). */
  onOutput?: (text: string) => void;
}

/**
 * Run the repo's setup command (e.g. `pnpm install`) in the iteration worktree before the
 * agent, through the user's shell (Git Bash on Windows, §17.6) and with the same token
 * stripping as the agent (§15.5). A non-zero exit fails the iteration with the output's
 * tail; it isn't retried.
 */
export async function runSetupCommand(o: SetupCommandOptions): Promise<void> {
  if (o.signal.aborted) throw new RunAbortedError(String(o.signal.reason ?? "aborted"));
  const shell = setupShell(o.baseEnv, o.gitPath);
  const child = spawn(shell.path, [...shell.args, o.command], {
    cwd: o.cwd,
    env: stripEnv(o.baseEnv, o.ghConfigDir, o.clientApp),
    stdio: ["ignore", "pipe", "pipe"],
    // Stopped as a tree, so a timeout or cancel stops everything it started.
    ...groupSpawnOptions(),
  });
  if (child.pid) o.onSpawn?.(child.pid);

  let tail = "";
  const onData = (d: Buffer) => {
    const text = d.toString("utf8");
    tail = (tail + text).slice(-6000);
    o.onOutput?.(text);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  let stopped: string | null = null;
  const stop = (why: string) => {
    if (stopped || !child.pid) return;
    stopped = why;
    void stopTree(child.pid, 5000);
  };
  const onAbort = () => stop(String(o.signal.reason ?? "aborted"));
  o.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), Math.max(0, o.timeoutMs));

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (c) => resolve(c));
    });
    if (stopped === "timeout") throw new PermanentError(`The setup command \`${o.command}\` ran out of time\n${tail.trim()}`);
    if (stopped) throw new RunAbortedError(stopped);
    if (code !== 0) {
      throw new PermanentError(`The setup command \`${o.command}\` failed (exit ${code ?? "signal"})\n${tail.trim().split("\n").slice(-30).join("\n")}`);
    }
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", onAbort);
  }
}
