# Heron — Spec (v1)

A macOS desktop app that uses **your own Claude subscription** as an automatic PR reviewer. You choose which repos and which PRs get reviewed, and how (prompt or skill, model, effort). Heron polls GitHub, runs a Claude agent on a local checkout of each PR, and posts the result as a GitHub review.

Audience for v1: **only me**. Every choice must still allow a **public** release later (see §13).

---

## 1. Scope

**In v1**
- Claude only, through the **TypeScript Claude Agent SDK**.
- Repo scopes: All PRs / Only mine / Manual (hand-picked PRs).
- Automatic re-review on every push (debounced). Draft handling configurable per repo.
- Named review profiles: prompt **or** skill, plus model, effort and limits.
- Reviews **auto-post** as a GitHub `COMMENT` review under the user's own identity.
- Live UI: pickup, progress and agent steps stream into the app as they happen.
- Durable pipeline: a persisted state machine with retries and crash/quit recovery.
- Menu bar icon, launch-at-login toggle.

**Not in v1**
- Other providers (Codex etc.). The harness is behind an interface so they can be added later.
- An "agent posts directly" mode (dropped).
- Approving reviews before posting (everything auto-posts).
- APPROVE / REQUEST_CHANGES verdicts (always `COMMENT`).
- Installing dependencies or running setup in worktrees (reviews are of the code only).
- A full diff viewer (use "Open on GitHub").
- Running in the background after Quit.
- Tests.
- Signing, notarization, auto-update (planned for the public release).

---

## 2. Architecture

```
┌──────────────────────── Electron ────────────────────────┐
│ Renderer (React)        │ Main process                    │
│  - UI only              │  - SQLite (better-sqlite3)      │
│  - oRPC client  ◀──MessagePort──▶ oRPC router             │
│                         │  - Scheduler / state machine    │
│ Preload (contextBridge) │  - Poller (Octokit + ETags)     │
│  - hands over the port  │  - Git (clones, worktrees)      │
│                         │  - Harness (Agent SDK → claude) │
│                         │  - Tray, notifications          │
└─────────────────────────┴─────────────────────────────────┘
          │ git binary        │ GitHub REST       │ claude binary
```

