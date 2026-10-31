import type { IterationSummary, RunSummary } from "@heron/rpc";
import { ExternalLink } from "lucide-react";
import { cn } from "../../lib/cn";
import { compactNumber, dateTime, duration, shortSha } from "../../lib/format";
import { ITERATION_LABEL, ITERATION_TONE } from "../../lib/iterations";
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

const ITERATION_TRIGGER: Record<IterationSummary["trigger"], string> = { feedback: "Comments", rerun: "Re-run", stale: "PR moved" };

function usageBreakdown(u: NonNullable<RunSummary["usage"]>): string {
  return [
    `Input ${u.input.toLocaleString()}`,
    `Output ${u.output.toLocaleString()}`,
    `Cache read ${u.cacheRead.toLocaleString()}`,
    `Cache write ${u.cacheWrite.toLocaleString()}`,
  ].join(" · ");
}

export function RunsTab({
  runs,
  iterations,
  selectedRunId,
  selectedIterationId,
  onOpenRun,
  onOpenIteration,
}: {
  runs: RunSummary[];
  iterations: IterationSummary[];
  selectedRunId: number | null;
  selectedIterationId: number | null;
  onOpenRun: (id: number) => void;
  onOpenIteration: (id: number) => void;
}) {
  // Batches still waiting (debouncing, triaging, waiting for Iterate, held) show in the Iteration tab, not here.
  const ran = iterations.filter((i) => i.startedAt !== null || i.state === "skipped" || i.state === "failed");
  if (runs.length === 0 && ran.length === 0) return <Empty title="No runs yet" />;
  return (
    <div className="flex flex-col gap-6 px-5 py-4">
      {runs.length > 0 && (
        <section>
          <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-fg-2">Reviews</h2>
          <ReviewRuns runs={runs} selectedId={selectedRunId} onOpen={onOpenRun} />
        </section>
      )}
      {ran.length > 0 && (
        <section>
          <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-fg-2">Iterations</h2>
          <IterationRuns iterations={ran} selectedId={selectedIterationId} onOpen={onOpenIteration} />
        </section>
      )}
    </div>
  );
}

function IterationRuns({ iterations, selectedId, onOpen }: { iterations: IterationSummary[]; selectedId: number | null; onOpen: (id: number) => void }) {
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="text-left text-[11px] font-medium text-fg-2">
          {["Commit", "State", "Trigger", "Model", "Triage", "Addressed", "Started", "Duration", "Tokens"].map((h) => (
            <th key={h} className="border-b border-line px-2 py-1.5 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {iterations.map((i) => (
          <tr
            key={i.id}
            onClick={() => onOpen(i.id)}
            className={cn("border-b border-line hover:bg-hover", i.id === selectedId && "bg-accent-soft hover:bg-accent-soft")}
          >
            <td className="px-2 py-1.5 font-mono text-[11.5px]">{i.commitSha ? shortSha(i.commitSha) : "—"}</td>
            <td className="px-2 py-1.5">
              <Badge tone={ITERATION_TONE[i.state]}>{ITERATION_LABEL[i.state]}</Badge>
            </td>
            <td className="px-2 py-1.5 text-fg-2">{ITERATION_TRIGGER[i.trigger]}</td>
            <td className="max-w-[160px] truncate px-2 py-1.5 text-fg-2">{i.model ?? "—"}</td>
            <td className="whitespace-nowrap px-2 py-1.5 text-fg-2">{i.triageTotal > 0 ? `${i.triageChange} of ${i.triageTotal} to change` : "—"}</td>
            <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-fg-2">{i.addressed !== null && i.itemCount !== null ? `${i.addressed} of ${i.itemCount}` : "—"}</td>
            <td className="whitespace-nowrap px-2 py-1.5 text-fg-2">{dateTime(i.startedAt ?? i.createdAt)}</td>
            <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-fg-2">{i.startedAt && i.finishedAt ? duration(i.finishedAt - i.startedAt) : ""}</td>
            <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-fg-2" title={i.usage ? usageBreakdown(i.usage) : undefined}>
              {i.usage ? compactNumber(i.usage.input + i.usage.output) : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReviewRuns({ runs, selectedId, onOpen }: { runs: RunSummary[]; selectedId: number | null; onOpen: (id: number) => void }) {
  return (
    <div>
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
                {r.state === "completed" && !r.dryRun && <span className="ml-1 text-[10.5px] text-fg-3">no issues</span>}
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
