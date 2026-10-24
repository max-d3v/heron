// Error classes drive the retry policy (§6.3). Packages throw these; the scheduler
// decides what to do from `classifyError`.

export type ErrorClass = "transient" | "limit" | "permanent" | "auth";

export class HeronError extends Error {
  readonly errorClass: ErrorClass;
  constructor(errorClass: ErrorClass, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeronError";
    this.errorClass = errorClass;
  }
}

export class TransientError extends HeronError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("transient", message, options);
    this.name = "TransientError";
  }
}

export class LimitError extends HeronError {
  /** Epoch ms when the limit resets. */
  readonly resetAt: number;
  readonly source: "github" | "claude";
  constructor(source: "github" | "claude", resetAt: number, message: string, options?: { cause?: unknown }) {
    super("limit", message, options);
    this.name = "LimitError";
    this.source = source;
    this.resetAt = resetAt;
  }
}

export class PermanentError extends HeronError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("permanent", message, options);
    this.name = "PermanentError";
  }
}

export class AuthError extends HeronError {
  readonly source: "github" | "claude";
  constructor(source: "github" | "claude", message: string, options?: { cause?: unknown }) {
    super("auth", message, options);
    this.name = "AuthError";
    this.source = source;
  }
}

/** Output didn't match the schema. Permanent, but the UI shows the raw output with a Re-run button. */
export class OutputParseError extends PermanentError {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "OutputParseError";
    this.raw = raw;
  }
}

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof HeronError) return err.errorClass;
  const code = (err as { code?: string } | null)?.code;
  if (code && ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"].includes(code)) {
    return "transient";
  }
  // Unknown failures are retried: the retry budget is small, and a permanent
  // failure after three attempts is still reported as failed.
  return "transient";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Backoff for transient failures: 30s → 2m → 10m, then give up. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

export function retryDelay(attempt: number): number | null {
  return RETRY_DELAYS_MS[attempt] ?? null;
}
