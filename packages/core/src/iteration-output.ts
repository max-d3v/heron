import { z } from "zod";
import type { IterationOutput, TriageVerdict } from "./types.ts";

// The structured outputs of an iteration (§15.4, §15.5): the triage call's verdicts and
// the agent's report on each numbered item.

/** The Conventional Commits types an iteration's commit title may start with (the commitlint conventional set). */
export const COMMIT_TYPES = ["fix", "feat", "refactor", "perf", "test", "docs", "style", "build", "ci", "chore", "revert"] as const;

/** `type(scope)!: description` on one line, scope and `!` optional (conventionalcommits.org). */
const CONVENTIONAL_TITLE_RE = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([^()\\n]+\\))?!?: [^ \\n].*$`);

export const iterationOutputSchema = z
  .object({
    commitTitle: z
      .string()
      .regex(CONVENTIONAL_TITLE_RE)
      .describe(
        `The commit's title as a Conventional Commit, "type(scope): description": type is one of ${COMMIT_TYPES.join(", ")}; the scope is optional; the description is imperative and lowercase. One line under 72 characters, e.g. "fix(auth): handle empty tokens in parseAuth".`,
      ),
    items: z
      .array(
        z
          .object({
            number: z.number().int().positive().describe("The item's number from the prompt."),
            status: z.enum(["addressed", "not_addressed"]).describe("addressed: you changed the code for it. not_addressed: you didn't (not valid, already done, out of scope)."),
            note: z.string().min(1).describe("One short sentence: what you changed, or why you didn't."),
          })
          .strict(),
      )
      .describe("One entry per numbered item in the prompt."),
  })
  .strict();

export const triageOutputSchema = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            id: z.number().int().describe("The item's id."),
            verdict: z.enum(["change", "no-change"]),
            reason: z.string().describe("A few words on why."),
          })
          .strict(),
      )
      .describe("One verdict per item."),
  })
  .strict();

export interface TriageOutput {
  verdicts: Array<{ id: number; verdict: TriageVerdict; reason: string }>;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export function iterationJsonSchema(): Record<string, unknown> {
  return toJsonSchema(iterationOutputSchema);
}

export function triageJsonSchema(): Record<string, unknown> {
  return toJsonSchema(triageOutputSchema);
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): { ok: true; output: T } | { ok: false; error: string } {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, error: "Output is not valid JSON" };
    }
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, output: parsed.data };
}

export function parseIterationOutput(value: unknown): { ok: true; output: IterationOutput } | { ok: false; error: string } {
  return parseWith(iterationOutputSchema, value);
}

export function parseTriageOutput(value: unknown): { ok: true; output: TriageOutput } | { ok: false; error: string } {
  return parseWith(triageOutputSchema, value);
}

/** The commit trailer that ties a commit to its iteration. */
export function iterationTrailer(iterationId: number): string {
  return `Heron-Iteration: ${iterationId}`;
}

const MARKER_RE = /<!--\s*heron:iteration\s+id=(\d+)\s*-->/;

/** Hidden marker on Heron's replies: they never count as feedback, and a retry finds them instead of posting twice. */
export function iterationMarker(iterationId: number): string {
  return `<!-- heron:iteration id=${iterationId} -->`;
}

export function parseIterationMarker(body: string | null | undefined): { iterationId: number } | null {
  if (!body) return null;
  const m = MARKER_RE.exec(body);
  return m ? { iterationId: Number(m[1]) } : null;
}

export function stripIterationMarker(body: string): string {
  return body.replace(MARKER_RE, "").trimEnd();
}