- **The main process** owns everything stateful. **The renderer** never touches the DB, the filesystem or the network.
- **Event-driven, not event-sourced.** State tables are the source of truth. Every state change also appends a row to `activity` in the same transaction and is published on an in-process bus, which feeds oRPC streaming procedures for the live UI.
- `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer.

---

## 3. Monorepo structure

pnpm workspaces + Turborepo. All TypeScript (ESM). Packages export source directly (no separate build step); the Electron app bundles them with electron-vite.

```
heron/
├── apps/
│   └── desktop/                 # Electron app (electron-vite + electron-builder)
│       ├── src/main/            # composition root: wires packages together, windows, tray, lifecycle
│       ├── src/preload/         # contextBridge: MessagePort handoff only
│       ├── src/renderer/        # React UI (Tailwind + Radix), oRPC client
│       ├── electron-builder.yml
│       └── electron.vite.config.ts
├── packages/
│   ├── core/                    # pure domain: types, review state machine, transitions,
│   │                            # retry/error classification, trigger rules, scope filters,
│   │                            # review output schema (zod + JSON schema), diff/line validation
│   ├── db/                      # better-sqlite3 connection, migrations, repositories (queries)
│   ├── github/                  # Octokit wrapper: gh token, ETag polling, PR/diff/comments fetch,
│   │                            # review payload builder, review posting, marker lookup
│   ├── git/                     # partial clones, fetch pull/N/head, worktree add/reset/remove, diffs
│   ├── harness/                 # Agent SDK runner: prompt assembly, output contract text (schema from core),
│   │                            # skill plugin dir, env stripping, stream → AgentStep mapping
│   ├── rpc/                     # oRPC contract (zod) shared by main + renderer
│   └── config/                  # shared tsconfig / eslint presets
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
└── SPEC.md
```

Dependency rules:
- `core` depends on nothing internal. Everything else may depend on `core`.
- `github`, `git`, `harness` don't depend on `db` or on each other. The **scheduler in `apps/desktop/src/main`** combines them. (If it grows, move it into `packages/pipeline`.)
- `rpc` depends only on `core` types and zod. The renderer imports only `rpc` and `core` types.
- Only `apps/desktop` imports `electron`.

---

## 4. Configuration model

### Repos (Settings → Repos)
| Field | Notes |
|---|---|
| `owner/name` | Picked from the user's accessible repos (via `gh` token) |
| `scope` | `all` \| `mine` \| `manual` |
| `manualPrs` | For `manual`: PRs picked from the repo's open PR list |
| `includeDrafts` | Default **off**. A manually picked draft is always reviewed. |
| `profileId` | `null` → default profile |
| `trustRepoClaudeConfig` | Default **off**. When on, also loads the repo's `.claude/` (`settingSources` gains `project`). |
| `enabled` | Pause one repo |

### Review profiles (Settings → Profiles)
| Field | Notes |
|---|---|
| `name`, `isDefault` | Exactly one default |
| `entry` | `{ type: "prompt", markdown }` **or** `{ type: "skill", skillId }` |
| `model` | Alias (`opus`/`sonnet`/`haiku`) or a custom model ID |
| `effort` | Levels as exposed by the installed SDK |
| `timeoutMin` | Default 20 |
| `maxTurns` | Default 100 |

The prompt page shows a **read-only "Output contract" box** under the editor. It explains that the app appends the PR context and the required GitHub-review JSON format, that the diff and context are in `.heron/`, and that `gh` isn't available, so skills must not rely on `` !`gh …` ``.

### Skills
- **Import:** copy a skill folder into `Application Support/Heron/plugin/skills/<name>/`. `SKILL.md` can be edited in the app; other files are view-only with "Reveal in Finder".
- **Link:** reference a skill in `~/.claude/skills/<name>/` (not copied).
- Each run stores the skill's content hash in its snapshot.

### General settings
Parallel runs (default 2), poll interval (default 60s), debounce (default 5 min), dry run (default off), launch at login (default off), notifications on posted/failed, clear worktree cache (shows disk usage).

---

## 5. Triggers

- **Unit of work:** `(PR, headSha)`. A review is **owed** when the PR is in scope, open, not a draft (unless allowed), and its `headSha` has no review yet.
- **No backfill.** When a repo is added, PRs that are already open are listed as *not reviewed*, with a **Review now** button. Only PRs opened or pushed to afterwards are triggered automatically.
- **Debounce:** a new SHA sets `runAfter = now + debounce`. Further pushes during the debounce window reset it.
- **Supersede:** a new SHA on a PR with a review in progress → abort it (`AbortController`), mark it `superseded`, and owe the new SHA.
- **Draft → ready** counts as a trigger.
- **Manual actions:** Review now, Re-run (any PR or SHA).
- **Global pause:** from the menu bar or automatically on usage/rate limits (§6.3).

---

## 6. Review pipeline

### 6.1 States
```
debouncing → queued → preparing → running → validating → posting → posted
                                                          ↘ completed (dry run)
