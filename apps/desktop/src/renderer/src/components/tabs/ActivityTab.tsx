import type { ActivityDto } from "@heron/rpc";
import {
  Ban,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  Eye,
  GitCommitHorizontal,
  GitPullRequest,
  ListChecks,
  MessageSquareText,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { dateTime } from "../../lib/format";
import { useStream } from "../../lib/hooks";
import { client } from "../../lib/rpc";
import { Empty, Spinner } from "../ui";

function icon(a: ActivityDto) {
  const cls = "size-3.5";
  switch (a.kind) {
    case "pr.observed":
      return <GitPullRequest className={cn(cls, "text-ok")} />;
    case "pr.head_changed":
      return <GitCommitHorizontal className={cls} />;
    case "pr.draft_changed":
      return <Eye className={cls} />;
    case "pr.closed":
      return <CircleX className={cn(cls, "text-purple")} />;
    case "pr.reopened":
      return <RotateCw className={cls} />;
    case "review.created":
      return <Clock className={cn(cls, "text-warn")} />;
    case "review.retry":
      return <RefreshCw className={cn(cls, "text-warn")} />;
    case "review.error":
      return <TriangleAlert className={cn(cls, "text-bad")} />;
    case "review.posted":
      return <CircleCheck className={cn(cls, "text-ok")} />;
    case "queue.paused":
      return <Pause className={cls} />;
    case "queue.resumed":
      return <Play className={cls} />;
    case "review.state": {
      const to = a.data?.to;
      if (to === "posted" || to === "completed") return <CircleCheck className={cn(cls, "text-ok")} />;
      if (to === "failed") return <CircleX className={cn(cls, "text-bad")} />;
      if (to === "cancelled" || to === "superseded") return <Ban className={cls} />;
      return <CircleDot className={cn(cls, "text-accent")} />;
    }
    case "feedback.observed":
      return <MessageSquareText className={cls} />;
    case "feedback.triaged":
      return <ListChecks className={cls} />;
    case "iteration.created":
      return <Clock className={cn(cls, "text-warn")} />;
    case "iteration.retry":
      return <RefreshCw className={cn(cls, "text-warn")} />;
    case "iteration.error":
      return <TriangleAlert className={cn(cls, "text-bad")} />;
    case "iteration.state": {
      const to = a.data?.to;
      if (to === "pushed") return <GitCommitHorizontal className={cn(cls, "text-ok")} />;
      if (to === "ready") return <CircleCheck className={cn(cls, "text-purple")} />;
      if (to === "failed") return <CircleX className={cn(cls, "text-bad")} />;
      if (to === "cancelled" || to === "stale" || to === "discarded" || to === "uncommitted" || to === "skipped" || to === "no_changes") return <Ban className={cls} />;
      return <CircleDot className={cn(cls, "text-accent")} />;
    }
    default:
      return <CircleDot className={cls} />;
  }
}

export function ActivityTab({ prId }: { prId: number }) {
  const { items, error } = useStream<ActivityDto>(`activity:${prId}`, (signal) => client.reviews.activity({ prId }, { signal }));
  const ordered = useMemo(() => [...items].reverse(), [items]);

  if (error) return <Empty title="Couldn't load activity" />;
  if (items.length === 0) {
    return (
      <div className="flex justify-center pt-16">
        <Spinner />
      </div>
    );
  }
  return (
    <ol className="mx-auto max-w-[900px] px-5 py-4">
      {ordered.map((a, i) => (
        <li key={a.id} className="relative flex gap-3 pb-3">
          {i < ordered.length - 1 && <span className="absolute left-[11px] top-[24px] h-[calc(100%-22px)] w-px bg-line" />}
          <span className="flex size-[23px] shrink-0 items-center justify-center rounded-full bg-content-2 text-fg-2 shadow-[0_0_0_0.5px_var(--line)]">
            {icon(a)}
          </span>
          <div className="min-w-0 flex-1 pt-[3px]">
            <div className="selectable text-[12.5px] leading-[1.4]">{a.message}</div>
            <div className="mt-0.5 text-[11px] text-fg-3">
              {dateTime(a.ts)}
              {a.reviewId ? ` · review ${a.reviewId}` : a.iterationId ? ` · iteration ${a.iterationId}` : ""}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
