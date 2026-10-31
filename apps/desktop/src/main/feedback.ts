import { stripIterationMarker, type Feedback, type FeedbackKind } from "@heron/core";

/**
 * A unit of feedback: an inline thread, a review body or a conversation comment. Triage
 * gives one verdict per group, and the agent gets one numbered item per group. A new reply
 * reopens its whole thread, so the thread is always sent in full as context.
 */
export interface FeedbackGroup {
  key: string;
  kind: FeedbackKind;
  threadRootId: number;
  /** The rows this group stands for in a batch. */
  rows: Feedback[];
  /** Every comment of the thread, whatever its status, oldest first. */
  thread: Feedback[];
  path: string | null;
  line: number | null;
  outdated: boolean;
  diffHunk: string | null;
  reviewState: string | null;
  url: string | null;
  /** When the thread started (orders groups for numbering). */
  createdAt: number;
}

export const groupKey = (f: Feedback) => `${f.kind}:${f.threadRootId}`;

/** Group `rows` by thread; `all` (the PR's every feedback row) supplies each thread's context. */
export function groupFeedback(rows: Feedback[], all: Feedback[]): FeedbackGroup[] {
  const byKey = new Map<string, Feedback[]>();
  for (const r of rows) byKey.set(groupKey(r), [...(byKey.get(groupKey(r)) ?? []), r]);
  return [...byKey].map(([key, members]) => {
    const thread = all.filter((f) => groupKey(f) === key).sort((a, b) => a.createdAt - b.createdAt || a.githubId - b.githubId);
    const root = thread.find((f) => f.githubId === f.threadRootId) ?? thread[0] ?? members[0]!;
    return {
      key,
      kind: root.kind,
      threadRootId: root.threadRootId,
      rows: members,
      thread: thread.length > 0 ? thread : members,
      path: root.path,
      line: root.line,
      outdated: root.outdated,
      diffHunk: root.diffHunk,
      reviewState: root.reviewState,
      url: root.url,
      createdAt: root.createdAt,
    };
  });
}

/** How a comment's author shows in prompts: the PR's author and Heron's own replies are marked. */
export function authorLabel(f: Feedback, prAuthor: string): string {
  if (f.status === "ignored") return `${f.author} (Heron, an earlier iteration)`;
  if (f.author.toLowerCase() === prAuthor.toLowerCase()) return `${f.author} (PR author)`;
  return f.author;
}

export function threadForPrompt(group: FeedbackGroup, prAuthor: string): Array<{ author: string; body: string }> {
  return group.thread.map((f) => ({ author: authorLabel(f, prAuthor), body: stripIterationMarker(f.body) }));
}
