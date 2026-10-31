import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  AbortError,
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AuthError,
  HeronError,
  LimitError,
  OutputParseError,
  PermanentError,
  TransientError,
  iterationJsonSchema,
  parseTriageOutput,
  reviewJsonSchema,
  triageJsonSchema,
  type AgentStep,
  type EffortLevel,
  type TokenUsage,
  type TriageOutput,
} from "@heron/core";
import { stripEnv } from "./env.ts";
import { TRIAGE_SYSTEM_PROMPT, buildIterationSystemPromptAppend, buildTriagePrompt, type IterationWorkspace, type TriageItem } from "./iteration-prompt.ts";
import { buildSystemPromptAppend, type HeronFiles, type PrContext } from "./prompt.ts";
import { messageToSteps } from "./steps.ts";

export type HarnessEntry =
  | { type: "prompt"; markdown: string }
  /** `command` is what follows the slash: `heron:<name>` for imported skills, `<name>` for linked ones. */
  | { type: "skill"; command: string; skillFile: string };

/** What every run shares: where Claude Code runs and how the caller follows it. */
interface RunBase {
  claudePath: string;
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  ghConfigDir: string;
  timeoutMs: number;
  /** Aborted by the caller on supersede, cancel or quit; its `reason` is passed through. */
  signal: AbortSignal;
  /** JSONL file the raw stream is appended to. */
  transcriptPath: string;
  clientApp: string;
  onStep?: (step: AgentStep) => void;
  onSpawn?: (pid: number) => void;
  onInit?: (info: { sessionId: string; model: string }) => void;
  /** Called once the run reports its totals, failed runs included. */
  onUsage?: (usage: TokenUsage) => void;
}

export interface RunReviewOptions extends RunBase {
  pluginDir: string;
  trustRepoClaudeConfig: boolean;
  entry: HarnessEntry;
  model: string;
  effort: EffortLevel | null;
  maxTurns: number;
  pr: PrContext;
  files: HeronFiles;
}

interface AgentRunOptions extends RunBase {
  /** Names the run in the transcript ("review", "triage", "iteration"). */
  label: string;
  prompt: string;
  systemPrompt: NonNullable<Options["systemPrompt"]>;
  outputSchema: Record<string, unknown>;
  model: string;
  effort: EffortLevel | null;
  maxTurns: number;
  settingSources: NonNullable<Options["settingSources"]>;
  pluginDir?: string;
  /** Built-in tools; Claude Code's defaults when left out. */
  tools?: string[];
  additionalDirectories?: string[];
  /** A skill run's command: fail when Claude Code doesn't know it. */
  skillCommand?: string;
}

export interface RunReviewResult {
  structuredOutput: unknown;
  resultText: string;
  sessionId: string | null;
  model: string | null;
  numTurns: number;
  durationMs: number;
  costUsd: number;
}

/** The run was stopped on purpose (supersede, cancel, quit). Not an error to report. */
export class RunAbortedError extends Error {
  constructor(readonly reason: string) {
    super(`Run aborted: ${reason}`);
    this.name = "RunAbortedError";
  }
}

/** Kill the whole process group, so tools the agent started go too. */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function makeSpawner(onSpawn: (pid: number) => void, onStderr: (text: string) => void) {
  return (o: SpawnOptions): SpawnedProcess => {
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group: abort kills the agent and everything it spawned.
      detached: true,
    });
    const pid = child.pid;
    if (pid) onSpawn(pid);
    child.stderr?.on("data", (d: Buffer) => onStderr(d.toString("utf8")));
    const killGroup = (sig: NodeJS.Signals | number = "SIGTERM") => {
      if (!pid) return false;
      killTree(pid, typeof sig === "number" ? "SIGTERM" : sig);
      return true;
    };
    o.signal.addEventListener(
      "abort",
      () => {
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 5000).unref();
      },
      { once: true },
    );
    child.kill = killGroup as typeof child.kill;
    return child as unknown as SpawnedProcess;
  };
}

function resetAtFrom(value: number | undefined): number | null {
  if (!value) return null;
  // The CLI reports seconds; accept milliseconds too.
  return value < 1e12 ? value * 1000 : value;
}

/** Run one review with the Agent SDK and return its structured output. */
export async function runReview(o: RunReviewOptions): Promise<RunReviewResult> {
  if (o.entry.type === "skill" && !existsSync(o.entry.skillFile)) {
    throw new PermanentError(`Skill file not found: ${o.entry.skillFile}`);
  }
  return runAgent({
    ...o,
    label: "review",
    prompt: o.entry.type === "prompt" ? o.entry.markdown : `/${o.entry.command}`,
    systemPrompt: { type: "preset", preset: "claude_code", append: buildSystemPromptAppend(o.pr, o.files) },
    outputSchema: reviewJsonSchema(),
    settingSources: o.trustRepoClaudeConfig ? ["user", "project"] : ["user"],
    ...(o.entry.type === "skill" ? { skillCommand: o.entry.command } : {}),
  });
}

