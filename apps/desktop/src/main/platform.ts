import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";

// The Electron differences between macOS and Windows (§17.2, §17.8). The Node-level ones live in
// @heron/platform; nothing else in the main process asks which OS it's on.

export const isWindows = process.platform === "win32";

/**
 * Where Heron keeps its data: Application Support/Heron on macOS. On Windows %LOCALAPPDATA%\Heron
 * rather than Electron's default under the roaming %APPDATA%: clones, worktrees and node_modules
 * mustn't roam with the profile, and the database is no use without them (§17.7).
 */
export function dataRoot(): string {
  if (!isWindows) return join(app.getPath("appData"), "Heron");
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Heron");
}
