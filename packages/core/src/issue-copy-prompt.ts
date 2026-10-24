import type { ReviewComment, ReviewPayload } from "./types.ts";

// The issue copy prompt: the review's issues restated as a ready-made prompt that the
// PR author copies from GitHub and pastes into their own coding agent to fix them.
// It is appended, collapsed, to the posted review (every issue) and to each inline
// comment (that one issue).
//
// Not to be confused with the prompt Heron gives its reviewing agent (harness/prompt.ts).

/** The collapsible's title on GitHub. */
export const ISSUE_COPY_PROMPT_TITLE = "Prompt for AI agents";

const ALL_ISSUES =
  "Check if these issues are valid — if so, understand the root cause of each and fix them. When an issue isn't valid or won't be fixed in this PR, reply in its thread with the reason and then resolve the thread. If appropriate, use sub-agents to investigate and fix each issue separately.";

const ONE_ISSUE =
  "Check if this issue is valid — if so, understand the root cause and fix it. If it isn't valid or won't be fixed in this PR, reply in this thread with the reason and then resolve the thread.";

function location(c: ReviewComment): string {
  return c.start_line !== undefined && c.start_line < c.line ? `${c.path}:${c.start_line}-${c.line}` : `${c.path}:${c.line}`;
}

/** The copy prompt text: the instructions, then each issue as a `<violation>` grouped by `<file>`. */
export function issueCopyPrompt(comments: ReviewComment[], single = false): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  let n = 0;
  const files = [...byFile].map(([path, list]) => {
    const violations = list.map((c) => `<violation number="${++n}" location="${location(c)}">\n${c.body.trim()}</violation>`);
    return `<file name="${path}">\n\n${violations.join("\n\n")}\n</file>`;
  });
  return `${single ? ONE_ISSUE : ALL_ISSUES}\n\n\n${files.join("\n\n")}\n`;
}

/**
 * A collapsed `<details>` holding the text in a fenced block (GitHub adds a copy
 * button). The fence is longer than any backtick run inside, so ```suggestion
 * blocks in a comment can't close it early.
 */
export function collapsibleCopyBlock(title: string, text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `<details>\n<summary>${title}</summary>\n\n${fence}text\n${text}\n${fence}\n\n</details>`;
}

/**
 * The texts that get posted: the body gains a copy prompt covering every issue (inline
 * and moved-to-body), each inline comment one covering itself. A section is left out
 * when it would push the text past `maxLength` (GitHub's limit).
 */
export function withIssueCopyPrompts(payload: ReviewPayload, maxLength: number): { body: string; comments: ReviewComment[] } {
  const inline: ReviewComment[] = payload.comments.map(({ context: _context, ...c }) => c);
  const all = [...inline, ...payload.movedToBody];
  let body = payload.body.trim();
  if (all.length > 0) {
    const section = collapsibleCopyBlock(ISSUE_COPY_PROMPT_TITLE, issueCopyPrompt(all));
    const joined = body ? `${body}\n\n${section}` : section;
    if (joined.length <= maxLength) body = joined;
  }
  const comments = inline.map((c) => {
    const joined = `${c.body.trim()}\n\n${collapsibleCopyBlock(ISSUE_COPY_PROMPT_TITLE, issueCopyPrompt([c], true))}`;
    return joined.length <= maxLength ? { ...c, body: joined } : c;
  });
  return { body, comments };
}

const SECTION_RE = new RegExp(`\\n*<details>\\n<summary>${ISSUE_COPY_PROMPT_TITLE}</summary>[\\s\\S]*?\\n</details>`, "g");

/** Remove the copy prompt sections again (when feeding earlier reviews back to the reviewing agent). */
export function stripIssueCopyPrompts(text: string): string {
  return text.replace(SECTION_RE, "").trimEnd();
}
