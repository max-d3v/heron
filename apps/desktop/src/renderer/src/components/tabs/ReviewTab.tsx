import type { AgentStepEvent, PrDetail, ReviewDetail, RunSummary } from "@heron/rpc";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  FilePen,
  Globe,
  ListChecks,
  MessageSquare,
  Search,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { ago, clockTime, duration, plural, relativeTime, shortSha } from "../../lib/format";
import { useNow, useStream } from "../../lib/hooks";
import { client, errorText, orpc } from "../../lib/rpc";
import { Markdown } from "../Markdown";
import { isActiveRun, isInFlightRun } from "../PrDetail";
import { Badge, Empty, ErrorNote, Spinner } from "../ui";

const STATE_TEXT: Record<string, string> = {
  debouncing: "Waiting for more pushes",
  queued: "Queued",
  preparing: "Preparing the checkout",
  running: "Claude is reviewing",
  validating: "Validating the output",
  posting: "Posting to GitHub",
};

export function ReviewTab({ pr, run }: { pr: PrDetail; run: RunSummary | null }) {
  const pending = pr.runs.find((r) => isActiveRun(r) && r.id !== run?.id) ?? null;
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4 px-5 py-4">
      {pending && <PendingCard run={pending} />}
      {!run ? (
        <div className="pt-16">
          <Empty icon={<Sparkles className="size-7" />} title="Not reviewed yet">
            {pr.state === "open"
              ? pr.inScope
                ? "The next push to this PR is reviewed automatically. Use Review now to review the current head."
                : "This PR is outside the repo's scope. Use Review now to review it anyway."
              : "This PR is closed."}
          </Empty>
        </div>
      ) : isInFlightRun(run) ? (
        <LiveRun run={run} />
      ) : run.state === "debouncing" || run.state === "queued" ? (
        pending ? null : <PendingCard run={run} />
      ) : (
        <FinishedRun run={run} />
      )}
    </div>
  );
}

