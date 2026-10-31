import type { IterationSummary, RunSummary, TranscriptEntry } from "@heron/rpc";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderOpen } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { isInFlightIteration } from "../../lib/iterations";
import { shortSha } from "../../lib/format";
import { client, errorText, orpc } from "../../lib/rpc";
import { isInFlightRun } from "../PrDetail";
import { Button, Empty, ErrorNote, Spinner } from "../ui";

const TYPE_TONE: Record<string, string> = {
  assistant: "text-accent",
  user: "text-purple",
  result: "text-ok",
  stderr: "text-bad",
};

export type TranscriptTarget = { kind: "review"; run: RunSummary } | { kind: "iteration"; iteration: IterationSummary };

/** The raw transcript of the run the Review or Iteration tab shows. For an iteration: its triage call(s), then the agent's turns. */
export function TranscriptTab({ target }: { target: TranscriptTarget | null }) {
  const review = target?.kind === "review" ? target.run : null;
  const iteration = target?.kind === "iteration" ? target.iteration : null;
  const live = review ? isInFlightRun(review) : iteration ? isInFlightIteration(iteration) || iteration.state === "triaging" : false;
  const reviewQ = useQuery({
    ...orpc.reviews.transcript.queryOptions({ input: { id: review?.id ?? -1 } }),
    enabled: review !== null,
    refetchInterval: live ? 3000 : false,
  });
  const iterationQ = useQuery({
    ...orpc.iterations.transcript.queryOptions({ input: { id: iteration?.id ?? -1 } }),
    enabled: iteration !== null,
    refetchInterval: live ? 3000 : false,
  });
  const reviewDetail = useQuery({ ...orpc.reviews.get.queryOptions({ input: { id: review?.id ?? -1 } }), enabled: review !== null });
  const iterationDetail = useQuery({ ...orpc.iterations.get.queryOptions({ input: { id: iteration?.id ?? -1 } }), enabled: iteration !== null });
  const q = review ? reviewQ : iterationQ;

  if (!target) return <Empty title="No run selected" />;
  if (q.isPending) {
    return (
      <div className="flex justify-center pt-16">
        <Spinner />
      </div>
    );
  }
  if (q.isError) return <div className="p-5"><ErrorNote>{errorText(q.error)}</ErrorNote></div>;
  if (q.data.entries.length === 0) return <Empty title="No transcript for this run">The agent hasn't started, or this run never reached it.</Empty>;

  const path = review ? reviewDetail.data?.transcriptPath : iterationDetail.data?.transcriptPath;
  return (
    <div className="px-5 py-4">
      <div className="mb-2 flex items-center justify-between text-[11.5px] text-fg-2">
        <span>
          {review ? `Review of ${shortSha(review.headSha)}` : `Iteration ${iteration!.id}`} · {q.data.entries.length} messages
          {q.data.truncated ? " (first 3000 shown)" : ""}
          {live ? " · live" : ""}
        </span>
        {path && (
          <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => void client.app.revealPath({ path })}>
            Show in Finder
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-[8px] bg-content shadow-[0_0_0_0.5px_var(--line-strong)]">
        {q.data.entries.map((e) => (
          <Entry key={e.index} entry={e} />
        ))}
      </div>
    </div>
  );
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false);
  const pretty = open ? safePretty(entry.raw) : "";
  return (
    <div className="border-b border-line last:border-b-0">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-[5px] text-left hover:bg-hover">
        <ChevronRight className={cn("size-3 shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
        <span className={cn("w-[120px] shrink-0 truncate font-mono text-[11px]", TYPE_TONE[entry.type.split(":")[0]!] ?? "text-fg-2")}>{entry.type}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2">{entry.summary}</span>
      </button>
      {open && <pre className="selectable max-h-[480px] overflow-auto bg-content-2 px-4 py-2 font-mono text-[11px] leading-[1.5]">{pretty}</pre>}
    </div>
  );
}

function safePretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
