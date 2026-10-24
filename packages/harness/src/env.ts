// Best-effort isolation for the agent (§7.5). The agent still has full tools.

const STRIP_EXACT = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  // Heron reviews on the user's subscription login, never an API key that happens to be in the shell.
  "ANTHROPIC_API_KEY",
  // Set when Heron itself was started from a Claude Code session (e.g. `pnpm dev`).
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
]);

export function stripEnv(base: NodeJS.ProcessEnv, ghConfigDir: string, clientApp: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIP_EXACT.has(k) || k.startsWith("GITHUB_") || k.startsWith("GIT_CONFIG_")) continue;
    env[k] = v;
  }
  // `gh` keeps its token in the Keychain; an empty config dir makes it look logged out.
  env.GH_CONFIG_DIR = ghConfigDir;
  env.GIT_TERMINAL_PROMPT = "0";
  // Reset git's credential helpers (osxkeychain etc.) so git can't fetch with stored credentials either.
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = clientApp;
  return env;
}
