import { execFile } from "node:child_process";
import { system32 } from "./os.ts";

/**
 * One value from the Windows registry, as `reg query` prints it (a `REG_DWORD` comes back as `0x1`).
 * Null when the key or the value doesn't exist.
 */
export function regQuery(key: string, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(system32("reg.exe"), ["query", key, "/v", name], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      // "    Path    REG_EXPAND_SZ    %USERPROFILE%\AppData\Local\Microsoft\WindowsApps;…"
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^\s+(.+?) {4}REG_\w+(?: {4}(.*))?$/.exec(line);
        if (m && m[1]!.toLowerCase() === name.toLowerCase()) return resolve((m[2] ?? "").trim());
      }
      resolve(null);
    });
  });
}
