import { query, type AccountInfo, type ModelInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { stripEnv } from "./env.ts";

export interface ClaudeProbe {
  account: AccountInfo;
  models: ModelInfo[];
}

/**
 * Start Claude Code just far enough to read its account and model list.
 * The prompt stream never yields, so no model request is made.
 */
export async function probeClaude(claudePath: string, baseEnv: NodeJS.ProcessEnv, ghConfigDir: string, cwd: string): Promise<ClaudeProbe> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), 30_000);
  // A prompt stream that never yields: Claude Code initializes but no request is sent.
  const idle = (): AsyncIterable<SDKUserMessage> => ({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
          ac.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true }),
        ),
    }),
  });
  const q = query({
    prompt: idle(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      abortController: ac,
      settingSources: ["user"],
      persistSession: false,
      env: stripEnv(baseEnv, ghConfigDir, "heron-probe"),
    },
  });
  try {
    const init = await q.initializationResult();
    return { account: init.account, models: init.models };
  } finally {
    clearTimeout(timer);
    ac.abort("done");
    q.return?.(undefined).catch(() => undefined);
  }
}

export type ClaudeLoginCheck = { ok: true } | { ok: false; auth: boolean; message: string };

/**
 * Make one tiny real request (Haiku, no tools, a one-line system prompt). `claude auth status`
 * reports a stored login even when the session has expired and can't be refreshed; only a
 * request tells. A usage limit still counts as logged in.
 */
export async function verifyClaudeLogin(claudePath: string, baseEnv: NodeJS.ProcessEnv, ghConfigDir: string, cwd: string): Promise<ClaudeLoginCheck> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), 60_000);
  let text = "";
  let error: string | null = null;
  try {
    const q = query({
      prompt: "Reply with OK.",
      options: {
        cwd,
        pathToClaudeCodeExecutable: claudePath,
        abortController: ac,
        model: "haiku",
        maxTurns: 1,
        tools: [],
        settingSources: [],
        systemPrompt: "Reply with OK.",
        persistSession: false,
        env: stripEnv(baseEnv, ghConfigDir, "heron-login-check"),
      },
    });
    for await (const msg of q) {
      if (msg.type === "assistant") {
        if (msg.error) error = msg.error;
        for (const b of msg.message.content) if (b.type === "text") text += b.text;
      }
      if (msg.type === "rate_limit_event" && msg.rate_limit_info.status === "rejected") return { ok: true };
      if (msg.type === "result") {
        if (msg.subtype === "success" && !msg.is_error) return { ok: true };
        text ||= msg.subtype === "success" ? msg.result : (msg.errors ?? []).join("; ");
      }
    }
  } catch (err) {
    text ||= err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  if (error === "rate_limit" || /usage limit|rate limit/i.test(text)) return { ok: true };
  const auth = error === "authentication_failed" || /authenticat|log ?in|oauth|expired/i.test(text);
  return { ok: false, auth, message: text.trim() || "Claude Code didn't answer" };
}
