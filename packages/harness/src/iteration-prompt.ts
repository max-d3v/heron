import { COMMIT_TYPES, ITERATION_INSTRUCTIONS, type CwdKind, type FeedbackKind } from "@heron/core";
import type { PrContext } from "./prompt.ts";

// What Heron adds to an iteration's agent run (§15.5) and the triage call (§15.4).

export interface IterationWorkspace {
  /** `worktree`: Heron's iteration worktree of the PR head. `local`: the user's own checkout. */
  kind: CwdKind;
  /** Folder with pr.json, pr.diff, pr-comments.json and feedback.json, outside the checkout. */
  contextDir: string;
  /** The repo's setup command, when it ran before the agent (worktree mode). */
  setupCommand: string | null;
}

/** Shown read-only on an iteration profile's page, in place of a prompt editor. */
export const ITERATION_CONTRACT_SUMMARY = `Iteration profiles have no prompt of their own. Every iteration sends this fixed prompt:

    ${ITERATION_INSTRUCTIONS}

followed by each comment to change as a numbered <violation>: inline threads grouped by <file>, review bodies and conversation comments in a <general> group.

Heron also adds:
• PR context: repository, number, title, description, base/head refs and SHAs.
• The checkout: an iteration worktree reset to the PR head (after the repo's setup command, when set), or your local checkout.
• Rules: don't commit, push or switch branches (Heron does that); gh is unavailable. Tests and type checks only when dependencies are installed (setup command or local checkout).
• Context files outside the checkout: pr.json, pr.diff, pr-comments.json, feedback.json.
• Output contract: the run ends with structured output:
    { "commitTitle": the commit's title as a Conventional Commit, "type(scope): description",
      "items": [{ "number", "status": "addressed" | "not_addressed", "note" }] }
  Heron commits the changes under your git identity (title, then a link and the note for each addressed comment),
  pushes them, replies "Addressed in <sha> — <note>" on each addressed inline thread and resolves it,
  and replies "Not addressed — <note>" on each inline thread the agent left alone (the thread stays open).`;

const OUTPUT_CONTRACT = `## Output contract

When you're done, return structured output with exactly these fields:

- \`commitTitle\` (string): the commit's title, a [Conventional Commit](https://www.conventionalcommits.org) header that sums up your changes: \`type(scope): description\`, one line under 72 characters, e.g. \`fix(auth): handle empty tokens in parseAuth\`.
  - \`type\`: one of ${COMMIT_TYPES.map((t) => `\`${t}\``).join(", ")}. Pick the one for the most significant change: \`fix\` for a bug, \`refactor\` for a change that keeps the behavior, \`test\`/\`docs\`/\`style\` when that's all you touched, \`feat\` for new behavior.
  - \`(scope)\`: optional, the area you changed (a package, module or feature), lowercase. When the repository's history (\`git log\`) uses scopes, use the same ones.
  - \`description\`: imperative, starting lowercase, no trailing period. Add \`!\` before the colon only when the change breaks an API.
- \`items\` (array): one entry per numbered item in the prompt:
  - \`number\`: the item's number.
  - \`status\`: \`"addressed"\` when you changed the code for it, \`"not_addressed"\` when you didn't (it isn't valid, it's already done, or it's out of scope).
  - \`note\`: one short sentence: what you changed, or why you didn't. On an inline comment Heron replies in its thread with "Addressed in <sha> — <note>" or "Not addressed — <note>", so write it for the reviewer, as the PR's author would: for one you didn't address, the reason it doesn't hold or doesn't belong in this PR. Don't mention Heron.`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export function buildIterationSystemPromptAppend(pr: PrContext, ws: IterationWorkspace): string {
  const checkout =
    ws.kind === "local"
      ? `The current directory is the PR author's own checkout, on branch \`${pr.headRef}\` at ${pr.headSha.slice(0, 12)}.`
      : `The current directory is a checkout of the PR head (\`${pr.headRef}\` at ${pr.headSha.slice(0, 12)}, detached HEAD).`;
  const deps =
    ws.kind === "local"
      ? "- This is the author's working checkout, so dependencies should be installed: run the tests, the type checker and linters to check your changes."
      : ws.setupCommand
        ? `- The setup command (\`${ws.setupCommand}\`) ran before you started, so you may run the tests, the type checker and linters to check your changes.`
        : "- Dependencies are not installed. Don't install them, build, or run tests; check your changes by reading the code.";

  return `# Heron: address review feedback

You are working on a GitHub pull request, addressing the review feedback in the prompt on behalf of the PR's author. When you finish, Heron commits your changes on top of the PR branch, pushes them, and replies on each inline thread with what you changed or why you didn't.

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

${checkout}

- Don't commit, push, switch branches or rewrite history. Leave your changes in the working tree: Heron commits and pushes them.
- \`gh\` is unavailable and network git operations fail.
${deps}
- Context files, outside the checkout, in \`${ws.contextDir}\`:
  - \`pr.json\`: PR metadata.
  - \`pr.diff\`: the PR's diff (base…head) before your changes.
  - \`pr-comments.json\`: every review, inline comment, reply and conversation comment on the PR.
  - \`feedback.json\`: the numbered items from the prompt, with their whole threads.

## How to work

- Each item is review feedback. Some may be mistaken, already done, or out of scope: check it against the current code before changing anything, and leave it with a note saying why when it doesn't hold.
- Outdated inline comments point at code that has changed since they were written; find where the concern lives now.
- Keep the changes to what the feedback asks for.

${OUTPUT_CONTRACT}
`;
}

