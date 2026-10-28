# Heron

A highly configurable macOS app that reviews GitHub pull requests with your own Claude subscription.

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
