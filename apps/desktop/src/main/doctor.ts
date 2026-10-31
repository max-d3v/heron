import { execFile } from "node:child_process";
import type { DoctorCheck, DoctorReport } from "@heron/rpc";
import type { GitHubClient } from "@heron/github";
import { verifyClaudeLogin } from "@heron/harness";
import type { Binaries } from "@heron/platform";

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** git, gh and claude: installed and logged in (§12). The queue waits until all pass. */
export async function runDoctor(
  bins: Binaries,
  env: NodeJS.ProcessEnv,
  github: GitHubClient,
  scratch: { ghConfigDir: string; cwd: string },
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let viewer: DoctorReport["viewer"] = null;

  // git
  if (!bins.git) {
    checks.push({ id: "git", label: "git", ok: false, detail: "Not found on your PATH.", fix: "Install the Xcode Command Line Tools: xcode-select --install" });
  } else {
    const r = await run(bins.git, ["--version"], env);
    checks.push({
      id: "git",
      label: "git",
      ok: r.ok,
      detail: r.ok ? `${r.stdout.trim()} (${bins.git})` : r.stderr.trim(),
      fix: r.ok ? null : "Install the Xcode Command Line Tools: xcode-select --install",
    });
  }

  // gh
  if (!bins.gh) {
    checks.push({ id: "gh", label: "GitHub CLI", ok: false, detail: "Not found on your PATH.", fix: "brew install gh, then gh auth login" });
  } else {
    const status = await run(bins.gh, ["auth", "status", "--hostname", "github.com"], env);
    if (!status.ok) {
      checks.push({ id: "gh", label: "GitHub CLI", ok: false, detail: "Not logged in to github.com.", fix: "gh auth login" });
    } else {
      try {
        github.resetAuth();
        viewer = await github.viewer();
        checks.push({ id: "gh", label: "GitHub CLI", ok: true, detail: `Logged in as ${viewer.login}`, fix: null });
      } catch (err) {
        checks.push({
          id: "gh",
          label: "GitHub CLI",
          ok: false,
          detail: `The gh token doesn't work with the API: ${err instanceof Error ? err.message : String(err)}`,
          fix: "gh auth refresh -h github.com -s repo",
        });
      }
    }
  }

  // claude
  if (!bins.claude) {
    checks.push({
      id: "claude",
      label: "Claude Code",
      ok: false,
      detail: "Not found on your PATH.",
      fix: "curl -fsSL https://claude.ai/install.sh | bash, then run claude and log in",
    });
  } else {
    const version = await run(bins.claude, ["--version"], env);
    const auth = await run(bins.claude, ["auth", "status"], env);
    let loggedIn: boolean;
    let who = "";
    try {
      const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string };
      loggedIn = Boolean(parsed.loggedIn);
      who = [parsed.email, parsed.subscriptionType ? `${parsed.subscriptionType} plan` : parsed.authMethod].filter(Boolean).join(", ");
    } catch {
      loggedIn = auth.ok;
    }
    // `auth status` trusts the stored login even when the session has expired; one tiny request tells.
    let expired: string | null = null;
    if (version.ok && loggedIn) {
      const check = await verifyClaudeLogin(bins.claude, env, scratch.ghConfigDir, scratch.cwd);
      if (!check.ok) {
        loggedIn = false;
        expired = check.auth ? "The saved login has expired." : check.message;
      }
    }
    checks.push({
      id: "claude",
      label: "Claude Code",
      ok: version.ok && loggedIn,
      detail: !version.ok
        ? version.stderr.trim() || "Couldn't run claude --version"
        : loggedIn
          ? `${version.stdout.trim()}${who ? `, ${who}` : ""}`
          : (expired ?? "Not logged in."),
      fix: !version.ok ? "Reinstall Claude Code" : loggedIn ? null : "Run claude in a terminal and log in with /login",
    });
  }

  return { ok: checks.every((c) => c.ok), checkedAt: Date.now(), checks, viewer };
}
