# Heron

Run automatic code reviews on your GitHub pull requests using your Claude Code subscription. A highly configurable app for macOS and Windows, now with [iterations](#iterations-review-fix-repeat): Claude reviews, fixes and repeats.

[![Download for macOS](https://img.shields.io/badge/Download_for_macOS-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/max-d3v/heron/releases/latest/download/Heron-mac-arm64.dmg)
[![Download for Windows](https://img.shields.io/badge/Download_for_Windows-0078D4?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMGgxMS40djExLjRIMHptMTIuNiAwSDI0djExLjRIMTIuNnpNMCAxMi42aDExLjRWMjRIMHptMTIuNiAwSDI0VjI0SDEyLjZ6Ii8%2BPC9zdmc%2B)](https://github.com/max-d3v/heron/releases/latest/download/Heron-windows-x64-setup.exe)

macOS on Apple silicon · Windows 10 or 11, x64 · [All releases](https://github.com/max-d3v/heron/releases) · [First open](#2-download-and-open-the-app)

<!-- TODO: demo video. Drag the .mp4 into this file on github.com to get an embed link, then paste it here. -->


https://github.com/user-attachments/assets/6c38713a-68e7-4abe-ae0a-b169fc9feacf





## How it works

1. Heron checks your chosen repos on GitHub every 10 seconds.
2. When a pull request is opened or pushed to, Heron checks it out on your computer and runs Claude Code on it.
3. Claude's review is posted to the pull request as comments from your GitHub account.

A burst of pushes gets one review: Heron waits 5 seconds after each push before starting. Pushing again during a review cancels it and reviews the new commit.

## Get started

### 1. Install the tools Heron uses

- `git`
- `gh`, logged in: `gh auth login`
- `claude`, logged in: run `claude`, then `/login`

On launch, Heron checks all three and shows how to fix anything missing. Reviews don't start until they all pass.

On Windows:

- `git`: `winget install Git.Git`. Git for Windows also brings Git Bash, which runs the [setup command](#settings) (PowerShell without it).
- `gh`: `winget install GitHub.cli`, then `gh auth login`.
- `claude`: the native installer, in PowerShell: `irm https://claude.ai/install.ps1 | iex`, then run `claude` to log in. Heron runs `claude.exe` itself, never npm's `claude.cmd` wrapper.
- Optional: turn on long paths (`LongPathsEnabled`, needs admin) if a setup command's `node_modules` gets deep. The Doctor shows the command.

### 2. Download and open the app

**macOS** (Apple silicon): [download the `.dmg`](https://github.com/max-d3v/heron/releases/latest/download/Heron-mac-arm64.dmg), open it and drag Heron to Applications. Heron isn't notarized yet, so macOS blocks the first open: click **Done**, then go to System Settings → **Privacy & Security** and click **Open Anyway**.

**Windows** 10 22H2 or 11, x64 (ARM PCs run it under emulation): [download the installer](https://github.com/max-d3v/heron/releases/latest/download/Heron-windows-x64-setup.exe) and run it. It installs for your user only, with no admin prompt. It's unsigned, so SmartScreen warns the first time: More info → Run anyway.

**Updates:** Heron checks for a new version every few hours and downloads it in the background.

- **Windows:** the update installs the next time you quit Heron. To install it now, choose **Restart to Update** at the bottom of the sidebar or in the tray menu.
- **macOS:** choose **Install Update** at the bottom of the sidebar or in the menu bar menu. Heron opens the new `.dmg` and quits. Drag Heron to Applications and choose **Replace**. There's no Open Anyway step this time.

Settings → General shows the update status and has **Check for Updates**. A copy installed before Heron could update itself needs one more manual download.

Older versions are on the [Releases page](https://github.com/max-d3v/heron/releases). To build the app yourself, see [Develop](#develop).

### 3. Add a repository

Settings (⚙ at the bottom of the sidebar) → **Repos** → add one, then choose what to review:

- **All PRs**: every pull request in the repo.
- **Only mine**: pull requests you opened.
- **Manual**: only the pull requests you pick.

Drafts are skipped unless you turn them on.

Pull requests that were already open when you added the repo aren't reviewed automatically. Open one and click **Review now**.

### 4. Pick how it reviews (optional)

The **Default** profile is ready to use: the bundled `pr-review` skill on Opus at high effort. To change it, go to Settings → **Profiles**. A profile is either a prompt or a skill, plus the model, effort, timeout and max turns. Each repo can use its own profile.

### 5. Try a dry run (optional)

Settings → **General** → **Dry run** runs reviews but keeps them in the app instead of posting to GitHub. Useful while you tune a profile.

## The review skill

Heron comes with a `pr-review` skill, and the Default profile uses it. **We highly recommend it.** It looks for bugs, questionable decisions and code smells, and leaves one short comment on the lines each problem concerns. You can read and edit it in Settings → **Skills**.

If you write your own skill or prompt, prioritize finding concrete bugs and keep each correction short and to the point. Big reviews tend to be ignored or taken less seriously.

Heron gives every review the PR details, the diff and earlier comments (in a `.heron/` folder in the checkout), and tells Claude how to format the output. `gh` isn't available during a review, so skills shouldn't rely on it.

## Iterations: review, fix, repeat

**Claude can fix your pull requests, not just review them.** Turn on reviews and iterations for the same repo and they feed each other: Claude reviews your push, fixes what it found, and Heron pushes the fix so Claude reviews it again.

```mermaid
flowchart LR
  push([You push]) --> review[Claude reviews]
  review -->|comments| fix[Claude fixes them]
  fix -->|Heron pushes| review
  review -->|nothing left to fix| done([Ready for a human])
```

Each lap checks the last fix, so the PR gets cleaner until the review has nothing left to ask for. Comments from teammates and bots join the same loop. After 6 Heron pushes in a row with no push from anyone else (the loop cap), the PR stops and waits for you to click **Iterate**.

### Turning it on

Iterations are **off** for every repo. Turn them on in Settings → **Repos** → **Iteration**. With the defaults, Claude only sorts the comments: you click **Iterate** to have it fix them and **Push** to send its commit, after reading the diff in the app. Set **Automatic iteration** to **Automatic** and turn on **Push automatically** to let the loop run with no clicks.

### One lap

1. 30 seconds after the newest comment, a quick Haiku call sets aside the ones that don't ask for a change (questions, praise, things already done).
2. Claude gets the rest in one prompt on a fresh checkout of the PR, fixes the valid ones and notes why it left any alone.
3. Claude's changes are committed as you, under the [Conventional Commits](https://www.conventionalcommits.org) title it wrote. Once pushed, each thread gets Claude's note: `Addressed in abc1234 — <note>` and resolved, or `Not addressed — <reason>` and left open. A reply on a handled thread sends it through again.

### Settings

Per repo, in Settings → **Repos** → **Iteration**:

- **Comments to iterate on**: **All comments**, or **My comments** (yours, which includes Claude's reviews, since they post as you).
- **Profile**: model, effort, timeout and max turns. Default is Opus at high effort.
- **Replies**: on by default. Turn off to keep Claude's notes in the app.
- **Setup command**: e.g. `pnpm install`, so Claude can run tests and type checks.
- **Local checkout**: work in your own clone instead of Heron's copy. It must be on the PR's branch, at its latest commit, with no uncommitted changes.

Settings → **General** has parallel iterations (2), the wait after the last comment (30 seconds) and the loop cap (6).

### Good to know about iterations

- Only pull requests you opened from a branch in the same repo. Forks and other people's PRs are never changed.
- Heron never force-pushes. If the branch moves mid-run, the result is dropped and the comments run again on the new commit.
- No dry run: to post nothing, leave **Push automatically** and **Replies** off.
- To stop iterations on one PR, say while you work on its branch, click **Pause** in its Iteration tab. Comments are still sorted, but nothing runs or pushes on its own until you click **Resume**. A run that's already going finishes and waits for **Push**. **Cancel** pauses the PR too, so a cancelled iteration doesn't start again on the next comment.
- With **All comments**, anyone who can comment on your PR can steer Claude, which runs with full tools on your computer. Check the diff before you push, or use **My comments**.

## Good to know

- Reviews are posted as you, as a plain comment review (never approve or request changes).
- Claude runs with full tools on the pull request's code on your computer. Be careful with **All PRs** on repos where people you don't know can open pull requests.
- Closing the window keeps Heron running in the menu bar (the system tray on Windows). Quitting stops all reviews; they resume on the next launch.
- Data lives in `~/Library/Application Support/Heron` (`%LOCALAPPDATA%\Heron` on Windows).

## Develop

Needs Node 22+ and pnpm 11.

```bash
pnpm install
pnpm dev            # electron-vite dev server with HMR
pnpm typecheck      # all packages (turbo)
pnpm lint
```

Set `HERON_DATA_DIR=/some/dir` to run against a separate copy of the data.

### Build the installers

- **macOS** (Apple silicon): `pnpm dist` → `apps/desktop/dist/Heron-mac-arm64.dmg`, plus its update feed `latest-mac.yml`.
- **Windows**: built on Windows by GitHub Actions. Run the **Release** workflow (Actions → Release → Run workflow) and download `heron-windows-installer` from the run's artifacts. On a Windows machine you can also run `pnpm dist:win`.

### Releases

Releases are automatic, with [semantic-release](https://semantic-release.gitbook.io). On every push to `main`, the **Release** workflow reads the commit titles since the last release ([Conventional Commits](https://www.conventionalcommits.org)) and picks the next version:

- `fix:` or `perf:` → patch (1.0.**1**)
- `feat:` → minor (1.**1**.0)
- `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer → major (**2**.0.0)
- anything else (`docs:`, `refactor:`, `build:`, `chore:`, merge commits) → no release

When there's a new version, it builds both installers with it, tags the commit `v<version>` and publishes a GitHub release with the installers, their update feeds and the changes. The download buttons always point to the newest release, and installed copies pick it up at their next check.

The version lives in the tags, not in the code: `apps/desktop/package.json` stays at `0.0.0-development`, and CI stamps the release version into each build. With squash merges, the PR title becomes the commit title, so it needs the same format.

If a build fails, re-run the workflow on `main` (Actions → Release → Run workflow). If the `release` job fails after it pushed the `v<version>` tag, a re-run finds nothing new to release: delete the tag and any draft release it left first (`git push --delete origin v<version>`).
