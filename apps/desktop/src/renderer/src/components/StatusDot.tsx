import type { PrListItem, PrStatus } from "@heron/rpc";
import { GitMerge, GitPullRequestClosed } from "lucide-react";
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

type PrState = PrListItem["state"];

/** The PR's state once it's no longer open, then the review status. */
export function prStatusLabel(state: PrState, status: PrStatus): string {
  if (state === "open") return STATUS_LABEL[status];
  return `${state === "merged" ? "Merged" : "Closed"} · ${STATUS_LABEL[status]}`;
}

/** GitHub's merged/closed icon once a PR is done, the review status dot while it's open. */
export function PrIcon({ state, status, selected = false }: { state: PrState; status: PrStatus; selected?: boolean }) {
  if (state === "merged") return <GitMerge aria-label="Merged" className={cn("size-3 shrink-0", selected ? "text-white" : "text-purple")} />;
  if (state === "closed") return <GitPullRequestClosed aria-label="Closed" className={cn("size-3 shrink-0", selected ? "text-white" : "text-fg-3")} />;
  return <StatusDot status={status} className={cn(selected && "ring-2 ring-white/70")} />;
}
