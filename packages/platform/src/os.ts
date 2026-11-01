import { join } from "node:path";

/** The one place that asks which OS this is (§17.2). Everything else in the package keys off it. */
export const windows = process.platform === "win32";

/** A program in Windows' System32, by full path, so a same-named one on Path can't stand in for it. */
export function system32(...parts: string[]): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...parts);
}