function PendingCard({ run }: { run: RunSummary }) {
  const now = useNow(5_000);
  const when = run.runAfter && run.runAfter > now ? relativeTime(run.runAfter, now) : null;
  if (isInFlightRun(run)) return <LiveRun run={run} />;
  return (
    <div className="flex items-center gap-3 rounded-[10px] bg-content-2 px-4 py-3 shadow-[0_0_0_0.5px_var(--line)]">
      <Clock className="size-4 text-warn" />
      <div className="min-w-0 flex-1 text-[12.5px]">
        <span className="font-medium">{STATE_TEXT[run.state] ?? run.state}</span>
        <span className="text-fg-2">
          {" "}
          · {shortSha(run.headSha)}
          {when && run.state === "debouncing" && ` · starts ${when}`}
          {when && run.state === "queued" && run.attempt > 0 && ` · retry ${when}`}
          {when && run.state === "queued" && run.attempt === 0 && ` · waits until ${new Date(run.runAfter!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
        </span>
        {run.lastError && <div className="mt-0.5 truncate text-[11.5px] text-fg-2">Last error: {run.lastError}</div>}
      </div>
    </div>
  );
}

function stepIcon(kind: AgentStepEvent["step"]["kind"]) {
  const cls = "size-3.5 shrink-0";
  switch (kind) {
    case "read":
      return <FileText className={cls} />;
    case "search":
      return <Search className={cls} />;
    case "bash":
      return <SquareTerminal className={cls} />;
    case "edit":
      return <FilePen className={cls} />;
    case "web":
      return <Globe className={cls} />;
    case "task":
      return <Bot className={cls} />;
    case "skill":
      return <Sparkles className={cls} />;
    case "plan":
      return <ListChecks className={cls} />;
    case "text":
      return <MessageSquare className={cls} />;
    case "output":
      return <FilePen className={cls} />;
    case "system":
      return <Wrench className={cls} />;
    default:
      return <Wrench className={cls} />;
  }
}

function StepList({ steps, live }: { steps: AgentStepEvent[]; live?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) end.current?.scrollIntoView({ block: "nearest" });
  }, [steps.length, live]);
  return (
    <div className="max-h-[420px] overflow-y-auto rounded-[8px] bg-content-2 py-1 shadow-[0_0_0_0.5px_var(--line)]">
      {steps.map((s, i) => (
        <div
          key={s.id}
          title={s.step.detail}
          className={cn(
            "flex items-start gap-2 px-3 py-[3px] text-[12px]",
            s.step.kind === "text" ? "text-fg" : "text-fg-2",
            live && i === steps.length - 1 && "text-fg",
          )}
        >
          <span className="mt-[2px] text-fg-3">{stepIcon(s.step.kind)}</span>
          <span className={cn("min-w-0 flex-1", s.step.kind === "text" ? "line-clamp-3" : "truncate", s.step.kind === "bash" && "font-mono text-[11.5px]")}>
            {s.step.label}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-fg-3">{clockTime(s.ts)}</span>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function LiveRun({ run }: { run: RunSummary }) {
  const now = useNow(1_000);
  const { items: steps } = useStream<AgentStepEvent>(`steps:${run.id}`, (signal) => client.reviews.agentSteps({ reviewId: run.id }, { signal }));
  const last = steps[steps.length - 1];
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Spinner className="text-accent" />
        <div className="text-[13px] font-medium">{STATE_TEXT[run.state] ?? run.state}</div>
        <div className="text-[12px] text-fg-2">
          {shortSha(run.headSha)} · {run.profileName} · {run.model}
          {run.effort ? ` · ${run.effort}` : ""}
          {run.dryRun ? " · dry run" : ""}
        </div>
        <div className="ml-auto font-mono text-[11.5px] tabular-nums text-fg-2">{run.startedAt ? duration(now - run.startedAt) : ""}</div>
      </div>
      {run.attempt > 0 && <div className="text-[11.5px] text-fg-2">Attempt {run.attempt + 1}. Last error: {run.lastError}</div>}
      {steps.length > 0 ? (
        <StepList steps={steps} live />
      ) : (
        <div className="rounded-[8px] bg-content-2 px-3 py-3 text-[12px] text-fg-2 shadow-[0_0_0_0.5px_var(--line)]">
          {run.state === "preparing" ? "Fetching the PR and checking out the head commit…" : "Waiting for the agent…"}
        </div>
      )}
      {last && <div className="sr-only">{last.step.label}</div>}
    </section>
  );
}

function FinishedRun({ run }: { run: RunSummary }) {
  const detail = useQuery(orpc.reviews.get.queryOptions({ input: { id: run.id } }));
  const steps = useQuery(orpc.reviews.steps.queryOptions({ input: { id: run.id } }));
  const [showSteps, setShowSteps] = useState(false);

  if (detail.isPending) return <Spinner />;
  if (detail.isError) return <ErrorNote>{errorText(detail.error)}</ErrorNote>;
  const r = detail.data;

  return (
    <div className="flex flex-col gap-4">
      <RunMeta run={r} />

      {r.state === "failed" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2 rounded-[10px] bg-[color-mix(in_srgb,var(--red)_9%,transparent)] px-4 py-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" />
            <div className="selectable min-w-0 whitespace-pre-wrap text-[12.5px] text-fg">{r.lastError ?? "Failed"}</div>
          </div>
          {r.rawOutput && !r.payload && (
            <details className="rounded-[8px] bg-content-2 shadow-[0_0_0_0.5px_var(--line)]" open>
              <summary className="px-3 py-2 text-[12px] font-medium text-fg-2">Raw output</summary>
              <pre className="max-h-[400px] overflow-auto border-t border-line px-3 py-2 font-mono text-[11.5px] leading-[1.5]">{r.rawOutput}</pre>
            </details>
          )}
        </div>
      )}

      {(r.state === "cancelled" || r.state === "superseded") && !r.payload && (
        <div className="text-[12.5px] text-fg-2">{r.state === "superseded" ? "Superseded by a newer push before it finished." : "Cancelled before it finished."}</div>
      )}

      {r.payload && <ReviewBody review={r} />}

      {steps.data && steps.data.length > 0 && (
        <div>
          <button className="flex items-center gap-1 text-[12px] font-medium text-fg-2 hover:text-fg" onClick={() => setShowSteps((v) => !v)}>
            <ChevronRight className={cn("size-3.5 transition-transform", showSteps && "rotate-90")} />
            {plural(steps.data.length, "agent step")}
          </button>
          {showSteps && (
            <div className="mt-2">
              <StepList steps={steps.data} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunMeta({ run }: { run: ReviewDetail }) {
  const now = useNow(30_000);
  const label =
    run.state === "posted" ? "Posted" : run.state === "completed" ? "Completed" : run.state === "failed" ? "Failed" : run.state === "cancelled" ? "Cancelled" : "Superseded";
  const tone = run.state === "posted" ? "green" : run.state === "completed" ? "teal" : run.state === "failed" ? "red" : "gray";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-2">
      <Badge tone={tone}>{label}</Badge>
      {run.dryRun && <Badge tone="teal">Dry run</Badge>}
      <span>{ago(run.finishedAt ?? run.createdAt, now)}</span>
      <span className="text-fg-3">·</span>
      <span className="font-mono text-[11.5px]">{shortSha(run.headSha)}</span>
      {run.profileName && (
        <>
          <span className="text-fg-3">·</span>
          <span>{run.profileName}</span>
        </>
      )}
      {run.model && (
        <>
          <span className="text-fg-3">·</span>
          <span>
            {run.model}
            {run.effort ? `, ${run.effort}` : ""}
          </span>
        </>
      )}
      {run.startedAt && run.finishedAt && (
        <>
          <span className="text-fg-3">·</span>
          <span>{duration(run.finishedAt - run.startedAt)}</span>
        </>
      )}
      {run.githubReviewUrl && (
        <button
          className="ml-auto flex items-center gap-1 text-accent hover:underline"
          onClick={() => void client.app.openExternal({ url: run.githubReviewUrl! })}
        >
          View on GitHub <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  );
}

function ReviewBody({ review }: { review: ReviewDetail }) {
  const payload = review.payload!;
  const byFile = useMemo(() => {
    const map = new Map<string, typeof payload.comments>();
    for (const c of payload.comments) {
      const list = map.get(c.path) ?? [];
      list.push(c);
      map.set(c.path, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.line - b.line);
    return [...map.entries()];
  }, [payload]);

  return (
    <div className="flex flex-col gap-5">
      <article className="rounded-[10px] bg-content px-5 py-4 shadow-[0_0_0_0.5px_var(--line-strong)]">
        {payload.body.trim() ? <Markdown>{payload.body}</Markdown> : <div className="text-[12.5px] italic text-fg-3">No summary.</div>}
      </article>

      {byFile.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-fg-2">{plural(payload.comments.length, "inline comment")}</h2>
          {byFile.map(([path, comments]) => (
            <div key={path} className="overflow-hidden rounded-[10px] bg-content shadow-[0_0_0_0.5px_var(--line-strong)]">
              <div className="selectable flex items-center gap-2 border-b border-line bg-content-2 px-3 py-1.5 font-mono text-[11.5px] text-fg-2">
                <FileText className="size-3.5 shrink-0" />
                <span className="truncate">{path}</span>
              </div>
              {comments.map((c, i) => (
                <div key={i} className={cn(i > 0 && "border-t border-line")}>
                  <DiffSnippet comment={c} />
                  <div className="px-4 py-3">
                    <Markdown>{c.body}</Markdown>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

type PayloadComment = NonNullable<ReviewDetail["payload"]>["comments"][number];

function DiffSnippet({ comment }: { comment: PayloadComment }) {
  const side = comment.side ?? "RIGHT";
  const from = comment.start_line && (comment.start_side ?? side) === side ? comment.start_line : comment.line;
  const inRange = (l: PayloadComment["context"][number]) => {
    const n = side === "RIGHT" ? l.newLine : l.oldLine;
    return n !== null && n >= from && n <= comment.line;
  };
  if (comment.context.length === 0) {
    return <div className="px-4 pt-2 font-mono text-[11px] text-fg-3">line {comment.line}</div>;
  }
  return (
    <div className="selectable overflow-x-auto border-b border-line font-mono text-[11.5px] leading-[1.55] [tab-size:4]">
      <table className="w-full border-collapse">
        <tbody>
          {comment.context.map((l, i) => (
            <tr
              key={i}
              className={cn(l.kind === "add" && "bg-diff-add", l.kind === "del" && "bg-diff-del", inRange(l) && "shadow-[inset_3px_0_0_var(--accent)]")}
            >
              <td className="w-[1%] select-none whitespace-nowrap px-2 text-right text-fg-3">{l.oldLine ?? ""}</td>
              <td className="w-[1%] select-none whitespace-nowrap px-2 text-right text-fg-3">{l.newLine ?? ""}</td>
              <td className="w-[1%] select-none pl-1 text-fg-3">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</td>
              <td className="whitespace-pre pr-4">{l.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
