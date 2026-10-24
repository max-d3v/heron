import type { QueueStatusDto } from "@heron/rpc";
import { useMutation } from "@tanstack/react-query";
import { Pause, TriangleAlert } from "lucide-react";
import { orpc } from "../lib/rpc";
import { Button } from "./ui";

/** Shown above the detail view while the queue is paused for a reason other than the user. */
export function Banner({ queue, onOpenSetup }: { queue: QueueStatusDto | null; onOpenSetup: () => void }) {
  const resume = useMutation(orpc.queue.resume.mutationOptions());
  if (!queue?.paused) return null;
  const problem = queue.reasons.includes("auth") || queue.reasons.includes("doctor");
  const limit = queue.reasons.includes("limit");
  const manualOnly = queue.reasons.length === 1 && queue.reasons[0] === "manual";
  return (
    <div
      className={
        problem
          ? "flex shrink-0 items-center gap-2.5 border-b border-line bg-[color-mix(in_srgb,var(--red)_9%,var(--content))] px-5 py-2"
          : "flex shrink-0 items-center gap-2.5 border-b border-line bg-[color-mix(in_srgb,var(--orange)_10%,var(--content))] px-5 py-2"
      }
    >
      {problem ? <TriangleAlert className="size-4 shrink-0 text-bad" /> : <Pause className="size-4 shrink-0 text-warn" />}
      <div className="min-w-0 flex-1 text-[12.5px]">
        <span className="font-medium">{problem ? "Reviews are on hold" : limit ? "Usage limit reached" : "Reviews are paused"}</span>
        {queue.message && !manualOnly && <span className="text-fg-2"> · {queue.message}</span>}
      </div>
      {problem && (
        <Button size="sm" onClick={onOpenSetup}>
          Fix setup…
        </Button>
      )}
      {(manualOnly || limit) && (
        <Button size="sm" busy={resume.isPending} onClick={() => resume.mutate({})}>
          {limit ? "Resume now" : "Resume"}
        </Button>
      )}
    </div>
  );
}
