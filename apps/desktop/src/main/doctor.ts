import { execFile } from "node:child_process";
import type { DoctorCheck, DoctorReport } from "@heron/rpc";
import type { GitHubClient } from "@heron/github";
import { verifyClaudeLogin } from "@heron/harness";
import { longPathsEnabled, setupShell, which, type Binaries } from "@heron/platform";
import { isWindows } from "./platform.ts";

/** How to install each tool (§12, §17.8). */
const INSTALL = isWindows
  ? {
      git: "winget install Git.Git",
      gh: "winget install GitHub.cli, then gh auth login",
      claude: "irm https://claude.ai/install.ps1 | iex (in PowerShell), then run claude and log in",
    }
  : {
      git: "Install the Xcode Command Line Tools: xcode-select --install",
      gh: "brew install gh, then gh auth login",
      claude: "curl -fsSL https://claude.ai/install.sh | bash, then run claude and log in",
    };

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * git, gh and claude: installed and logged in (§12). The queue waits until all pass. Windows adds
 * two rows that only warn: the setup shell and long paths (§17.8).
 */
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
    checks.push({ id: "git", label: "git", ok: false, detail: "Not found on your PATH.", fix: INSTALL.git, blocking: true });
  } else {
    const r = await run(bins.git, ["--version"], env);
    checks.push({
      id: "git",
      label: "git",
      ok: r.ok,
      detail: r.ok ? `${r.stdout.trim()} (${bins.git})` : r.stderr.trim(),
      fix: r.ok ? null : INSTALL.git,
      blocking: true,
    });
  }

  // gh
  if (!bins.gh) {
    checks.push({ id: "gh", label: "GitHub CLI", ok: false, detail: "Not found on your PATH.", fix: INSTALL.gh, blocking: true });
  } else {
    const status = await run(bins.gh, ["auth", "status", "--hostname", "github.com"], env);
    if (!status.ok) {
      checks.push({ id: "gh", label: "GitHub CLI", ok: false, detail: "Not logged in to github.com.", fix: "gh auth login", blocking: true });
    } else {
      try {
        github.resetAuth();
        viewer = await github.viewer();
        checks.push({ id: "gh", label: "GitHub CLI", ok: true, detail: `Logged in as ${viewer.login}`, fix: null, blocking: true });
      } catch (err) {
        checks.push({
          id: "gh",
          label: "GitHub CLI",
          ok: false,
          detail: `The gh token doesn't work with the API: ${err instanceof Error ? err.message : String(err)}`,
          fix: "gh auth refresh -h github.com -s repo",
          blocking: true,
        });
      }
    }
  }

  // claude
  if (!bins.claude) {
    // Windows: npm's claude.cmd can be on Path without the claude.exe it launches (§17.4).
    const wrapper = which("claude", env);
    checks.push({
      id: "claude",
      label: "Claude Code",
      ok: false,
      detail: wrapper ? `Only ${wrapper} was found, and Heron runs the native claude.exe, never a wrapper.` : "Not found on your PATH.",
      fix: INSTALL.claude,
      blocking: true,
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
      blocking: true,
    });
  }

  if (isWindows) {
    // Setup commands are written for bash; PowerShell may not run them (§17.6).
    const shell = setupShell(env, bins.git);
    const bash = shell.name === "Git Bash";
    checks.push({
      id: "shell",
      label: "Setup shell",
      ok: bash,
      detail: bash ? `Setup commands run in Git Bash (${shell.path}).` : `Setup commands run in ${shell.name} (${shell.path}), so one written for bash may fail.`,
      fix: bash ? null : INSTALL.git,
      blocking: false,
    });
  }

  const longPaths = await longPathsEnabled();
  if (longPaths !== null) {
    checks.push({
      id: "longPaths",
      label: "Long paths",
      ok: longPaths,
      detail: longPaths
        ? "Windows accepts paths over 260 characters."
        : "Windows limits paths to 260 characters, which a setup command's node_modules can pass. Turning the limit off needs an administrator PowerShell; restart Heron after:",
      fix: longPaths ? null : 'New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force',
      blocking: false,
    });
  }

  return { ok: checks.every((c) => c.ok || !c.blocking), checkedAt: Date.now(), checks, viewer };
}
