# Heron

A highly configurable macOS app that reviews GitHub pull requests with your own Claude subscription. Now with [iterations](#iterations-let-claude-address-the-feedback)!

<!-- TODO: demo video. Drag the .mp4 into this file on github.com to get an embed link, then paste it here. -->


https://github.com/user-attachments/assets/6c38713a-68e7-4abe-ae0a-b169fc9feacf





## How it works

1. Heron checks your chosen repos on GitHub every 10 seconds.
2. When a pull request is opened or pushed to, Heron checks it out on your Mac and runs Claude Code on it.
3. Claude's review is posted to the pull request as comments from your GitHub account.

A burst of pushes gets one review: Heron waits 5 seconds after each push before starting. Pushing again during a review cancels it and reviews the new commit.

## Get started

### 1. Install the tools Heron uses

- `git`
- `gh`, logged in: `gh auth login`
- `claude`, logged in: run `claude`, then `/login`

On launch, Heron checks all three and shows how to fix anything missing. Reviews don't start until they all pass.

### 2. Build and open the app

Needs Node 22+ and pnpm 11.

```bash
pnpm install
pnpm dist           # → apps/desktop/dist/Heron-<version>-arm64.dmg
```

The build is unsigned, so the first time you open it, right-click the app → Open.

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

## Iterations: let Claude address the feedback

**Heron can also fix your pull requests, not just review them.** When someone comments on a PR you opened, whether a teammate, a bot or Heron's own review, Heron sorts out which comments ask for a change, has Claude make those changes in its own copy of the repo, and commits them for you. You read the diff in the app and click **Push**. Heron then replies on each thread with what was done and resolves the ones that were addressed.

### Off by default, and careful when on

Iterations are **off** for every repo. Turn them on per repo in Settings → **Repos** → **Iteration**.

Turning them on doesn't let Heron change your branch on its own. With the default settings it only reads the comments and sorts them. Everything after that waits for you:

- **Automatic iteration** is **Manual**: comments wait for you to click **Iterate** in the PR's **Iteration** tab. Switch it to **Automatic** to have Claude start as soon as new comments are sorted.
- **Push automatically** is off: the commit waits in the app until you click **Push** or **Discard**. Turn it on to push as soon as Claude is done.

Set both to automatic and Heron handles feedback from start to finish: comments come in, the fix is pushed and the threads are answered, with no clicks.

### How an iteration works

1. Heron watches the comments on your open pull requests: review summaries, inline comments, replies in threads and conversation comments.
2. 30 seconds after the newest comment, a quick Haiku call sets aside the ones that don't ask for a change: questions, praise, thanks, things already done.
3. The rest go to Claude in one prompt, on a fresh checkout of the PR. Claude checks each comment, fixes the valid ones and notes why it left any alone. It doesn't commit or push.
4. Heron commits the changes under your git identity, with a [Conventional Commits](https://www.conventionalcommits.org) title and a note for each comment addressed.
5. Once it's pushed, Heron replies on each inline thread: `Addressed in abc1234 — <note>`, then resolves it, or `Not addressed — <reason>`, which stays open so the reviewer can answer. If Claude changed nothing, the "Not addressed" replies go out right away.

A new reply on a thread that was already handled, such as a reviewer answering a "Not addressed", sends the thread through again with its full history.

### Settings

In Settings → **Repos** → **Iteration**:

- **Comments to iterate on**: **All comments** (anyone's, bots included) or **My comments** (only yours, which includes Heron's reviews since they post as you).
- **Profile**: the model, effort, timeout and max turns, set in Settings → **Profiles**. Iteration profiles use a fixed prompt. The default is Opus at high effort.
- **Replies**: on by default. Turn it off to keep Claude's notes in the app only.
- **Setup command**: for example `pnpm install`, run before each iteration in Heron's copy of the repo. With it, Claude can run tests and type checks. Without it, dependencies aren't installed. It isn't used with **Local checkout**, where your clone is expected to be set up already.
- **Local checkout**: by default Claude works in Heron's own copy of the repo, and your clone is never touched. Turn this on to use your own clone instead. It has to be on the PR's branch, at its latest commit, with no uncommitted changes. In this mode **Uncommit** takes Heron's commit back off and leaves the changes staged for you to finish.

In Settings → **General**: parallel iterations (2), the wait after the last comment (30 seconds) and the loop cap (6).

### Good to know about iterations

- They only run on pull requests you opened from a branch in the same repo. Forks and other people's PRs are never changed.
- Heron never force-pushes. If the branch moves while Claude is working, the result is dropped and the same comments run again on the new commit.
- When Heron also reviews your PRs, each push gets a new review, which can lead to another iteration. After 6 Heron pushes in a row with no other push (the loop cap), the PR waits for **Iterate** until someone else pushes.
- Iterations have no dry run. To post nothing to GitHub, leave **Push automatically** and **Replies** off.
- With **All comments**, anyone who can comment on your PR can tell Claude what to change, and Claude runs with full tools on your Mac. Check the diff before you push, or use **My comments**.

## Good to know

- Reviews are posted as you, as a plain comment review (never approve or request changes).
- Claude runs with full tools on the pull request's code on your Mac. Be careful with **All PRs** on repos where people you don't know can open pull requests.
- Closing the window keeps Heron running in the menu bar. Quitting stops all reviews; they resume on the next launch.
- Data lives in `~/Library/Application Support/Heron`.

## Develop

```bash
pnpm install
pnpm dev            # electron-vite dev server with HMR
pnpm typecheck      # all packages (turbo)
pnpm lint
```

Set `HERON_DATA_DIR=/some/dir` to run against a separate copy of the data.
