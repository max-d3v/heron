import { execFile } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { windows } from "./os.ts";
import { regQuery } from "./registry.ts";

/** Disk usage of a folder in bytes, 0 when it doesn't exist. `du -sk` on macOS, a walk on Windows. */
export async function diskUsage(path: string): Promise<number> {
  try {
    await stat(path);
  } catch {
    return 0;
  }
  if (windows) return walk(path);
  return new Promise((resolve) => {
    execFile("/usr/bin/du", ["-sk", path], (err, stdout) => {
      if (err) return resolve(0);
      resolve(Number(stdout.split(/\s+/)[0] ?? 0) * 1024);
    });
  });
}

/** The size of every file under `dir`. Links (and pnpm's junctions) count as themselves; they're never followed. */
async function walk(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    names.map(async (name) => {
      const p = join(dir, name);
      try {
        const s = await lstat(p);
        return s.isDirectory() ? walk(p) : s.size;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((a, b) => a + b, 0);
}

/**
 * Whether Windows accepts paths over 260 characters (`LongPathsEnabled`, §17.7). Null on macOS,
 * which has no such limit.
 */
export async function longPathsEnabled(): Promise<boolean | null> {
  if (!windows) return null;
  return Number(await regQuery("HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "LongPathsEnabled")) === 1;
}
