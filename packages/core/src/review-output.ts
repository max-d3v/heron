import { z } from "zod";
import type { ReviewOutput } from "./types.ts";

// The output contract (§7.4): it mirrors GitHub's review payload and has no extra
// fields. Any structure (severity, sections, …) lives in the markdown itself.

const side = z.enum(["LEFT", "RIGHT"]);

export const reviewCommentSchema = z
  .object({
    path: z.string().min(1).describe("File path relative to the repository root, as it appears in the diff."),
    line: z
      .number()
      .int()
      .positive()
      .describe("Line number in the file. For RIGHT, the line in the new version; for LEFT, in the old version."),
    side: side.optional().describe("RIGHT (default) comments on added/context lines; LEFT on deleted lines."),
    start_line: z.number().int().positive().optional().describe("First line of a multi-line comment."),
    start_side: side.optional().describe("Side of start_line."),
    body: z.string().min(1).describe("Markdown. ```suggestion blocks are allowed."),
  })
  .strict();

export const reviewOutputSchema = z
  .object({
    body: z.string().describe("The review's main body, in markdown."),
    comments: z.array(reviewCommentSchema).describe("Inline comments on lines in the diff. May be empty."),
  })
  .strict();

export type ReviewOutputParsed = z.infer<typeof reviewOutputSchema>;

/** JSON Schema handed to the Agent SDK's `outputFormat`. */
export function reviewJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(reviewOutputSchema, { target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function parseReviewOutput(value: unknown): { ok: true; output: ReviewOutput } | { ok: false; error: string } {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, error: "Output is not valid JSON" };
    }
  }
  const parsed = reviewOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  return { ok: true, output: parsed.data };
}

const MARKER_RE = /<!--\s*heron:review\s+sha=([0-9a-f]{7,64})\s+id=(\d+)\s*-->/;

export function reviewMarker(headSha: string, reviewId: number): string {
  return `<!-- heron:review sha=${headSha} id=${reviewId} -->`;
}

export function parseReviewMarker(body: string | null | undefined): { sha: string; reviewId: number } | null {
  if (!body) return null;
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  return { sha: m[1]!, reviewId: Number(m[2]) };
}

export function stripReviewMarker(body: string): string {
  return body.replace(MARKER_RE, "").trimEnd();
}