export interface RunIterationOptions extends RunBase {
  pluginDir: string;
  trustRepoClaudeConfig: boolean;
  model: string;
  effort: EffortLevel | null;
  maxTurns: number;
  /** The user message: the feedback as numbered items (`iterationPrompt`). */
  prompt: string;
  pr: PrContext;
  workspace: IterationWorkspace;
}

/** Run the agent that addresses an iteration's feedback in `cwd` (§15.5). */
export async function runIteration(o: RunIterationOptions): Promise<RunReviewResult> {
  return runAgent({
    ...o,
    label: "iteration",
    systemPrompt: { type: "preset", preset: "claude_code", append: buildIterationSystemPromptAppend(o.pr, o.workspace) },
    outputSchema: iterationJsonSchema(),
    settingSources: o.trustRepoClaudeConfig ? ["user", "project"] : ["user"],
    additionalDirectories: [o.workspace.contextDir],
  });
}

export interface RunTriageOptions extends Omit<RunBase, "timeoutMs"> {
  prTitle: string;
  items: TriageItem[];
}

/** One Haiku call, no tools, one turn: which items ask for a change (§15.4). */
export async function runTriage(o: RunTriageOptions): Promise<TriageOutput> {
  const result = await runAgent({
    ...o,
    label: "triage",
    prompt: buildTriagePrompt(o.prTitle, o.items),
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    outputSchema: triageJsonSchema(),
    model: "haiku",
    effort: "low",
    maxTurns: 1,
    tools: [],
    settingSources: [],
    timeoutMs: 5 * 60_000,
  });
  const parsed = parseTriageOutput(result.structuredOutput);
  if (!parsed.ok) throw new OutputParseError(`Triage output doesn't match its format: ${parsed.error}`, JSON.stringify(result.structuredOutput));
  return parsed.output;
}

