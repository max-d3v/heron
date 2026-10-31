# Heron — Spec (v1)

A desktop app for macOS and Windows (§17) that uses **your own Claude subscription** as an automatic PR reviewer. You choose which repos and which PRs get reviewed, and how (prompt or skill, model, effort). Heron polls GitHub, runs a Claude agent on a local checkout of each PR, and posts the result as a GitHub review.

Audience for v1: **only me**. Every choice must still allow a **public** release later (see §13).

---

## 1. Scope

**In v1**
- Claude only, through the **TypeScript Claude Agent SDK**.
- Repo scopes: All PRs / Only mine / Manual (every PR listed, reviewed only on Review now).
- Automatic re-review on every push (debounced). Draft handling configurable per repo.
- Named review profiles: prompt **or** skill, plus model, effort and limits.
- Reviews **auto-post** as a GitHub `COMMENT` review under the user's own identity.
- Live UI: pickup, progress and agent steps stream into the app as they happen.
- Durable pipeline: a persisted state machine with retries and crash/quit recovery.
- **Iterations** (§15): an agent addresses review feedback on your own PRs, and Heron commits and pushes the result.
- Menu bar icon (system tray on Windows), launch-at-login toggle.
- macOS, and Windows 10/11 on x64 (§17).

**Not in v1**
- Other providers (Codex etc.). The harness is behind an interface so they can be added later.
- An "agent posts directly" mode (dropped).
- Approving reviews before posting (everything auto-posts).
- APPROVE / REQUEST_CHANGES verdicts (always `COMMENT`).
- Installing dependencies or running setup for reviews (reviews are of the code only). Iterations may run a setup command (§15.5).
- A full diff viewer for the PR (use "Open on GitHub"). The Iteration tab shows only its own commit's diff.
- Running in the background after Quit.
- Tests.
- Signing, notarization, auto-update (planned for the public release).
- Linux, and native arm64 Windows builds (§17.1).

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
│   ├── platform/                # OS differences: env/PATH, which, process trees, setup shell, disk usage (§17.2)
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
- `platform` depends on nothing internal. `git`, `harness` and `apps/desktop` may use it; none of them check `process.platform` themselves (§17.2).
- Only `apps/desktop` imports `electron`.

---

## 4. Configuration model

### Repos (Settings → Repos)
| Field | Notes |
|---|---|
| `owner/name` | Picked from the user's accessible repos (via `gh` token) |
| `scope` | `all` \| `mine` \| `manual`. `manual` lists every open PR but never starts a review on its own: reviews start with **Review now**. |
| `includeDrafts` | Default **off**. Not shown for `manual`. |
| `profileId` | `null` → default profile |
| `trustRepoClaudeConfig` | Default **off**. When on, also loads the repo's `.claude/` (`settingSources` gains `project`). |
| `dryRun` | Default **off**, in the Review section. Reviews run but post nothing (no review, no `heron/review` check); results show in the app only. Iterations have no dry run: **Push** is their gate (§15.2). |
| `reviewEnabled` | Turn reviews off for one repo (iterations have their own switch, §15.2) |
| Iteration fields | See §15.2 |

