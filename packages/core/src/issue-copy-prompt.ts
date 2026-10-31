import type { FeedbackKind, ReviewComment, ReviewPayload } from "./types.ts";

// The issue copy prompt: the review's issues restated as a ready-made prompt that the
// PR author copies from GitHub and pastes into their own coding agent to fix them.
// It is appended, collapsed, to the posted review (every issue) and to each inline
// comment (that one issue).
//
// Not to be confused with the prompt Heron gives its reviewing agent (harness/prompt.ts).
// Iterations reuse the format as the agent's prompt (`iterationPrompt`).

/** The collapsible's title on GitHub. */
export const ISSUE_COPY_PROMPT_TITLE = "Prompt for AI agents";

const ALL_ISSUES =
  "Check if these issues are valid — if so, understand the root cause of each and fix them. When an issue isn't valid or won't be fixed in this PR, reply in its thread with the reason and then resolve the thread. If appropriate, use sub-agents to investigate and fix each issue separately.";

/** ALL_ISSUES without the part about replying in threads: in an iteration, Heron replies itself. */
export const ITERATION_INSTRUCTIONS =
  "Check if these issues are valid — if so, understand the root cause of each and fix them. If appropriate, use sub-agents to investigate and fix each issue separately.";

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

/** One numbered item of an iteration's prompt: an inline thread, a review body or a conversation comment. */
export interface FeedbackPromptItem {
  number: number;
  kind: FeedbackKind;
  path: string | null;
  line: number | null;
  outdated: boolean;
  /** The comment, or the whole thread in order. `author` may carry a note, e.g. "max (PR author)". */
  comments: Array<{ author: string; body: string }>;
}

/** Numbering order: inline threads by file and line, then review bodies and conversation comments by time. */
export function orderFeedbackItems<T extends { kind: FeedbackKind; path: string | null; line: number | null; createdAt: number }>(items: T[]): T[] {
  const inline = items
    .filter((i) => i.kind === "inline")
    .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.createdAt - b.createdAt);
  const general = items.filter((i) => i.kind !== "inline").sort((a, b) => a.createdAt - b.createdAt);
  return [...inline, ...general];
}

function feedbackViolation(item: FeedbackPromptItem): string {
  const attrs = [`number="${item.number}"`];
  if (item.path) attrs.push(`location="${item.line ? `${item.path}:${item.line}` : item.path}"`);
  if (item.outdated) attrs.push('outdated="true"');
  if (item.kind !== "inline") attrs.push(`source="${item.kind}"`);
  const text = item.comments.map((c) => `@${c.author}: ${c.body.trim()}`).join("\n\n");
  return `<violation ${attrs.join(" ")}>\n${text}</violation>`;
}

/**
 * The user message of an iteration: the copy prompt's instructions (minus replying in threads),
 * then each item as a `<violation>`: inline threads grouped by `<file>`, review bodies and
 * conversation comments in a `<general>` group.
 */
export function iterationPrompt(items: FeedbackPromptItem[]): string {
  const byFile = new Map<string, FeedbackPromptItem[]>();
  const general: FeedbackPromptItem[] = [];
  for (const item of items) {
    if (item.kind === "inline" && item.path) byFile.set(item.path, [...(byFile.get(item.path) ?? []), item]);
    else general.push(item);
  }
  const sections = [...byFile].map(([path, list]) => `<file name="${path}">\n\n${list.map(feedbackViolation).join("\n\n")}\n</file>`);
  if (general.length > 0) sections.push(`<general>\n\n${general.map(feedbackViolation).join("\n\n")}\n</general>`);
  return `${ITERATION_INSTRUCTIONS}\n\n\n${sections.join("\n\n")}\n`;
}
