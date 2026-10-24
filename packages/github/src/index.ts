import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import {
  AuthError,
  LimitError,
  PermanentError,
  TransientError,
  foldCommentsIntoBody,
  parseReviewMarker,
  reviewMarker,
  stripIssueCopyPrompts,
  stripReviewMarker,
  withIssueCopyPrompts,
  type ObservedPr,
  type PrState,
  type ReviewPayload,
} from "@heron/core";

const execFileAsync = promisify(execFile);

/** Read the token `gh` is logged in with (it lives in the Keychain, so ask `gh`). */
export async function ghAuthToken(ghPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ghPath, ["auth", "token", "--hostname", "github.com"], { env, timeout: 15_000 });
    const token = stdout.trim();
    if (!token) throw new Error("empty token");
    return token;
  } catch (err) {
    throw new AuthError("github", "`gh` is not logged in to github.com. Run `gh auth login`.", { cause: err });
  }
}

export interface RepoSummary {
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  pushedAt: number | null;
}

export interface PullDetail extends ObservedPr {
  state: PrState;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PrFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
}

export interface ConversationComment {
  id: number;
  author: string;
  createdAt: string;
  body: string;
  /** Review comments only. */
  path?: string;
  line?: number | null;
  side?: string | null;
  inReplyToId?: number | null;
  reviewId?: number | null;
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED… */
  state?: string;
}

export interface Conversation {
  /** Reviews we posted (carrying the heron marker), with their inline comments and replies. */
  ours: Array<{
    id: number;
    sha: string | null;
    submittedAt: string | null;
    body: string;
    comments: ConversationComment[];
  }>;
  /** Everything else: human reviews, inline comments and replies, and conversation comments. */
  humans: {
    reviews: ConversationComment[];
    reviewComments: ConversationComment[];
    issueComments: ConversationComment[];
  };
}

type HttpErrorLike = { name?: string; status?: number; message?: string; response?: { headers?: Record<string, string | undefined> } };

function isHttpError(err: unknown): err is HttpErrorLike & { status: number } {
  return typeof err === "object" && err !== null && typeof (err as HttpErrorLike).status === "number";
}

