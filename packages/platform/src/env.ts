import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { windows } from "./os.ts";
import { regQuery } from "./registry.ts";

const START = "__HERON_ENV_START__";
const END = "__HERON_ENV_END__";

/** What a shell sets up for its own interactive session; the tools Heron runs don't need it. */
const SESSION_VARS = ["SHLVL", "PWD", "OLDPWD", "_", "TERM_PROGRAM", "TERM_SESSION_ID", "ZSH_EXECUTION_STRING"];

/** The form a variable name compares in: as is on macOS, upper case on Windows, where names are case-insensitive. */
export function envName(name: string): string {
  return windows ? name.toUpperCase() : name;
}

/**
 * The key `name` is stored under in `env`. A copied env object is case-sensitive even on Windows,
 * so there it's the existing key in whatever case (`Path`), and setting it never adds a second one.
 */
export function envKey(env: NodeJS.ProcessEnv, name: string): string {
  if (!windows) return name;
  const upper = name.toUpperCase();
  return Object.keys(env).find((k) => k.toUpperCase() === upper) ?? name;
}

/** The folders of a PATH value. */
export function splitPath(value: string | undefined): string[] {
  return (value ?? "").split(delimiter).filter(Boolean);
}

/** The environment tools run with (§17.3). Called at startup and on every Doctor run. */
export function loadEnv(): Promise<NodeJS.ProcessEnv> {
  return windows ? loadWindowsEnv() : loadShellEnv();
}

/**
 * macOS: the environment of the user's login shell. Apps opened from Finder get a bare
 * PATH, so `gh`, `git` and `claude` would otherwise not be found. Starting from a
 * minimal env also keeps a dev session's variables (e.g. from a terminal running
 * Claude Code) out of the agent's environment.
 */
async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL || "/bin/zsh";
  const base: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? homedir(),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: shell,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const script = `printf '%s\\0' '${START}'; /usr/bin/env -0; printf '%s\\0' '${END}'`;
  const parsed = await new Promise<NodeJS.ProcessEnv | null>((resolve) => {
    execFile(shell, ["-ilc", script], { env: base, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const parts = stdout.split("\0");
      const s = parts.indexOf(START);
      const e = parts.indexOf(END);
      if (s < 0 || e < 0) return resolve(null);
      const env: NodeJS.ProcessEnv = {};
      for (const kv of parts.slice(s + 1, e)) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      resolve(env);
    });
  });

  const env = parsed ?? { ...process.env };
  // Drop what the shell set up for its own interactive session.
  for (const k of SESSION_VARS) delete env[k];
  env.TERM = "dumb";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local")];
  const path = splitPath(env.PATH);
  for (const p of extra) if (!path.includes(p)) path.push(p);
  env.PATH = path.join(delimiter);
  return env;
}

/**
 * Windows: GUI apps already get the user's full `Path` from the registry, so there's no shell to ask.
 * Heron's own environment doesn't change when an installer updates `Path`, though, so `Path` is
 * rebuilt from the registry each time: a tool installed while Heron runs is found without a restart.
 */
async function loadWindowsEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (SESSION_VARS.includes(k.toUpperCase())) delete env[k];
  env[envKey(env, "TERM")] = "dumb";

  const [machine, user] = await Promise.all([
    regQuery("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "Path"),
    regQuery("HKCU\\Environment", "Path"),
  ]);
  const key = envKey(env, "Path");
  // Machine entries, then the user's, as Windows joins them at sign-in. The ones Heron started with
  // follow: `reg` prints in the console's code page, so a folder with non-ASCII characters in its
  // name may not survive the trip, but its original is still there.
  const entries = [
    ...splitPath(machine === null ? undefined : expandVars(machine, env)),
    ...splitPath(user === null ? undefined : expandVars(user, env)),
    ...splitPath(env[key]),
    // The native Claude installer's folder.
    join(homedir(), ".local", "bin"),
  ];
  const seen = new Set<string>();
  const path: string[] = [];
  for (const p of entries) {
    const id = p.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    path.push(p);
  }
  env[key] = path.join(delimiter);
  return env;
}

/** Expand `%VAR%` the way Windows does for `REG_EXPAND_SZ` values; unknown names stay as they are. */
function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => env[envKey(env, name)] ?? whole);
}
