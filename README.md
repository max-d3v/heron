# Heron

A highly configurable macOS app that reviews GitHub pull requests with your own Claude subscription. See [SPEC.md](SPEC.md) for the design.

Comes with a SKILL that is highly recommended!

<img width="1228" height="789" alt="Screenshot 2026-10-27 at 8 06 07 PM" src="https://github.com/user-attachments/assets/f3fbfeaa-58da-40da-b12d-9c9c507e4a71" />


## Requirements

- macOS, Node 22+, pnpm 11
- `git`, `gh` (logged in: `gh auth login`) and `claude` (logged in: run `claude`, then `/login`)

## Develop

```bash
pnpm install
pnpm dev            # electron-vite dev server with HMR
pnpm typecheck      # all packages (turbo)
pnpm lint
```

Data lives in `~/Library/Application Support/Heron` (SQLite DB, clones, worktrees, transcripts, imported skills). Set `HERON_DATA_DIR=/some/dir` to run against a separate copy.

## Build the app

```bash
pnpm dist           # → apps/desktop/dist/Heron-<version>-arm64.dmg (unsigned)
```

The first launch of an unsigned build needs right-click → Open.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Domain types, review state machine, retry classes, trigger/scope rules, output schema, diff parsing and line validation |
| `packages/db` | better-sqlite3 connection, migrations, queries |
| `packages/github` | Octokit wrapper: `gh` token, ETag polling, conversation fetch, review posting with marker lookup |
| `packages/git` | Partial bare clones, `pull/N/head` fetch, worktrees, diffs (token passed via env config, never on argv or disk) |
| `packages/harness` | Agent SDK runner: prompt assembly, env isolation, SDK message → step mapping, login check |
| `packages/rpc` | oRPC contract (zod) shared by main and renderer |
| `apps/desktop` | Electron app: scheduler, poller, pipeline, tray, React UI |

## Notes on §14 (checked against Agent SDK 0.3.310 and Claude Code 2.1.308)

- Option names are as in the spec: `pathToClaudeCodeExecutable`, `effort` (`low`…`max`), `outputFormat: { type: "json_schema", schema }`, `plugins: [{ type: "local", path }]`. `permissionMode: "bypassPermissions"` also needs `allowDangerouslySkipPermissions: true`.
- Plugin manifest: `<plugin>/.claude-plugin/plugin.json` with `{ "name": "heron" }`; skills in `<plugin>/skills/<name>/SKILL.md` are exposed as `/heron:<name>`.
- oRPC: `RPCHandler` from `@orpc/server/message-port` takes the port in main; `RPCLink` from `@orpc/client/message-port` in the renderer.
- Usage limits arrive as a `rate_limit_event` whose `rate_limit_info.status` is `"rejected"`, with `resetsAt` in epoch seconds; the turn then ends with an assistant `error: "rate_limit"`.
- `claude auth status` keeps reporting `loggedIn: true` for a stored login whose session has expired, so the setup check also makes one tiny Haiku request to confirm the login works.
