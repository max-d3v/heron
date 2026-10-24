// What Heron appends to Claude Code's system prompt for every run (§7.2).

export interface PrContext {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

export interface HeronFiles {
  sinceLastReview: { fromSha: string } | null;
  previousReviewCount: number;
}

/** Shown read-only under the prompt editor, so prompt authors know what's added. */
export const OUTPUT_CONTRACT_SUMMARY = `Heron adds the following to every run. You don't need to repeat it.

• PR context: repository, number, title, description, author, base/head refs and SHAs.
• The checkout is the PR head in a throwaway worktree. Dependencies are not installed, so don't build or run tests.
• Context files in .heron/ (use or ignore them):
    pr.diff                  full diff base…head
    since-last-review.diff   changes since Heron's last review (when the old SHA is an ancestor)
    previous-reviews.json    reviews Heron already posted on this PR
    pr-comments.json         humans' review comments, replies and conversation
    pr.json                  PR metadata
• gh is not available (and network git calls fail), so skills must not rely on !\`gh …\`.
• Output contract: the run must end with structured output that mirrors a GitHub review:
    { "body": markdown,
      "comments": [{ "path", "line", "side"?, "start_line"?, "start_side"?, "body" }] }
  Inline comments must point at lines in the diff; others are moved into the body.
  The review is posted as a plain COMMENT under your GitHub account.`;

const OUTPUT_CONTRACT = `## Output contract

When the review is done, return it as structured output with exactly these fields (no others):

- \`body\` (string, markdown): the review's main text. Any structure (summary, severity, sections) goes in this markdown.
- \`comments\` (array, may be empty): inline comments, each:
  - \`path\`: file path relative to the repository root, exactly as in the diff.
  - \`line\`: a line that is part of the diff. With \`side: "RIGHT"\` (the default) it is the line number in the new file (an added or unchanged line inside a hunk). With \`side: "LEFT"\` it is the line number in the old file (a deleted line).
  - \`start_line\` / \`start_side\` (optional): first line of a multi-line comment; must be in the same hunk and before \`line\`.
  - \`body\`: markdown. A \`\`\`suggestion block proposes a replacement for the commented lines.

Comments on lines outside the diff are moved into the body as \`path:line — text\`. The review is posted on GitHub as a plain comment under the user's own account (no approve or request-changes verdict), so write it as the user would: don't sign it or mention Heron.`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export function buildSystemPromptAppend(pr: PrContext, files: HeronFiles): string {
  const fileLines = [
    "- `.heron/pr.diff`: the full diff base…head (what GitHub shows on the PR).",
    files.sinceLastReview
      ? `- \`.heron/since-last-review.diff\`: what changed since Heron last reviewed this PR at ${files.sinceLastReview.fromSha.slice(0, 12)}.`
      : null,
    `- \`.heron/previous-reviews.json\`: reviews Heron already posted on this PR (${files.previousReviewCount}), with their inline comments and any replies.`,
    "- `.heron/pr-comments.json`: review comments, replies and conversation comments from humans.",
    "- `.heron/pr.json`: PR metadata.",
  ].filter(Boolean);

  return `# Heron: pull request review

You are reviewing a GitHub pull request. Your final structured output is posted to GitHub as a review.

## Pull request

- Repository: ${pr.repo}
- PR: #${pr.number}: ${pr.title}
- Author: @${pr.author}
- Base: \`${pr.baseRef}\` at ${pr.baseSha}
- Head: \`${pr.headRef}\` at ${pr.headSha}
- URL: ${pr.url}

### Description

${truncate(pr.body.trim() || "(no description)", 8000)}

## Workspace

The current directory is a checkout of the PR head (detached at ${pr.headSha.slice(0, 12)}). It is a throwaway worktree: anything you change is discarded and never pushed.

- Dependencies are not installed. Don't install them, build, or run tests; review by reading the code.
- \`gh\` is unavailable and network git operations fail. History is a partial clone, so contents of old commits outside this diff may be missing.
- Context files:
${fileLines.join("\n")}

Focus on what changed. Don't repeat earlier comments (yours or others') unless they still apply and matter.

${OUTPUT_CONTRACT}
`;
}