/** Map a GitHub API failure to the retry classes of §6.3. */
export function classifyGitHubError(err: unknown, context: string): Error {
  if (isHttpError(err)) {
    const status = err.status;
    const headers = err.response?.headers ?? {};
    const msg = `${context}: GitHub ${status} ${err.message ?? ""}`.trim();
    if (status === 401) return new AuthError("github", "GitHub rejected the token from `gh` (401). Run `gh auth login`.", { cause: err });
    if (status === 403 || status === 429) {
      const retryAfter = headers["retry-after"];
      if (retryAfter) return new LimitError("github", Date.now() + Number(retryAfter) * 1000, "GitHub secondary rate limit", { cause: err });
      if (headers["x-ratelimit-remaining"] === "0") {
        const reset = Number(headers["x-ratelimit-reset"] ?? 0) * 1000 || Date.now() + 60_000;
        return new LimitError("github", reset, "GitHub API rate limit reached", { cause: err });
      }
    }
    if (status >= 500) return new TransientError(msg, { cause: err });
    return new PermanentError(msg, { cause: err });
  }
  return new TransientError(`${context}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
}

const ts = (s: string | null | undefined) => (s ? Date.parse(s) : 0);

// Narrow shapes of the REST payloads we read.
interface ApiPull {
  number: number;
  title: string;
  body?: string | null;
  user?: { login: string; avatar_url?: string } | null;
  draft?: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  html_url: string;
  created_at: string;
  updated_at: string;
  state: string;
  merged_at?: string | null;
  merged?: boolean;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

function toObserved(p: ApiPull): ObservedPr {
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    author: p.user?.login ?? "ghost",
    authorAvatarUrl: p.user?.avatar_url ?? null,
    isDraft: Boolean(p.draft),
    headSha: p.head.sha,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    baseSha: p.base.sha,
    url: p.html_url,
    createdAt: ts(p.created_at),
    updatedAt: ts(p.updated_at),
  };
}

/** GitHub caps a review body at 65 536 characters. */
const MAX_BODY = 65_000;

export interface GitHubClientOptions {
  getToken: () => Promise<string>;
  userAgent?: string;
}

export class GitHubClient {
  private octokit: Octokit | null = null;
  private viewerLogin: string | null = null;

  constructor(private readonly opts: GitHubClientOptions) {}

  private async client(): Promise<Octokit> {
    if (!this.octokit) {
      const token = await this.opts.getToken();
      this.octokit = new Octokit({ auth: token, userAgent: this.opts.userAgent ?? "heron" });
    }
    return this.octokit;
  }

  /** Forget the cached token (re-read from `gh` on next call). */
  resetAuth(): void {
    this.octokit = null;
    this.viewerLogin = null;
  }

  /** Run a call; on 401, re-read the token once (§8) before giving up. */
  private async call<T>(context: string, fn: (o: Octokit) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.client());
    } catch (err) {
      if (isHttpError(err) && err.status === 401) {
        this.resetAuth();
        try {
          return await fn(await this.client());
        } catch (err2) {
          throw classifyGitHubError(err2, context);
        }
      }
      if (err instanceof AuthError) throw err;
      throw classifyGitHubError(err, context);
    }
  }

  async viewer(): Promise<{ login: string; avatarUrl: string | null }> {
    const { data } = await this.call("Get user", (o) => o.rest.users.getAuthenticated());
    this.viewerLogin = data.login;
    return { login: data.login, avatarUrl: data.avatar_url ?? null };
  }

  async viewerLoginCached(): Promise<string> {
    if (this.viewerLogin) return this.viewerLogin;
    return (await this.viewer()).login;
  }

  async listRepos(): Promise<RepoSummary[]> {
    const repos = await this.call("List repos", (o) =>
      o.paginate(o.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
        sort: "pushed",
        affiliation: "owner,collaborator,organization_member",
      }),
    );
    return repos.map((r) => ({
      owner: r.owner.login,
      name: r.name,
      private: r.private,
      description: r.description ?? null,
      pushedAt: r.pushed_at ? ts(r.pushed_at) : null,
    }));
  }

  /**
   * Open PRs, newest activity first. With a stored ETag a `304` means nothing changed
   * (and does not count against the rate limit). A push bumps `updated_at`, so any
   * change moves the PR onto page one and changes its ETag.
   */
  async listOpenPulls(
    owner: string,
    repo: string,
    etag: string | null,
  ): Promise<{ notModified: true } | { notModified: false; etag: string | null; pulls: ObservedPr[] }> {
    const o = await this.client();
    const params = { owner, repo, state: "open" as const, sort: "updated" as const, direction: "desc" as const, per_page: 100 };
    let first;
    try {
      first = await o.rest.pulls.list({ ...params, headers: etag ? { "if-none-match": etag } : {} });
    } catch (err) {
      if (isHttpError(err) && err.status === 304) return { notModified: true };
      if (isHttpError(err) && err.status === 401) {
        this.resetAuth();
        return this.listOpenPulls(owner, repo, null);
      }
      throw classifyGitHubError(err, `List PRs of ${owner}/${repo}`);
    }
    const pulls = (first.data as ApiPull[]).map(toObserved);
    let page = 2;
    let last = first.data.length;
    while (last === 100 && page <= 20) {
      const next = await this.call(`List PRs of ${owner}/${repo}`, (c) => c.rest.pulls.list({ ...params, page }));
      pulls.push(...(next.data as ApiPull[]).map(toObserved));
      last = next.data.length;
      page++;
    }
    return { notModified: false, etag: first.headers.etag ?? null, pulls };
  }

  async getPull(owner: string, repo: string, number: number): Promise<PullDetail> {
    const { data } = await this.call(`Get ${owner}/${repo}#${number}`, (o) => o.rest.pulls.get({ owner, repo, pull_number: number }));
    const p = data as ApiPull;
    const state: PrState = p.state === "open" ? "open" : p.merged || p.merged_at ? "merged" : "closed";
    return {
      ...toObserved(p),
      state,
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      changedFiles: p.changed_files ?? 0,
    };
  }

  /** GitHub's diff of the PR, or null when GitHub won't render it (too large). */
  async getPullDiff(owner: string, repo: string, number: number): Promise<string | null> {
    try {
      const res = await this.call(`Diff of ${owner}/${repo}#${number}`, (o) =>
        o.rest.pulls.get({ owner, repo, pull_number: number, mediaType: { format: "diff" } }),
      );
      return res.data as unknown as string;
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (isHttpError(cause) && (cause.status === 406 || cause.status === 422)) return null;
      throw err;
    }
  }

  async listPullFiles(owner: string, repo: string, number: number): Promise<PrFile[]> {
    const files = await this.call(`Files of ${owner}/${repo}#${number}`, (o) =>
      o.paginate(o.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    );
    return files.map((f) => ({
      path: f.filename,
      previousPath: f.previous_filename ?? null,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
  }

  async getConversation(owner: string, repo: string, number: number): Promise<Conversation> {
    const ctx = `Comments of ${owner}/${repo}#${number}`;
    const [reviews, reviewComments, issueComments] = await Promise.all([
      this.call(ctx, (o) => o.paginate(o.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 })),
      this.call(ctx, (o) => o.paginate(o.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 })),
      this.call(ctx, (o) => o.paginate(o.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 })),
    ]);

    const toComment = (c: (typeof reviewComments)[number]): ConversationComment => ({
      id: c.id,
      author: c.user?.login ?? "ghost",
      createdAt: c.created_at,
      body: stripIssueCopyPrompts(c.body),
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      side: c.side ?? null,
      inReplyToId: c.in_reply_to_id ?? null,
      reviewId: c.pull_request_review_id ?? null,
    });

    const ourReviewIds = new Set<number>();
    const ours: Conversation["ours"] = [];
    const humanReviews: ConversationComment[] = [];
    for (const r of reviews) {
      const marker = parseReviewMarker(r.body);
      if (marker) {
        ourReviewIds.add(r.id);
        ours.push({
          id: r.id,
          sha: marker.sha,
          submittedAt: r.submitted_at ?? null,
          body: stripIssueCopyPrompts(stripReviewMarker(r.body ?? "")),
          comments: [],
        });
      } else if (r.body?.trim()) {
        humanReviews.push({
          id: r.id,
          author: r.user?.login ?? "ghost",
          createdAt: r.submitted_at ?? "",
          body: r.body,
          state: r.state,
        });
      }
    }

    // Our inline comments, plus replies to them, stay with our reviews.
    const ourCommentIds = new Set<number>();
    const humanComments: ConversationComment[] = [];
    for (const c of reviewComments) {
      if (c.pull_request_review_id !== null && c.pull_request_review_id !== undefined && ourReviewIds.has(c.pull_request_review_id) && !c.in_reply_to_id) {
        ourCommentIds.add(c.id);
      }
    }
    for (const c of reviewComments) {
      const parent = c.in_reply_to_id ?? null;
      if (ourCommentIds.has(c.id) || (parent !== null && ourCommentIds.has(parent))) {
        const owner = parent !== null ? reviewComments.find((x) => x.id === parent) : c;
        const review = ours.find((r) => r.id === owner?.pull_request_review_id);
        review?.comments.push(toComment(c));
        if (parent !== null) humanComments.push(toComment(c));
      } else {
        humanComments.push(toComment(c));
      }
    }

    return {
      ours,
      humans: {
        reviews: humanReviews,
        reviewComments: humanComments,
        issueComments: issueComments.map((c) => ({
          id: c.id,
          author: c.user?.login ?? "ghost",
          createdAt: c.created_at,
          body: c.body ?? "",
        })),
      },
    };
  }

  /** Find a review we already posted for this run (idempotent posting after a crash). */
  async findMarkerReview(
    owner: string,
    repo: string,
    number: number,
    sha: string,
    reviewId: number,
  ): Promise<{ id: number; url: string } | null> {
    const reviews = await this.call(`Reviews of ${owner}/${repo}#${number}`, (o) =>
      o.paginate(o.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
    );
    for (const r of reviews) {
      const m = parseReviewMarker(r.body);
      if (m && m.sha === sha && m.reviewId === reviewId) return { id: r.id, url: r.html_url };
    }
    return null;
  }

  /**
   * Post the review as a `COMMENT` (never APPROVE/REQUEST_CHANGES). If GitHub rejects
   * the inline comments (422), post again with them folded into the body.
   */
  async postReview(
    owner: string,
    repo: string,
    number: number,
    headSha: string,
    reviewId: number,
    payload: ReviewPayload,
  ): Promise<{ id: number; url: string; folded: boolean }> {
    const send = async (p: ReviewPayload) => {
      const marker = reviewMarker(headSha, reviewId);
      const posted = withIssueCopyPrompts(p, MAX_BODY);
      let body = posted.body;
      if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n…(truncated)`;
      const { data } = await (await this.client()).rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        commit_id: headSha,
        event: "COMMENT",
        body: `${body}\n\n${marker}`,
        comments: posted.comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side ?? "RIGHT",
          ...(c.start_line !== undefined ? { start_line: c.start_line, start_side: c.start_side ?? c.side ?? "RIGHT" } : {}),
          body: c.body,
        })),
      });
      return { id: data.id, url: data.html_url };
    };

    try {
      return { ...(await send(payload)), folded: false };
    } catch (err) {
      if (isHttpError(err) && err.status === 422 && payload.comments.length > 0) {
        try {
          return { ...(await send(foldCommentsIntoBody(payload))), folded: true };
        } catch (err2) {
          throw classifyGitHubError(err2, "Post review");
        }
      }
      if (isHttpError(err) && err.status === 401) {
        this.resetAuth();
      }
      throw classifyGitHubError(err, "Post review");
    }
  }
}
