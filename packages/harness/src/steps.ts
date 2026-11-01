import { relative, isAbsolute, sep } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentStep } from "@heron/core";

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** A path as labels show it: relative to the checkout when inside it, with `/` on every platform (§17.7). */
function rel(cwd: string, p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  if (!isAbsolute(p)) return slashes(p);
  const r = relative(cwd, p);
  return slashes(r.startsWith("..") ? p : r || ".");
}

/** On Windows the agent writes, and `relative` returns, `src\auth.ts`. A no-op on macOS. */
const slashes = (p: string) => p.split(sep).join("/");

function toolStep(cwd: string, name: string, input: Record<string, unknown>): AgentStep {
  switch (name) {
    case "Read":
      return { kind: "read", label: `Reading ${rel(cwd, input.file_path)}` };
    case "Grep": {
      const where = input.path ? ` in ${rel(cwd, input.path)}` : input.glob ? ` in ${String(input.glob)}` : "";
      return { kind: "search", label: `Searching "${clip(String(input.pattern ?? ""), 60)}"${where}` };
    }
    case "Glob":
      return { kind: "search", label: `Finding ${clip(String(input.pattern ?? ""), 80)}` };
    case "LS":
      return { kind: "read", label: `Listing ${rel(cwd, input.path)}` };
    case "Bash":
      return { kind: "bash", label: `Running ${clip(String(input.command ?? ""), 100)}`, detail: String(input.command ?? "") };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { kind: "edit", label: `Editing ${rel(cwd, input.file_path ?? input.notebook_path)}` };
    case "WebFetch":
      return { kind: "web", label: `Fetching ${clip(String(input.url ?? ""), 80)}` };
    case "WebSearch":
      return { kind: "web", label: `Searching the web for "${clip(String(input.query ?? ""), 60)}"` };
    case "Task":
    case "Agent":
      return { kind: "task", label: `Delegating: ${clip(String(input.description ?? input.prompt ?? "subagent"), 80)}` };
    case "Skill":
      return { kind: "skill", label: `Using skill ${String(input.skill ?? input.command ?? "")}` };
    case "TodoWrite":
      return { kind: "plan", label: "Updating plan" };
    case "StructuredOutput":
      return { kind: "output", label: "Writing the result…" };
    default:
      if (name.startsWith("mcp__")) return { kind: "other", label: `Calling ${name.slice(5).replace("__", ": ")}` };
      return { kind: "other", label: name };
  }
}

/** Turn one SDK message into zero or more human-readable steps for the live UI. */
export function messageToSteps(cwd: string, msg: SDKMessage): AgentStep[] {
  switch (msg.type) {
    case "assistant": {
      const nested = msg.parent_tool_use_id ? "↳ " : "";
      const steps: AgentStep[] = [];
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          const s = toolStep(cwd, block.name, (block.input ?? {}) as Record<string, unknown>);
          steps.push({ ...s, label: nested + s.label });
        } else if (block.type === "text" && block.text.trim()) {
          steps.push({ kind: "text", label: nested + clip(block.text, 160), detail: block.text });
        }
      }
      return steps;
    }
    case "system":
      if (msg.subtype === "init") return [{ kind: "system", label: `Started ${msg.model}` }];
      if (msg.subtype === "api_retry") {
        return [{ kind: "system", label: `API error${msg.error_status ? ` ${msg.error_status}` : ""}, retrying (${msg.attempt}/${msg.max_retries})` }];
      }
      if (msg.subtype === "compact_boundary") return [{ kind: "system", label: "Compacted the conversation" }];
      return [];
    case "rate_limit_event":
      if (msg.rate_limit_info.status === "allowed_warning") return [{ kind: "system", label: "Approaching the Claude usage limit" }];
      if (msg.rate_limit_info.status === "rejected") return [{ kind: "system", label: "Claude usage limit reached" }];
      return [];
    default:
      return [];
  }
}
