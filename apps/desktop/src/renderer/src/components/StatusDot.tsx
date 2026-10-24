import type { PrStatus } from "@heron/rpc";
import { cn } from "../lib/cn";

export const STATUS_LABEL: Record<PrStatus, string> = {
  not_reviewed: "Not reviewed",
  debouncing: "Waiting for more pushes",
  queued: "Queued",
  running: "Reviewing",
  posted: "Review posted",
  completed: "Reviewed (dry run)",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

/** The sidebar's live status: hollow = nothing yet, spinner = running, colours for outcomes. */
export function StatusDot({ status, className }: { status: PrStatus; className?: string }) {
  if (status === "running") {
    return (
      <span className={cn("relative inline-flex size-[10px] shrink-0", className)} aria-label={STATUS_LABEL[status]}>
        <span className="spin absolute inset-0 rounded-full border-[1.5px] border-accent border-t-transparent" />
      </span>
    );
  }
  const style: Record<Exclude<PrStatus, "running">, string> = {
    not_reviewed: "border-[1.5px] border-fg-3",
    debouncing: "border-[1.5px] border-dashed border-warn",
    queued: "bg-warn pulse",
    posted: "bg-ok",
    completed: "bg-teal",
    failed: "bg-bad",
    cancelled: "border-[1.5px] border-fg-3 bg-fg-3/30",
    superseded: "border-[1.5px] border-fg-3",
  };
  return <span aria-label={STATUS_LABEL[status]} className={cn("inline-block size-[9px] shrink-0 rounded-full", style[status], className)} />;
}
