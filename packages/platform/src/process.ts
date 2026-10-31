import { execFile, type SpawnOptions } from "node:child_process";
import { system32, windows } from "./os.ts";

/**
 * Spawn options that let a child and everything it starts be stopped together. macOS: its own
 * process group. Windows: `detached` would open a console window for it, and `taskkill /T` finds
 * the tree without one; the window it would get anyway stays hidden.
 */
export function groupSpawnOptions(): Pick<SpawnOptions, "detached" | "windowsHide"> {
  return windows ? { windowsHide: true } : { detached: true };
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile(system32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { timeout: 15_000, windowsHide: true }, () => resolve());
  });
}

/**
 * Stop a process and everything it started. macOS signals the whole process group. Windows runs
 * `taskkill /T /F`: console processes have no gentler stop, so `signal` doesn't apply there.
 */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (windows) {
    void taskkill(pid);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Stop a tree the way cancel and timeout do (§17.5): SIGTERM, then SIGKILL after `graceMs` on
 * macOS; at once on Windows, where a later second kill could hit a reused pid. Resolves after the last kill.
 */
export function stopTree(pid: number, graceMs: number): Promise<void> {
  if (windows) return taskkill(pid);
  killTree(pid, "SIGTERM");
  return new Promise((resolve) => {
    setTimeout(() => {
      killTree(pid, "SIGKILL");
      resolve();
    }, graceMs).unref();
  });
}

/**
 * What `pid` is running, for the orphan check (§6.4): its command line on macOS, its image name
 * (`claude.exe`) on Windows. Null when no such process exists.
 */
export function processName(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (windows) {
      execFile(system32("tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        // "claude.exe","1234","Console","1","123,456 K", or an INFO line when nothing matches.
        const m = err ? null : /^"([^"]+)","(\d+)"/m.exec(String(stdout));
        resolve(m && Number(m[2]) === pid ? m[1]! : null);
      });
      return;
    }
    execFile("/bin/ps", ["-p", String(pid), "-o", "command="], (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}
