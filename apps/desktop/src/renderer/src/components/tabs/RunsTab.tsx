import type { RunSummary } from "@heron/rpc";
import { ExternalLink } from "lucide-react";
import { cn } from "../../lib/cn";
import { compactNumber, dateTime, duration, shortSha } from "../../lib/format";
import { client } from "../../lib/rpc";
import { Badge, Empty } from "../ui";

const TONE: Record<RunSummary["state"], "gray" | "green" | "red" | "orange" | "blue" | "teal"> = {
  debouncing: "orange",
  queued: "orange",
  preparing: "blue",
  running: "blue",
  validating: "blue",
  posting: "blue",
  posted: "green",
  completed: "teal",
  failed: "red",
  superseded: "gray",
  cancelled: "gray",
};

const TRIGGER: Record<RunSummary["trigger"], string> = { auto: "Push", manual: "Review now", rerun: "Re-run" };

function usageBreakdown(u: NonNullable<RunSummary["usage"]>): string {
  return [
    `Input ${u.input.toLocaleString()}`,
    `Output ${u.output.toLocaleString()}`,
    `Cache read ${u.cacheRead.toLocaleString()}`,
    `Cache write ${u.cacheWrite.toLocaleString()}`,
  ].join(" · ");
}

export function RunsTab({ runs, selectedId, onOpen }: { runs: RunSummary[]; selectedId: number | null; onOpen: (id: number) => void }) {
  if (runs.length === 0) return <Empty title="No runs yet" />;
  return (
    <div className="px-5 py-4">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-left text-[11px] font-medium text-fg-2">
            {["Commit", "State", "Trigger", "Profile", "Model", "Effort", "Started", "Duration", "Tokens", ""].map((h) => (
              <th key={h} className="border-b border-line px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpen(r.id)}
              className={cn("border-b border-line hover:bg-hover", r.id === selectedId && "bg-accent-soft hover:bg-accent-soft")}
            >
              <td className="px-2 py-1.5 font-mono text-[11.5px]">{shortSha(r.headSha)}</td>
              <td className="px-2 py-1.5">
                <Badge tone={TONE[r.state]}>{r.state}</Badge>
                {r.dryRun && <span className="ml-1 text-[10.5px] text-fg-3">dry run</span>}
              </td>
              <td className="px-2 py-1.5 text-fg-2">{TRIGGER[r.trigger]}</td>
              <td className="px-2 py-1.5">{r.profileName ?? "—"}</td>
              <td className="max-w-[160px] truncate px-2 py-1.5 text-fg-2">{r.model ?? "—"}</td>
              <td className="px-2 py-1.5 text-fg-2">{r.effort ?? "—"}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-fg-2">{dateTime(r.startedAt ?? r.createdAt)}</td>
              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-fg-2">
                {r.startedAt && r.finishedAt ? duration(r.finishedAt - r.startedAt) : ""}
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-fg-2" title={r.usage ? usageBreakdown(r.usage) : undefined}>
                {r.usage ? compactNumber(r.usage.input + r.usage.output) : ""}
              </td>
              <td className="px-2 py-1.5 text-right">
                {r.githubReviewUrl && (
                  <button
                    aria-label="Open review on GitHub"
                    className="text-fg-3 hover:text-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      void client.app.openExternal({ url: r.githubReviewUrl! });
                    }}
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.some((r) => r.state === "failed") && (
        <div className="mt-3 text-[11.5px] text-fg-3">Open a failed run to see its error and output; Re-run is in the header.</div>
      )}
    </div>
  );
}
