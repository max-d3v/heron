import type { PrListItem, PrStatus } from "@heron/rpc";
import { CircleCheck, CircleX, GitMerge, GitPullRequestClosed, MessageCircleDashed, MessageCircleMore, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

export const STATUS_LABEL: Record<PrStatus, string> = {
  not_reviewed: "Not reviewed",
  debouncing: "Waiting for more pushes",
  queued: "Queued",
  running: "Reviewing",
  posted: "Review posted",
  no_issues: "No issues found",
  not_posted: "Dry run · not posted",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

type Outcome = "posted" | "no_issues" | "not_posted" | "failed";

/** Finished outcomes get an icon, like merged and closed PRs; work still to come stays a dot. */
const OUTCOME: Record<Outcome, { Icon: LucideIcon; tone: string }> = {
  posted: { Icon: MessageCircleMore, tone: "text-ok" },
  no_issues: { Icon: CircleCheck, tone: "text-ok" },
  not_posted: { Icon: MessageCircleDashed, tone: "text-ok" },
  failed: { Icon: CircleX, tone: "text-bad" },
};

const isOutcome = (s: PrStatus): s is Outcome => s in OUTCOME;

/** The sidebar's live status: hollow = nothing yet, spinner = running, icons for outcomes. */
export function StatusDot({ status, selected = false }: { status: PrStatus; selected?: boolean }) {
  if (status === "running") {
    // On the selected row's accent background an accent spinner vanishes, so it turns white instead of taking the ring.
    return (
      <span className="relative inline-flex size-[10px] shrink-0" aria-label={STATUS_LABEL[status]}>
        <span className={cn("spin absolute inset-0 rounded-full border-[1.5px] border-t-transparent", selected ? "border-white" : "border-accent")} />
      </span>
    );
  }
  if (isOutcome(status)) {
    const { Icon, tone } = OUTCOME[status];
    return <Icon aria-label={STATUS_LABEL[status]} className={cn("size-3 shrink-0", selected ? "text-white" : tone)} />;
  }
  const style: Record<Exclude<PrStatus, "running" | Outcome>, string> = {
    not_reviewed: "border-[1.5px] border-fg-3",
    debouncing: "border-[1.5px] border-dashed border-warn",
    queued: "bg-warn pulse",
    cancelled: "border-[1.5px] border-fg-3 bg-fg-3/30",
    superseded: "border-[1.5px] border-fg-3",
  };
  return (
    <span aria-label={STATUS_LABEL[status]} className={cn("inline-block size-[9px] shrink-0 rounded-full", style[status], selected && "ring-2 ring-white/70")} />
  );
}

type PrState = PrListItem["state"];

/** The PR's state once it's no longer open, then the review status. */
export function prStatusLabel(state: PrState, status: PrStatus): string {
  if (state === "open") return STATUS_LABEL[status];
  return `${state === "merged" ? "Merged" : "Closed"} · ${STATUS_LABEL[status]}`;
}

/** GitHub's merged/closed icon once a PR is done, the review status while it's open. */
export function PrIcon({ state, status, selected = false }: { state: PrState; status: PrStatus; selected?: boolean }) {
  if (state === "merged") return <GitMerge aria-label="Merged" className={cn("size-3 shrink-0", selected ? "text-white" : "text-purple")} />;
  if (state === "closed") return <GitPullRequestClosed aria-label="Closed" className={cn("size-3 shrink-0", selected ? "text-white" : "text-fg-3")} />;
  return <StatusDot status={status} selected={selected} />;
}