any → failed | superseded | cancelled
```
Each `reviews` row stores: `state, runAfter, attempt, lastError, pid, sessionId, profileSnapshot, resolvedModel, transcriptPath, outputJson, githubReviewId`.

### 6.2 Steps
Every step is **idempotent** and saves its output before changing state.

1. **preparing**
   - Fetch PR metadata, full diff, human review comments and replies, and our earlier reviews.
   - Make sure the repo clone exists, then fetch `pull/N/head`, and add or reset a worktree at `headSha`.
   - Write `.heron/` (see §7.3).
2. **running**
   - Agent SDK `query()` (§7). Stream steps to `activity` and the live UI. Write the full transcript to JSONL.
   - Record the `pid` and `sessionId`.
3. **validating**
   - Parse the structured output against the schema (§7.4). **If parsing fails → `failed`**, with no automatic retry; show the raw output and a Re-run button.
   - Check each inline comment against the diff. Comments on lines outside the diff move into the body as `path:line — text`.
4. **posting**
   - If dry run → `completed`.
   - Otherwise **look for an existing review with our marker** for this SHA. If one exists, record it and move to `posted`; if not, `POST` the review with `event: COMMENT`.

### 6.3 Errors and retries
| Class | Examples | Handling |
|---|---|---|
| Transient | network, GitHub 5xx, agent process crash | retry with backoff 30s → 2m → 10m, then `failed` |
| Limit | GitHub rate limit, Claude usage limit | **pause the whole queue** until the reset time; don't use up retries |
| Permanent | PR closed/404, schema parse failure, timeout | `failed`, no retry |
| Auth | `gh`/`claude` logged out | pause the queue and show a banner |

### 6.4 Recovery
- **On launch:** reviews in `preparing`/`running`/`validating`/`posting` go back to the start of their current step. **Kill any orphaned `pid`s** first.
- **On Quit with runs in progress:** confirm ("N reviews running — quit anyway?"), abort them, and mark them interrupted. They resume on the next launch.
- **On wake from sleep:** poll immediately, then continue as normal.

---

## 7. Agent harness (`packages/harness`)

### 7.1 SDK options
```ts
query({
  prompt,                                 // §7.2
  options: {
    cwd: worktreePath,
    pathToClaudeCodeExecutable,           // user's installed `claude` → their own login
    model, effort, maxTurns,
    abortController,                      // supersede, timeout, quit
    permissionMode: "bypassPermissions",  // full tools (headless, no prompts)
    settingSources: trusted ? ["user", "project"] : ["user"],
    plugins: [{ type: "local", path: heronPluginDir }],   // imported skills
    systemPrompt: { type: "preset", preset: "claude_code", append: heronSystemPrompt },
    outputFormat: { type: "json_schema", schema: reviewJsonSchema },
    env: strippedEnv,                     // §7.5
  },
});
```

### 7.2 Prompt assembly
- **Prompt profile:** user message = the profile's markdown.
- **Skill profile:** user message = `/<skill-name>` (`/heron:<name>` for imported skills). Before running, confirm the skill's `SKILL.md` exists. An unknown `/name` does **not** fail in the SDK, so fail the run ourselves.
- **System prompt append** (both modes): repo, PR number, title, description, author, base/head refs and SHAs; a description of each `.heron/` file; "dependencies are not installed — don't build or run tests"; "`gh` is unavailable"; the output contract.

### 7.3 `.heron/` (inside the worktree; listed in the clone's `info/exclude`)
| File | Content |
|---|---|
| `pr.diff` | full diff `base…head` |
| `since-last-review.diff` | `lastReviewedSha..headSha`. **Only written** if the last reviewed SHA is an ancestor (skipped after a force-push) |
| `previous-reviews.json` | our earlier posted reviews on this PR (body + comments) |
| `pr-comments.json` | humans' review comments and replies |
| `pr.json` | PR metadata |

The default system prompt says: focus on what changed, and don't repeat earlier comments unless they still apply and matter. Prompts and skills may use or ignore the files.

### 7.4 Output contract
Mirrors GitHub's review format. **No extra fields** (the format is the user's choice; any structure goes in markdown).
```ts
{
  body: string,
  comments: Array<{
    path: string, line: number, side?: "LEFT" | "RIGHT",
    start_line?: number, start_side?: "LEFT" | "RIGHT",
    body: string,              // markdown; ```suggestion blocks allowed
  }>
}
```
The posted body gets a hidden marker: `<!-- heron:review sha=<headSha> id=<reviewId> -->`.

### 7.5 Isolation (best effort; the agent has full tools)
- Remove `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_*` from the environment.
- Set `GH_CONFIG_DIR` to an empty temp folder, so `gh` appears logged out (its token is in the Keychain).
- Edits the agent makes stay in the throwaway worktree and are never pushed.
- Show a one-time warning when enabling `all` scope: "the agent runs with full tools on other people's code on this Mac."

### 7.6 Live steps
Map SDK messages to `AgentStep`s: `Reading src/auth.ts`, `Searching "token"`, `Running git log …`, `Writing review…`. Send these to `activity` and the UI. Write the raw stream to `transcripts/<reviewId>.jsonl`.

---

## 8. GitHub (`packages/github`)

- **Auth:** `gh auth token` at startup and on 401. Reviews are posted **as the user**. (GitHub only allows `COMMENT` on your own PRs anyway.)
- **Polling:** `GET /repos/{o}/{r}/pulls?state=open` per enabled repo, every 60s, with `If-None-Match` (a `304` doesn't count toward the rate limit). Compare against `prs` and emit `PrObserved`, `HeadShaChanged`, `DraftChanged` and `PrClosed` changes.
- **"Mine" filter:** the PR author equals the authenticated user's login.
- **Posting:** `POST /pulls/{n}/reviews` with `commit_id = headSha`, `event: "COMMENT"`, body and comments.

---

## 9. Git (`packages/git`)

- **Clones:** app-managed partial clones (`--filter=blob:none`) in `Application Support/Heron/repos/<owner>/<name>`, authenticated with the `gh` token over HTTPS.
- **Per-PR worktrees:** `git fetch origin pull/N/head`, then `git worktree add` in `Application Support/Heron/worktrees/<owner>/<name>/<n>`. Reset to the new SHA on a push. **Remove when the PR closes or merges.**
- Uses the user's `git` binary.

---

## 10. Data model (SQLite)

```
repos(id, owner, name, scope, include_drafts, profile_id, trust_repo_claude_config, enabled, etag, created_at)
manual_prs(repo_id, number)
prs(id, repo_id, number, title, author, is_draft, head_sha, head_ref, base_ref, state, url, updated_at)
reviews(id, pr_id, head_sha, state, run_after, attempt, last_error, pid, session_id,
        profile_snapshot_json, resolved_model, transcript_path, output_json,
        github_review_id, created_at, updated_at, last_activity_at)