/** One item for triage: an inline thread, a review body or a conversation comment. */
export interface TriageItem {
  id: number;
  kind: FeedbackKind;
  path: string | null;
  line: number | null;
  outdated: boolean;
  diffHunk: string | null;
  reviewState: string | null;
  /** The comment, or the whole thread in order. */
  comments: Array<{ author: string; body: string }>;
}

export const TRIAGE_SYSTEM_PROMPT = `You triage review feedback on a GitHub pull request for its author. For each item, decide whether it asks for a change to the pull request.

- "change": it asks for or suggests a change to the PR's code, tests, docs or config (a bug, a fix, a rename, a refactor, a missing test, a nit, a suggestion block), even if you doubt it's right. Whether it's right is decided later, by the agent that makes the changes.
- "no-change": there is nothing to do: a question that only needs an answer, praise, an acknowledgement ("thanks", "LGTM"), a summary or status message with no request in it, or a thread whose request was withdrawn or already handled (e.g. the author replied that it's done).

Judge a thread as a whole, its latest comments included. When in doubt, choose "change".
Return one verdict for every item id, each with a reason of a few words.`;

const lastLines = (text: string, n: number) => text.split("\n").slice(-n).join("\n");

export function buildTriagePrompt(prTitle: string, items: TriageItem[]): string {
  const blocks = items.map((item) => {
    const attrs = [`id="${item.id}"`, `kind="${item.kind === "inline" ? "inline thread" : item.kind}"`];
    if (item.path) attrs.push(`location="${item.line ? `${item.path}:${item.line}` : item.path}"`);
    if (item.outdated) attrs.push('outdated="true"');
    if (item.reviewState) attrs.push(`state="${item.reviewState}"`);
    const hunk = item.diffHunk ? `<diff_hunk>\n${lastLines(item.diffHunk, 20)}\n</diff_hunk>\n` : "";
    const comments = item.comments.map((c) => `<comment author="${c.author}">\n${truncate(c.body.trim(), 4000)}\n</comment>`).join("\n");
    return `<item ${attrs.join(" ")}>\n${hunk}${comments}\n</item>`;
  });
  return `Pull request: ${prTitle}\n\n${blocks.join("\n\n")}\n`;
}