### Profiles (Settings → Profiles)
| Field | Notes |
|---|---|
| `kind` | `review` \| `iteration`. Iteration profiles have no `entry` (§15.2). |
| `name`, `isDefault` | Exactly one default per kind |
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
Grouped by feature. **Reviews:** parallel runs (default 2), debounce (default 5s). **Iterations:** parallel runs (default 2, apart from reviews'), iteration debounce (default 30s), loop cap (default 6); greyed out, with a tooltip saying why, while no repo has iterations on. Shared: poll interval (default 10s), launch at login (default off), notifications on posted/failed, clear worktree cache (shows disk usage).

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
                                                          ↘ completed (dry run, or nothing to post)
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
   - If the repo's dry run is on → `completed`.
   - If the output has an empty body and no comments (no issues found) → `completed`, with nothing posted. The `heron/review` check still turns green ("No issues found").
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
An empty `body` with no `comments` means no issues were found: nothing is posted (§6.2).
The posted body gets a hidden marker: `<!-- heron:review sha=<headSha> id=<reviewId> -->`.

### 7.5 Isolation (best effort; the agent has full tools)
- Remove `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_*` from the environment.
- Set `GH_CONFIG_DIR` to an empty temp folder, so `gh` appears logged out (its token is in the Keychain, or Windows Credential Manager).
- Edits a reviewing agent makes stay in the throwaway worktree and are never pushed. Iterations push the agent's edits, but Heron does the commit and push, never the agent (§15.6).
- Show a one-time warning when enabling `all` scope: "the agent runs with full tools on other people's code on this Mac."

### 7.6 Live steps
Map SDK messages to `AgentStep`s: `Reading src/auth.ts`, `Searching "token"`, `Running git log …`, `Writing review…`. Send these to `activity` and the UI. Write the raw stream to `transcripts/<reviewId>.jsonl`.

---

## 8. GitHub (`packages/github`)

- **Auth:** `gh auth token` at startup and on 401. Reviews are posted **as the user**. (GitHub only allows `COMMENT` on your own PRs anyway.)
- **Polling:** `GET /repos/{o}/{r}/pulls?state=open` per enabled repo, every 60s, with `If-None-Match` (a `304` doesn't count toward the rate limit). Compare against `prs` and emit `PrObserved`, `HeadShaChanged`, `DraftChanged` and `PrClosed` changes.
- **"Mine" filter:** the PR author equals the authenticated user's login.
- **Posting:** `POST /pulls/{n}/reviews` with `commit_id = headSha`, `event: "COMMENT"`, body and comments.
- **Iterations** (§15): fetch the conversation of an eligible PR when its `updated_at` changes, and reply on its inline threads with `POST /pulls/{n}/comments/{id}/replies` (addressed ones after a push).

---

## 9. Git (`packages/git`)

- **Clones:** app-managed partial clones (`--filter=blob:none`) in `Application Support/Heron/repos/<owner>/<name>`, authenticated with the `gh` token over HTTPS.
- **Per-PR worktrees:** `git fetch origin pull/N/head`, then `git worktree add` in `Application Support/Heron/worktrees/<owner>/<name>/<n>`. Reset to the new SHA on a push. **Remove when the PR closes or merges.**
- **Iteration worktrees** (§15.5): a second per-PR worktree in `Application Support/Heron/iteration-worktrees/<owner>/<name>/<n>`, removed on the same terms. Results are kept on `refs/heron/iterations/<id>`.
- **Push** (iterations only): the iteration commit to the PR's head branch, with the same token setup as fetches. Never forced.
- Uses the user's `git` binary.
- Paths in this spec are the macOS ones (`~/Library/Application Support/Heron`). On Windows the root is `%LOCALAPPDATA%\Heron`, with the same layout inside (§17.7).

---

## 10. Data model (SQLite)

```
repos(id, owner, name, scope, include_drafts, profile_id, trust_repo_claude_config, dry_run, review_enabled, iteration_enabled, etag, created_at,
      iteration_auto_start, iteration_comments, iteration_profile_id, iteration_auto_push, iteration_reply, setup_command, local_checkout_path)
prs(id, repo_id, number, title, author, is_draft, head_sha, head_ref, head_repo, base_ref, state, url, updated_at,
    heron_push_streak)
reviews(id, pr_id, head_sha, state, run_after, attempt, last_error, pid, session_id,
        profile_snapshot_json, resolved_model, transcript_path, output_json,
        github_review_id, created_at, updated_at, last_activity_at)
iterations(id, pr_id, head_sha, state, trigger, run_after, attempt, last_error, pid, session_id,
           profile_snapshot_json, resolved_model, cwd_kind /*worktree|local*/, transcript_path, output_json,
           commit_sha, created_at, updated_at, last_activity_at)
feedback(id, pr_id, github_id, kind, thread_root_id, author, body, path, line, diff_hunk,
         verdict, reason, iteration_id, status, created_at, handled_at)    -- one row per GitHub comment
activity(id, pr_id, review_id, iteration_id, ts, kind, message, data_json)  -- append-only timeline
profiles(id, kind, name, is_default, entry_type, prompt_md, skill_id, model, effort, timeout_min, max_turns)
skills(id, name, source /*imported|linked*/, path, content_hash)
settings(key, value_json)
```
Migrations live in `packages/db`. Each state change and its `activity` row are written in **one transaction**, then published on the bus.

---

## 11. RPC (`packages/rpc`)

oRPC over a `MessagePort` handed to the renderer through the preload script. Zod contracts are shared by both sides.
- Queries/mutations: `repos.*`, `profiles.*`, `skills.*`, `settings.*`, `prs.list`, `prs.get`, `reviews.get`, `reviews.reviewNow`, `reviews.rerun`, `iterations.list/get/diff`, `iterations.start/push/discard/rerun`, `feedback.list`, `queue.pause/resume`, `doctor.check`.
- **Streams** (async iterators): `prs.watch()`, `reviews.activity(prId)`, `reviews.agentSteps(reviewId)`, `iterations.agentSteps(iterationId)`, `queue.status()`.

---

## 12. UI

Modern native macOS look: `titleBarStyle: "hiddenInset"`, `vibrancy: "sidebar"`, system font, follows light/dark mode. Tailwind + Radix, styled to look like macOS rather than a web dashboard. Windows keeps the same layout with Windows window chrome (§17.8).

**Main window**
- **Sidebar:** a flat list sorted by **latest review activity**. Each row: live status dot (queued, running with spinner, posted, failed, not reviewed), an iteration badge (§15.8), title, `repo#n`, author avatar, relative time. At the top: repo filter + search. At the bottom: ⚙ Settings.
- **Detail header:** title, `owner/repo#n`, author, `head → base`, short SHA. Buttons: Open on GitHub, Review now, Re-run.
- **Tabs:**
  - **Review:** body (markdown), then inline comments grouped by file, each with nearby diff lines. No badges; it's all user-formatted markdown.
  - **Activity:** live timeline, including feedback and iteration events.
  - **Iteration:** feedback and the latest iteration's diff (§15.8).
  - **Runs:** one row per SHA reviewed (profile, model, effort, state, duration), plus a separate Iterations section. Click to view that run.
  - **Transcript:** collapsed raw transcript.
  - The PR itself: description + changed files with +/− counts.

**Settings:** Repos (Review and Iteration sections with their own switches; scope, drafts, profile, trust toggle), Profiles (review or iteration kind; prompt editor **or** skill picker, model, effort, limits, read-only output contract box), Skills (import/link, edit `SKILL.md`), General.

**First run / Doctor:** checks `git`, `gh` (installed and logged in), and `claude` (installed and logged in), each with a fix hint. The queue doesn't start until all are green. Windows adds two rows that warn but never block (§17.8).

**Menu bar icon:** status (idle / N running / paused + reason, N ready to push). Menu: Open, Pause all / Resume, Quit.

**Lifecycle:** closing the window keeps the app running (Dock + menu bar; the system tray on Windows, §17.8). **Quit stops everything.** Launch-at-login toggle.

---

## 13. Distribution

- **v1:** an unsigned `.dmg` built with electron-builder, for personal use only.
- **Windows v1:** an unsigned per-user NSIS installer, built by a GitHub Actions Windows job (§17.9).
- **Public later:**
  - Apple Developer ID, signing and notarization in CI.
  - Windows code signing, so SmartScreen stops warning.
  - `electron-updater` using GitHub Releases.
  - **Check Anthropic's terms on third-party apps using Claude.ai subscription login**, which includes Agent SDK apps. If needed, add an API-key fallback for auth.

---

## 14. To check while building
- Exact TS SDK option names: `pathToClaudeCodeExecutable`, `effort`, `outputFormat`, `permissionMode` (and whether bypass needs an extra opt-in flag), `plugins`.
- The plugin manifest needed for `heronPluginDir`, and the resulting skill names (`heron:<name>`).
- oRPC's current Electron / MessagePort adapter API.
- The SDK's message type for usage limits and its reset time, used to pause the queue.
- That a new review, inline comment or conversation comment bumps the PR's `updated_at` in the open-PR list, so iterations can detect feedback without polling each PR (§15.3).
- That a Haiku, `effort: "low"`, no-tools, one-turn `query()` with `outputFormat` works for triage on a subscription login (§15.4).

---

## 15. Iterations

An agent addresses review feedback on **your own PRs**, and Heron commits and pushes the result. A quick triage call first sets aside comments that don't ask for a change.

### 15.1 Eligibility
- Open PRs **you opened** (author = the `gh` login), from a branch in the same repo. **Forks are skipped.** Drafts are included.
- The repo's review `scope` doesn't apply. Settings → Repos says so ("Runs only on PRs you opened"), and the Iteration tab shows it as the empty state on other people's PRs.

### 15.2 Configuration
Repos (Settings → Repos): the **Review** and **Iteration** sections each have their own on/off switch (`reviewEnabled`, on by default; `iterationEnabled`, off by default). A repo with both off isn't polled. Iteration fields:
| Field | Notes |
|---|---|
| `iterationAutoStart` | "Automatic iteration": Manual (default) \| Automatic. Whether the agent starts on its own after triage (§15.3). Shown first. |
| `iterationComments` | "Comments to iterate on": `all` (default) \| `mine`. Which comments count (§15.3). |
| `iterationProfileId` | `null` → default iteration profile |
| `iterationAutoPush` | Default **off**: the result waits for **Push**. |
| `iterationReply` | Default **on**: reply on each addressed thread after a push, and on each thread the agent didn't address with its reason. |
| `setupCommand` | e.g. `pnpm install`, run in the iteration worktree before the agent. Disabled, with a note, while `useLocalCheckout` is on. |
| `useLocalCheckout` | Default **off**: Heron works in its own clone. On: run the agent in your own checkout instead (§15.5). Switching it on reuses the folder chosen before, or opens a folder picker; the path can also be typed. |
| `localCheckoutPath` | The checkout. It must be a clone of the repo (a remote points at `github.com/<owner>/<name>`), checked when it's saved or switched on. Kept while the switch is off. |

- **Profiles** gain `kind: "review" | "iteration"`, with one default per kind. Iteration profiles have **no entry** (no prompt or skill), only `model`, `effort`, `timeoutMin` (default 30) and `maxTurns` (default 150). Their page shows the fixed prompt and the output contract read-only.
- **General:** iteration parallel runs (default 2, a cap of their own: iterations and reviews don't share slots), iteration debounce (default 30s), loop cap (default 6).
- **Dry run:** none for iterations (a repo's dry run is for its reviews only). To post nothing, leave `iterationAutoPush` and `iterationReply` off.

### 15.3 Feedback
- **Kinds:** review bodies, inline review comments, replies in threads, and conversation comments.
- **`iterationComments`:**
  - `all`: anyone's, bots included.
  - `mine`: comments under your login, which includes Heron's reviews (they post as you).
  - Only these comments are triaged and listed in the Iteration tab.
- **`iterationAutoStart`:** on, the agent starts on its own after triage. Off (manual), triage runs as usual and the agent waits for **Iterate**.
- Heron's iteration replies carry `<!-- heron:iteration id=<id> -->` and never count. Heron's reviews count like any other comment.
- **Detection:** when the poller sees an eligible PR's `updated_at` change, fetch its conversation and record new comments in `feedback`.
- **No backfill exception:** existing PRs and comments follow the same rules as new ones. Outdated inline comments are included; the agent checks them against the current code.
- **Debounce:** a batch starts `iterationDebounce` after the newest unhandled comment. Each new comment resets it.
- **Handled:** a comment is handled once triage marks it `no-change`, or once it was part of an iteration that ended `pushed`, `no_changes`, `discarded` or `uncommitted`. Handled comments are never triaged or sent again. A new reply in a thread makes that thread unhandled again, and the whole thread is sent.

### 15.4 Triage
- One Agent SDK call: Haiku, effort `low`, no tools, one turn, structured output. It runs in every mode and doesn't take a parallel-run slot.
- **Input** per comment: body, kind, author, and for inline comments `path`/`line`, `diff_hunk` and the thread. Plus the PR title.
- **Output:** `{ verdicts: [{ id, verdict: "change" | "no-change", reason }] }`. `no-change` covers questions, praise, acks and things already done.
- Triage only sets aside comments there's nothing to do for. It doesn't judge whether a finding is right; the agent does.
- Every `change` comment goes to the agent. There's no per-comment picking and no override.
- Nothing to change → the batch ends `skipped`.

### 15.5 Agent run
- **Worktree mode** (default): a separate worktree per PR in `Application Support/Heron/worktrees/iterations/<owner>/<name>/<n>`, independent of the review worktree. Each run checks out the PR head, runs `clean -ffdx`, then the full `setupCommand` if set. Setup failure → `failed` with its output, no retry. Setup time counts toward the timeout.
- **Local checkout mode** (`useLocalCheckout` on): the checkout must be on the PR's head branch, have a clean working tree, and have `HEAD` = the PR's `headSha`. If any check fails → `failed` with the reason. No setup command runs. A failed iteration in this mode offers **Re-run in a worktree**: the re-run (and its re-run if it goes stale) uses Heron's worktree and the setup command, leaving the local checkout alone; the repo setting doesn't change.
- **Context files** go in `Application Support/Heron/iterations/<id>/`, outside the checkout in both modes: `pr.json`, `pr.diff`, `pr-comments.json`, `feedback.json`.
- **User message:** an iteration version of the copy prompt (`ALL_ISSUES` in `core/issue-copy-prompt.ts`, without the sentence about replying in threads and resolving them), then numbered `<violation>` blocks. Inline comments are grouped by `<file>`; review bodies and conversation comments go in a general group.
- **System prompt append:** PR context; where the context files are; "don't commit, push or switch branches — Heron does that"; `gh` is unavailable; when setup ran or in local checkout mode, it may run tests and typecheck, otherwise the reviews' "dependencies are not installed" line; the output contract.
- **SDK options and isolation** as §7.1 and §7.5, with the iteration profile and this output contract:
```ts
{
  commitTitle: string,  // a Conventional Commit header: "type(scope): description"
  items: Array<{ number: number, status: "addressed" | "not_addressed", note: string }>,
}
```

### 15.6 Commit, push, reply
- **Commit** (Heron, never the agent). If the agent committed anyway, soft-reset to the PR head first. Then `git add -A` and one commit with your git identity:
  - title: `commitTitle`, in [Conventional Commits](https://www.conventionalcommits.org) form: `type(scope)!: description`, with `type` one of `fix`, `feat`, `refactor`, `perf`, `test`, `docs`, `style`, `build`, `ci`, `chore`, `revert` (`COMMIT_TYPES`), the scope and `!` optional. The output schema enforces it, so the SDK asks the agent to fix a title that doesn't match.
  - body: a link and the note for each addressed comment
  - trailer: `Heron-Iteration: <id>`
- The commit is also kept on `refs/heron/iterations/<id>` in Heron's clone (fetched from the checkout in local mode), so a reset never loses it.
- **No changes** → `no_changes`: no commit. When there are `not_addressed` inline threads to answer, it goes through `replying` first.
- **Push:** `git push https://github.com/<owner>/<name> <sha>:refs/heads/<headRef>` with the `gh` token (§9), never forced, in both modes. Auto-push on → right away. Off → `ready` until **Push**, **Discard** or, in local checkout mode, **Uncommit** (`git reset --soft` to the PR head on the local checkout, so the changes stay staged for you to finish; Heron pushes and replies nothing).
- **Head moved** (a non-fast-forward rejection, or a new `headSha` while in flight or `ready`) → `stale`. A new iteration with the same comments goes straight to `queued`, with no triage and no click.
- **403 / branch protection** → `failed`, no retry.
- **Replies** (`iterationReply` on): on each addressed inline thread, `Addressed in abc1234 — <note>` with the hidden marker, then resolve the thread (GraphQL `resolveReviewThread`; a thread that's already resolved is left alone). On each `not_addressed` inline thread, `Not addressed — <note>` with the marker, and the thread stays open: a reply from the reviewer reopens it (§15.3) and the agent sees its earlier reason in the thread. Not-addressed replies go out with the addressed ones after the push, or right away when there's no commit; a discarded result posts nothing. An item the agent left out of its output gets no reply. Look for the marker first, so a retry never posts twice. A reply or resolve GitHub refuses (deleted comment, no permission) is logged in Activity and doesn't fail the iteration. No reply for review bodies or conversation comments; those notes stay in the app.
- **Loop cap:** Heron records each SHA it pushes. After `loopCap` Heron pushes in a row with no other push, the PR behaves as manual start until someone else pushes, and the Iteration tab says so. If the PR isn't in the repo's review scope, Heron never reviews the iteration commit, so the loop ends after one push anyway.

### 15.7 States
```
debouncing → triaging ─┬→ skipped                    nothing to change
                       ├→ awaiting_start → queued    manual start or loop cap; you click Iterate
                       ├→ held → queued              another iteration on the PR is in flight or ready
                       └→ queued
queued → preparing → running → committing ─┬→ no_changes
                                            ├→ replying → no_changes        no commit, but threads to answer
                                            ├→ ready ─┬→ pushing (Push)
                                            │         ├→ discarded (Discard)
                                            │         └→ uncommitted (Uncommit; local checkout only)
                                            └→ pushing → replying → pushed
any → failed | stale | cancelled
```
- Per PR, at most one iteration is between `queued` and `ready`. Batches waiting behind it are merged into one run.
- Reviews and iterations on the same PR run independently. An iteration push supersedes a running review (§5).
- Errors and retries as §6.3, recovery as §6.4.

### 15.8 Data model
```
repos      + iteration_auto_start, iteration_comments, iteration_profile_id, iteration_auto_push, iteration_reply, setup_command, local_checkout_path
profiles   + kind ('review' | 'iteration'); one default per kind
prs        + head_repo (fork detection), heron_push_streak (loop cap), feedback_synced_at
iterations(id, pr_id, state, trigger_kind, head_sha, run_after, attempt, retry_step, last_error, pid, session_id,
           profile_snapshot_json, resolved_model, transcript_path, cwd_kind, items_json, output_json, raw_output,
           commit_sha, triage_total, triage_change, merged_into, usage_json, started_at, finished_at, ...)
feedback(id, pr_id, github_id, kind, thread_root_id, author, body, url, path, line, outdated, diff_hunk, review_state,
         created_at, verdict, reason, iteration_id, status /*unhandled|handled|ignored*/, handled_at, observed_at)
activity   + iteration_id; kinds feedback.* and iteration.*
```
A batch that's triaged while another one waits (`held` or `awaiting_start`) is merged into it: its comments move over and it ends `cancelled` with `merged_into` set.

### 15.9 UI
- **Iteration tab** (PR detail):
  - **Feedback**, while a batch is open: each comment with author, location, verdict and reason. With manual start (or after the loop cap), an **Iterate** button, disabled while a result is `ready`.
  - **Latest iteration** that ran the agent: live steps while running. Then the commit title, addressed and not-addressed items with their notes, a unified diff (collapsible files, no syntax highlighting), the commit link, **Push** / **Discard** / **Uncommit** (when `ready`; Uncommit in local checkout mode only) and **Re-run**.
  - On other people's PRs: an empty state, "Iterations only run on PRs you opened".
- **Runs:** separate Reviews and Iterations sections. An iteration row shows state, model, triage result ("4 of 6 to change"), addressed count, duration and commit. Clicking opens it in the Iteration tab. `skipped` batches appear here, never as the latest iteration.
- **Transcript:** unchanged. For an iteration, the triage call(s) then the agent's turns.
- **Activity:** feedback and iteration events next to review events.
- **Sidebar:** a second badge per PR: feedback waiting / running / ready to push / failed.
- **Menu bar:** "N ready to push".
- **Notifications:** feedback waiting (manual start), ready to push and pushed under `notifyPosted`; failed under `notifyFailed`.

---

## 16. Open questions
- **Fork PRs in `all` scope:** review them, or skip by default? (Not decided; untrusted code with full tools.)
- Query layer for SQLite: raw SQL vs Drizzle.

---

## 17. Windows

Heron also runs on Windows, for the same audience as v1 (only me) and with the same features. Only the platform layer differs: tools, processes, shells, paths and window chrome. Linux is out of scope, but nothing here should block it.

### 17.1 Scope
- Windows 10 22H2 and Windows 11, x64. ARM Windows runs the x64 build under emulation; a native arm64 build waits until someone needs it.
- Everything in §1 works the same, including iterations and the setup command.
- An unsigned per-user installer built in CI (§17.9). No auto-update, as on macOS (§13).
- **Not in scope:** Linux, arm64 builds, code signing, Windows Server, a portable build.

### 17.2 Platform code
- **`packages/platform`** (new): the Node-level helpers that differ by OS, each with both implementations side by side. `git`, `harness` and the desktop main process use it and contain no `process.platform` checks of their own. It depends on nothing internal and doesn't import `electron`.
  - `loadEnv()`: the environment tools run with (§17.3). Replaces `loadShellEnv`.
  - `which(bin, env)`: PATH lookup (§17.3).
  - `findClaude(env)`: the `claude` executable (§17.4).
  - `groupSpawnOptions()`: spawn options that let a child and everything it starts be stopped together. `{ detached: true }` on macOS, `{ windowsHide: true }` on Windows.
  - `killTree(pid, signal)`: stop a process and everything it started (§17.5). Moves here from `harness/runner.ts`.
  - `processName(pid)`: what a pid is running, for the orphan check (§17.5).
  - `setupShell(env, gitPath)`: the shell and arguments for the setup command (§17.6).
  - `diskUsage(path)`: `du -sk` on macOS, a directory walk (`lstat`, symlinks not followed) on Windows. Moves here from `git`.
- **`apps/desktop/src/main/platform.ts`**: the Electron differences: window options, tray icons, app menu, login item, notifications (§17.8).
- **Renderer:** the preload sets `data-platform="darwin" | "win32"` on `<html>` (no new API is exposed). CSS and the few labels that differ key off it.

### 17.3 Environment and tools
- **No login-shell probe on Windows.** GUI apps already get the user's full `Path` from the registry. `loadEnv()` starts from `process.env` and drops the same interactive-session variables as on macOS.
- **Path refresh:** Heron's own `process.env` doesn't change when an installer updates `Path`. So each Doctor run (§12) rebuilds `Path` from `HKCU\Environment` and `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` (`reg query`, expanding `%VAR%`), and a tool installed while Heron runs is found without a restart. `%USERPROFILE%\.local\bin` (the native Claude installer's folder) is added if missing. macOS keeps its extra folders (`/opt/homebrew/bin` etc.).
- **Variable names are case-insensitive on Windows**, but a copied env object isn't. `loadEnv()` keeps one key per variable (`Path` stays `Path`; nothing adds a second `PATH`), and `stripEnv` (§7.5) matches names case-insensitively on Windows.
- **PATH** is split and joined with `path.delimiter`.
- **`which`** tries each `PATHEXT` extension in each directory, so `git` resolves to `git.exe` and `gh` to `gh.exe`. There's no `/usr/bin/git` fallback on Windows: a missing git is a Doctor failure.
- **`gh`** keeps its token in Windows Credential Manager. `gh auth token`, the empty `GH_CONFIG_DIR` and the `credential.helper` reset (§7.5) work unchanged; the reset also turns off Git Credential Manager.

### 17.4 Claude Code
- Heron runs the native `claude.exe`: first from `Path`, then from `%USERPROFILE%\.local\bin\claude.exe`.
- **Never a `.cmd`.** cmd.exe re-parses arguments, and they can't be escaped reliably; the Python Agent SDK refuses `.cmd` wrappers for the same reason. npm installs the same native binary as an optional dependency, but puts a `claude.cmd` wrapper on `Path`. When that wrapper is all there is, `findClaude` reads it, takes the quoted `.exe` path it launches, and uses that if it exists. Otherwise the Doctor fails, with the native installer as the fix.
- The agent process is spawned with `groupSpawnOptions()` (§17.2). On Windows that means not `detached`, which would open a console window for it.
- Claude Code's own Bash tool uses Git Bash when it's installed and PowerShell otherwise. Heron doesn't change that.
- Config and skills live in `%USERPROFILE%\.claude`, which `homedir()` already resolves to. `~/.claude/skills` paths (§4) stay as they are.

### 17.5 Processes
- **Stopping:** `killTree` on Windows runs `taskkill /PID <pid> /T /F`. Console processes have no graceful stop, so cancel and timeout kill at once instead of SIGTERM, a 5s wait, then SIGKILL. Recovery is unchanged (§6.4).
- **Orphans** (§6.4): `processName(pid)` uses `tasklist /FI "PID eq <pid>" /FO CSV /NH` on Windows and `ps -p <pid> -o command=` on macOS. Heron kills a leftover pid only when it's still a `claude` process, as now.

### 17.6 Setup command
- **Git Bash first**, found the way Claude Code finds it: `CLAUDE_CODE_GIT_BASH_PATH`, then `%ProgramFiles%\Git\bin\bash.exe` and `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`, then `bin\bash.exe` in the Git install that the `git` on `Path` belongs to (`<root>\cmd\git.exe` → `<root>\bin\bash.exe`). It runs `bash.exe -c <command>`, so a command written on macOS (`pnpm install && pnpm build`) works unchanged.
- **Otherwise PowerShell:** `pwsh.exe -NoProfile -NonInteractive -Command <command>` if `pwsh` is on `Path`, else `powershell.exe` with the same arguments. (Windows PowerShell 5.1 has no `&&`.)
- Settings → Repos shows, under the setup command, which shell it will run in. The Doctor shows it too, as information (§17.8).
- Spawned with `groupSpawnOptions()` and stopped with `killTree`, like the agent.

### 17.7 Data and git
- **Data folder:** `%LOCALAPPDATA%\Heron`, not Electron's default under the roaming `%APPDATA%`. Clones, worktrees and `node_modules` mustn't roam with the user's profile, and the database is no use without them. `HERON_DATA_DIR` still overrides it. The layout inside is the same as on macOS (§9, §15.5).
- **Clone config**, set on every Heron clone on both platforms (no-ops on macOS). Clones that already exist get it on their next `ensureClone`.
  - `core.longpaths=true`: worktree paths start around 80 characters deep, and a setup command's `node_modules` can pass Windows' 260-character limit.
  - `core.autocrlf=false`: Git for Windows installs with `autocrlf=true`, which would check out CRLF and let iteration commits change line endings. With it off, worktrees match the repo byte for byte, and `.gitattributes` still applies. Local checkout mode (§15.5) uses the user's own config.
- **Long paths in Windows itself:** the Doctor warns, without blocking, when `LongPathsEnabled` under `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem` isn't 1. Turning it on needs admin, so the fix text explains how.
- **Agent paths:** on Windows the agent may write `src\auth.ts`. Paths in its output (§7.4) and in step labels (§7.6) are normalized to `/` before they're validated against the diff or shown.
- **Path checks:** `revealPath` tests containment with `path.relative` (case-insensitive on Windows) instead of `startsWith`. `~` expansion in the local checkout path also accepts `~\`.

### 17.8 UI
- **Window:** `titleBarStyle: "hidden"` with `titleBarOverlay`. Windows draws minimize/maximize/close at the top right, 52px tall to match the drag region, in colors that follow light/dark (`setTitleBarOverlay` on `nativeTheme` changes). Windows 11 gets `backgroundMaterial: "mica"` with the sidebar transparent, like vibrancy on macOS. Windows 10 gets solid backgrounds, with the sidebar in its own color token.
- **Layout:** no 84px traffic-light gap in the sidebar. The detail header and the Settings toolbar leave room on the right for the window buttons, using the `titlebar-area-x` / `titlebar-area-width` CSS env variables rather than a fixed width.
- **Menu:** no application menu on Windows (`Menu.setApplicationMenu(null)`), so no File/Edit bar. The renderer handles Ctrl+, for Settings. Dev builds keep reload and devtools on Ctrl+R and Ctrl+Shift+I. Quit is in the tray menu.
- **Labels:** "⌘," becomes "Ctrl+,", "Show in Finder" becomes "Show in Explorer", "this Mac" becomes "this computer".
- **Tray:** colored icons (Windows doesn't recolor template images) in three states: idle, running, paused. Left-click opens the window; right-click shows the §12 menu. The running and ready-to-push counts go in the tooltip, since `setTitle` is macOS-only. While the window is open, its taskbar button shows the running count as an overlay badge (`setOverlayIcon`, with bundled 1–9 and 9+ images).
- **Closing the window** hides it to the tray. The first time, a notification says Heron is still running in the system tray and how to pin the icon so it doesn't sit in the hidden-icons area. It's shown once, remembered in settings.
- **Launch at login** registers with `--hidden`. Started with `--hidden`, Heron runs without showing the window.
- **Notifications:** `app.setAppUserModelId("dev.heron.desktop")` at startup, so toasts are attributed to Heron and clicks reach the app.
- **Doctor:** Windows fix hints are `winget install Git.Git`; `winget install GitHub.cli`, then `gh auth login`; and for Claude, `irm https://claude.ai/install.ps1 | iex` in PowerShell, then `claude` to log in. Two more rows never block the queue: the setup shell (§17.6) and long paths (§17.7). `DoctorCheck` gets `blocking` (default true), the report's `ok` counts only blocking checks, and failed non-blocking checks show as warnings.

### 17.9 Build and distribution
- **electron-builder `win`:** `nsis`, x64, per-user (`oneClick: true`, `perMachine: false`), so installing needs no admin. Unsigned, so SmartScreen warns on first run (More info → Run anyway). The icon comes from `build/icon.png`, which is above the 256px minimum.
- **Scripts:** `dist:win` = `electron-vite build && electron-builder --win --x64`. `dist` stays macOS.
- **Built on Windows only**, by the CI job below. (`better-sqlite3` isn't what ties it to Windows: the version in use (13) carries prebuilds for every platform in its npm package, `win32-x64.node` included, and loads the one for the OS it runs on. With `npmRebuild: false` the package ships them all as they are.)
- **CI:** `.github/workflows/windows.yml` on `windows-latest`, run manually (`workflow_dispatch`) and on `v*` tags: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm dist:win`, then upload the installer as a workflow artifact.
- The `!node_modules/@anthropic-ai/claude-agent-sdk-*/**` exclusion stays; it covers the SDK's Windows binaries too.
- The README gets the Windows requirements and how to get the installer.

### 17.10 Manual test pass
No automated tests, as in §1. Before Windows counts as done, on a Windows 11 VM:
- Install and first run, with every Doctor row green. Then again with Git Bash hidden (setup falls back to PowerShell), and with `LongPathsEnabled` off (a warning; the queue still runs).
- Claude installed by the native installer, then by npm only.
- Add a repo: a review posts, with inline comments on the right lines.
- An iteration in worktree mode with `pnpm install` as the setup command: the commit has no line-ending changes, and the push and replies work.
- Cancel a running review and a running setup command: no `claude.exe`, `node.exe` or `bash.exe` is left behind.
- Quit during a run and reopen: recovery (§6.4) works and no orphan is left.
- Window buttons and Mica in light and dark mode, dragging by the title area, Ctrl+,.
- Tray states, left and right click, the close-to-tray hint shown once, the overlay badge.
- Launch at login starts hidden. A notification click opens its PR.

### 17.11 To check while building
- The exact contents of npm's `claude.cmd`, and where WinGet puts `claude.exe`.
- Whether the Agent SDK puts anything on the command line (system prompt append, output schema, settings) that could approach Windows' 32,767-character limit.
- That `taskkill /T` reaches processes started inside Git Bash (MSYS processes can leave the Windows process tree).
- That `getLoginItemSettings({ args: ["--hidden"] })` reports `openAtLogin` correctly, so the startup sync between `launchAtLogin` and the OS doesn't flip it every launch.
- That Electron 45's `titleBarOverlay`, `backgroundMaterial: "mica"` and the `titlebar-area-*` env variables behave as described in both themes.
- That `better-sqlite3` has a win32-x64 prebuild that loads in Electron 45.