activity(id, pr_id, review_id, ts, kind, message, data_json)        -- append-only timeline
profiles(id, name, is_default, entry_type, prompt_md, skill_id, model, effort, timeout_min, max_turns)
skills(id, name, source /*imported|linked*/, path, content_hash)
settings(key, value_json)
```
Migrations live in `packages/db`. Each state change and its `activity` row are written in **one transaction**, then published on the bus.

---

## 11. RPC (`packages/rpc`)

oRPC over a `MessagePort` handed to the renderer through the preload script. Zod contracts are shared by both sides.
- Queries/mutations: `repos.*`, `profiles.*`, `skills.*`, `settings.*`, `prs.list`, `prs.get`, `reviews.get`, `reviews.reviewNow`, `reviews.rerun`, `queue.pause/resume`, `doctor.check`.
- **Streams** (async iterators): `prs.watch()`, `reviews.activity(prId)`, `reviews.agentSteps(reviewId)`, `queue.status()`.

---

## 12. UI

Modern native macOS look: `titleBarStyle: "hiddenInset"`, `vibrancy: "sidebar"`, system font, follows light/dark mode. Tailwind + Radix, styled to look like macOS rather than a web dashboard.

**Main window**
- **Sidebar:** a flat list sorted by **latest review activity**. Each row: live status dot (queued, running with spinner, posted, failed, not reviewed), title, `repo#n`, author avatar, relative time. At the top: repo filter + search. At the bottom: ⚙ Settings.
- **Detail header:** title, `owner/repo#n`, author, `head → base`, short SHA. Buttons: Open on GitHub, Review now, Re-run.
- **Tabs:**
  - **Review:** body (markdown), then inline comments grouped by file, each with nearby diff lines. No badges; it's all user-formatted markdown.
  - **Activity:** live timeline.
  - **Runs:** one row per SHA reviewed (profile, model, effort, state, duration). Click to view that run.
  - **Transcript:** collapsed raw transcript.
  - The PR itself: description + changed files with +/− counts.

**Settings:** Repos (scope, drafts, manual PR picker, profile, trust toggle), Profiles (prompt editor **or** skill picker, model, effort, limits, read-only output contract box), Skills (import/link, edit `SKILL.md`), General.

**First run / Doctor:** checks `git`, `gh` (installed and logged in), and `claude` (installed and logged in), each with a fix hint. The queue doesn't start until all are green.

**Menu bar icon:** status (idle / N running / paused + reason). Menu: Open, Pause all / Resume, Quit.

**Lifecycle:** closing the window keeps the app running (Dock + tray). **Quit stops everything.** Launch-at-login toggle.

---

## 13. Distribution

- **v1:** an unsigned `.dmg` built with electron-builder, for personal use only.
- **Public later:**
  - Apple Developer ID, signing and notarization in CI.
  - `electron-updater` using GitHub Releases.
  - **Check Anthropic's terms on third-party apps using Claude.ai subscription login**, which includes Agent SDK apps. If needed, add an API-key fallback for auth.

---

## 14. To check while building
- Exact TS SDK option names: `pathToClaudeCodeExecutable`, `effort`, `outputFormat`, `permissionMode` (and whether bypass needs an extra opt-in flag), `plugins`.
- The plugin manifest needed for `heronPluginDir`, and the resulting skill names (`heron:<name>`).
- oRPC's current Electron / MessagePort adapter API.
- The SDK's message type for usage limits and its reset time, used to pause the queue.

## 15. Open questions
- **Fork PRs in `all` scope:** review them, or skip by default? (Not decided; untrusted code with full tools.)
- Query layer for SQLite: raw SQL vs Drizzle.