/** Run Claude Code once with the Agent SDK and return its structured output. */
async function runAgent(o: AgentRunOptions): Promise<RunReviewResult> {
  await mkdir(dirname(o.transcriptPath), { recursive: true });
  const transcript = createWriteStream(o.transcriptPath, { flags: "a" });
  const log = (entry: unknown) => transcript.write(`${JSON.stringify(entry)}\n`);
  log({ type: "heron", event: "start", run: o.label, ts: Date.now(), model: o.model, effort: o.effort, cwd: o.cwd });

  const ac = new AbortController();
  const onCallerAbort = () => ac.abort(o.signal.reason ?? "aborted");
  if (o.signal.aborted) onCallerAbort();
  else o.signal.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => ac.abort("timeout"), o.timeoutMs);

  let limitResetAt: number | null = null;
  let stderrTail = "";
  let sessionId: string | null = null;
  let model: string | null = null;
  let result: SDKResultMessage | null = null;
  let assistantError: string | null = null;
  let skillChecked = o.skillCommand === undefined;

  const options: Options = {
    cwd: o.cwd,
    pathToClaudeCodeExecutable: o.claudePath,
    model: o.model,
    ...(o.effort ? { effort: o.effort } : {}),
    maxTurns: o.maxTurns,
    abortController: ac,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: o.settingSources,
    ...(o.pluginDir ? { plugins: [{ type: "local", path: o.pluginDir }] } : {}),
    ...(o.tools ? { tools: o.tools } : {}),
    ...(o.additionalDirectories ? { additionalDirectories: o.additionalDirectories } : {}),
    systemPrompt: o.systemPrompt,
    outputFormat: { type: "json_schema", schema: o.outputSchema },
    env: stripEnv(o.baseEnv, o.ghConfigDir, o.clientApp),
    persistSession: false,
    spawnClaudeCodeProcess: makeSpawner(o.onSpawn ?? (() => undefined), (text) => {
      stderrTail = (stderrTail + text).slice(-4000);
      log({ type: "stderr", text });
    }),
  };

  const step = (s: AgentStep) => {
    try {
      o.onStep?.(s);
    } catch {
      // the UI side must never break a run
    }
  };

  try {
    const q = query({ prompt: o.prompt, options });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      log(msg);
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        model = msg.model;
        o.onInit?.({ sessionId: msg.session_id, model: msg.model });
        if (o.skillCommand !== undefined) {
          const command = o.skillCommand;
          // An unknown /name doesn't fail in the SDK, it just becomes a plain prompt.
          if (!msg.slash_commands.includes(command) && !msg.skills.includes(command)) {
            throw new PermanentError(`Skill /${command} isn't available to Claude Code (check the skill's name and SKILL.md).`);
          }
          skillChecked = true;
        }
      }
      if (msg.type === "rate_limit_event" && msg.rate_limit_info.status === "rejected") {
        limitResetAt = resetAtFrom(msg.rate_limit_info.resetsAt) ?? Date.now() + 15 * 60_000;
      }
      if (msg.type === "assistant" && msg.error) assistantError = msg.error;
      if (msg.type === "result") {
        result = msg;
        const models = Object.values(msg.modelUsage);
        if (models.length > 0) {
          o.onUsage?.({
            input: models.reduce((n, m) => n + m.inputTokens, 0),
            output: models.reduce((n, m) => n + m.outputTokens, 0),
            cacheRead: models.reduce((n, m) => n + m.cacheReadInputTokens, 0),
            cacheWrite: models.reduce((n, m) => n + m.cacheCreationInputTokens, 0),
          });
        }
      }
      for (const s of messageToSteps(o.cwd, msg)) step(s);
    }
  } catch (err) {
    if (err instanceof HeronError) {
      // Our own verdict mid-stream (e.g. unknown skill): stop the process too.
      ac.abort("failed");
      throw err;
    }
    if (ac.signal.aborted) {
      const reason = String(ac.signal.reason ?? "aborted");
      if (reason === "timeout") throw new PermanentError(`Timed out after ${Math.round(o.timeoutMs / 60_000)} min`);
      throw new RunAbortedError(reason);
    }
    if (err instanceof AbortError) throw new RunAbortedError("aborted");
    throw classifyFailure(err instanceof Error ? err.message : String(err), assistantError, limitResetAt, stderrTail);
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", onCallerAbort);
    log({ type: "heron", event: "end", ts: Date.now() });
    await new Promise<void>((resolve) => transcript.end(resolve));
  }

  if (!skillChecked) throw new TransientError("Claude Code exited before initializing");
  if (!result) {
    throw classifyFailure("Claude Code exited without a result", assistantError, limitResetAt, stderrTail);
  }

  const r: SDKResultMessage = result;
  if (r.subtype === "success" && !r.is_error) {
    if (r.structured_output === undefined || r.structured_output === null) {
      throw new OutputParseError("The run ended without structured output", r.result ?? "");
    }
    return {
      structuredOutput: r.structured_output,
      resultText: r.result,
      sessionId,
      model,
      numTurns: r.num_turns,
      durationMs: r.duration_ms,
      costUsd: r.total_cost_usd,
    };
  }

  switch (r.subtype) {
    case "error_max_turns":
      throw new PermanentError(`Hit the turn limit (${o.maxTurns}) before finishing`);
    case "error_max_structured_output_retries":
      throw new OutputParseError(`Claude couldn't produce output matching the ${o.label} schema`, "");
    case "success": {
      const text = r.result ?? "";
      if (r.api_error_status === 429 || /usage limit|rate limit/i.test(text)) {
        throw new LimitError("claude", limitResetAt ?? parseResetFromText(text) ?? Date.now() + 15 * 60_000, text || "Claude usage limit reached");
      }
      throw classifyFailure(text || "Claude Code reported an error", assistantError, limitResetAt, stderrTail);
    }
    default:
      throw classifyFailure((r.errors ?? []).join("; ") || `Claude Code failed (${r.subtype})`, assistantError, limitResetAt, stderrTail);
  }
}

function parseResetFromText(text: string): number | null {
  const m = /\|(\d{9,13})/.exec(text);
  return m ? resetAtFrom(Number(m[1])) : null;
}

function classifyFailure(message: string, assistantError: string | null, limitResetAt: number | null, stderr: string): Error {
  const detail = stderr.trim() ? `${message}\n${stderr.trim().split("\n").slice(-5).join("\n")}` : message;
  if (limitResetAt || assistantError === "rate_limit") {
    return new LimitError("claude", limitResetAt ?? Date.now() + 15 * 60_000, "Claude usage limit reached");
  }
  if (assistantError === "authentication_failed" || assistantError === "oauth_org_not_allowed" || /not logged in|please run \/login|invalid api key|authentication/i.test(detail)) {
    return new AuthError("claude", "Claude Code is not logged in. Run `claude` and log in.");
  }
  if (assistantError === "billing_error" || assistantError === "account_on_hold") {
    return new PermanentError(`Claude account problem (${assistantError})`);
  }
  if (assistantError === "model_not_found" || assistantError === "invalid_request") {
    return new PermanentError(detail);
  }
  return new TransientError(detail);
}

/** Default location of a linked skill. */
export function linkedSkillDir(name: string): string {
  return join(homedir(), ".claude", "skills", name);
}
