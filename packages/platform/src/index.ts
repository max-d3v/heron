// The Node-level differences between macOS and Windows (§17.2), each with both implementations
// side by side. git, harness and the desktop main process use these and never ask which OS it is.
export { envKey, envName, loadEnv, splitPath } from "./env.ts";
export { FALLBACK_GIT, findClaude, resolveBinaries, which, type Binaries } from "./tools.ts";
export { groupSpawnOptions, killTree, processName, stopTree } from "./process.ts";
export { setupShell, type SetupShell } from "./shell.ts";
export { diskUsage, longPathsEnabled } from "./disk.ts";
