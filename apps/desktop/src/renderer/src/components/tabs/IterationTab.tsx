import type { AgentStepEvent, FeedbackGroupDto, FeedbackPanel, IterationDetail, IterationSummary, PrDetail } from "@heron/rpc";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Clock, ExternalLink, FolderGit2, GitCommitHorizontal, MessagesSquare, Minus, Play, RotateCw, Square, TriangleAlert, Undo2, Upload } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { ago, compactNumber, duration, plural, relativeTime, shortSha } from "../../lib/format";
import { useNow, useStream } from "../../lib/hooks";
import { ITERATION_LABEL, ITERATION_TONE, isInFlightIteration } from "../../lib/iterations";
import { client, errorText, orpc } from "../../lib/rpc";
import { DiffView } from "../DiffView";
import { Markdown } from "../Markdown";
import { ButtonTip } from "../PrDetail";
import { Badge, Button, Confirm, Empty, ErrorNote, Spinner } from "../ui";
import { StepList } from "./ReviewTab";

const COMMENTS_EMPTY: Record<FeedbackPanel["comments"], string> = {
  all: "When anyone comments on this PR",
  mine: "When you comment on this PR (Heron's reviews count as yours)",
};

/** The Iteration tab (§15.8): the open batch of feedback, then the latest iteration that ran the agent (or the one picked in Runs). */
export function IterationTab({ pr, iteration }: { pr: PrDetail; iteration: IterationSummary | null }) {
  const panel = useQuery(orpc.iterations.feedback.queryOptions({ input: { prId: pr.id } }));
  const settings = useQuery(orpc.settings.get.queryOptions());

  if (panel.isPending) {
    return (
      <div className="flex justify-center pt-16">
        <Spinner />
      </div>
    );
  }
  if (panel.isError) {
    return (
      <div className="p-5">
        <ErrorNote>{errorText(panel.error)}</ErrorNote>
      </div>
    );
  }
  const p = panel.data;
  const open = pr.state === "open";
  if (!p.eligible) {
    // A closed PR keeps showing its last pushed iteration (or the one picked in Runs), like the Review tab its last review.
    if (!open && iteration) {
      return (
        <div className="mx-auto flex max-w-[900px] flex-col gap-5 px-5 py-4">
          <IterationRun key={iteration.id} pr={pr} summary={iteration} dryRun={settings.data?.dryRun ?? false} on={p.enabled} />
        </div>
      );
    }
    return (
      <div className="pt-16">
        <Empty icon={<MessagesSquare className="size-7" />} title={open ? "Iterations only run on PRs you opened" : "No iteration pushed"}>
          {p.reason}
        </Empty>
      </div>
    );
  }

  const ready = pr.iterations.find((i) => i.state === "ready") ?? null;
  const showFeedback = p.batches.length > 0;
  if (!p.enabled && !showFeedback && !iteration) {
    return (
      <div className="pt-16">
        <Empty icon={<MessagesSquare className="size-7" />} title="Iterations are off for this repo">
          Turn them on in Settings → Repos.
        </Empty>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5 px-5 py-4">
      {!p.enabled && (
        <div className="rounded-[10px] bg-content-2 px-4 py-2.5 text-[12.5px] text-fg-2 shadow-[0_0_0_0.5px_var(--line)]">
          Iterations are off for this repo, so nothing new starts. Turn them on in Settings → Repos.
        </div>
      )}
      {p.loopCapped && (
        <div className="rounded-[10px] bg-[color-mix(in_srgb,var(--orange)_10%,transparent)] px-4 py-2.5 text-[12.5px]">
          Heron pushed {plural(p.pushStreak, "time")} in a row, so this PR waits for Iterate until someone else pushes.
        </div>
      )}
      {showFeedback && <FeedbackSection pr={pr} panel={p} readyId={ready?.id ?? null} />}
      {iteration ? (
        <IterationRun key={iteration.id} pr={pr} summary={iteration} dryRun={settings.data?.dryRun ?? false} on={p.enabled} />
      ) : (
        !showFeedback && (
          <div className="pt-12">
            <Empty icon={<MessagesSquare className="size-7" />} title="No feedback to address">
              {COMMENTS_EMPTY[p.comments]},{" "}
              {p.autoStart
                ? "an agent addresses the comments and Heron commits the changes."
                : "Heron triages the comments and waits for you to click Iterate."}
            </Empty>
          </div>
        )
      )}
    </div>
  );
}

// ── feedback ─────────────────────────────────────────────────────────────────

function FeedbackSection({ pr, panel, readyId }: { pr: PrDetail; panel: FeedbackPanel; readyId: number | null }) {
  const now = useNow(5_000);
  const iterate = useMutation(orpc.iterations.iterate.mutationOptions());
  const batch = panel.batches[0]!;
  const waiting = panel.batches.find((b) => b.state === "awaiting_start") ?? null;
  const toChange = panel.groups.filter((g) => g.verdict === "change").length;

  let status: string;
  if (batch.state === "debouncing") {
    status = batch.runAfter && batch.runAfter > now ? `Triage ${relativeTime(batch.runAfter, now)}` : "Triage starts shortly";
    if (batch.attempt > 0 && batch.lastError) status += ` · retry after: ${batch.lastError}`;
  } else if (batch.state === "triaging") status = "Triaging…";
  else if (batch.state === "awaiting_start") status = `${plural(toChange, "comment")} to address · waiting for Iterate`;
  else status = `${plural(toChange, "comment")} to address · waits for the current iteration`;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-fg-2">Feedback</h2>
        {batch.state === "triaging" && <Spinner />}
        <span className="min-w-0 truncate text-[12px] text-fg-2">{status}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {waiting && (
            <ButtonTip content={!panel.enabled ? "Iterations are off for this repo" : readyId !== null ? "Push or discard the result that's ready first" : null}>
              <Button
                size="sm"
                variant="primary"
                icon={<Play className="size-3" />}
                disabled={!panel.enabled || readyId !== null}
                busy={iterate.isPending}
                onClick={() => iterate.mutate({ prId: pr.id })}
              >
                Iterate
              </Button>
            </ButtonTip>
          )}
        </div>
      </div>
      {iterate.error && <ErrorNote>{errorText(iterate.error)}</ErrorNote>}
      <div className="overflow-hidden rounded-[10px] bg-content shadow-[0_0_0_0.5px_var(--line-strong)]">
        {panel.groups.length === 0 ? (
          <div className="px-4 py-3 text-[12.5px] text-fg-3">No comments in this batch.</div>
        ) : (
          panel.groups.map((g, i) => <FeedbackRow key={g.key} group={g} first={i === 0} />)
        )}
      </div>
    </section>
  );
}

function location(g: { kind: FeedbackGroupDto["kind"]; path: string | null; line: number | null }): string {
  if (g.kind === "inline") return g.line ? `${g.path}:${g.line}` : (g.path ?? "Inline comment");
  return g.kind === "review" ? "Review" : "Conversation";
}

function Verdict({ verdict }: { verdict: FeedbackGroupDto["verdict"] }) {
  if (verdict === "change") return <Badge tone="blue">Change</Badge>;
  if (verdict === "no-change") return <Badge>No change</Badge>;
  return <Badge tone="orange">Not triaged</Badge>;
}

function OpenLink({ url, label }: { url: string | null; label: string }) {
  if (!url) return null;
  return (
    <button aria-label={label} className="text-fg-3 hover:text-accent" onClick={() => void client.app.openExternal({ url })}>
      <ExternalLink className="size-3.5" />
    </button>
  );
}

function FeedbackRow({ group, first }: { group: FeedbackGroupDto; first: boolean }) {
  return (
    <div className={cn("px-4 py-3", !first && "border-t border-line", group.verdict === "no-change" && "opacity-70")}>
      <div className="flex items-center gap-2 text-[11.5px]">
        <span className="selectable min-w-0 truncate font-mono text-fg-2">{location(group)}</span>
        {group.outdated && <Badge>Outdated</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Verdict verdict={group.verdict} />
          <OpenLink url={group.url} label="Open on GitHub" />
        </span>
      </div>
      {group.reason && <div className="mt-1 text-[11.5px] text-fg-2">{group.reason}</div>}
      <Thread comments={group.comments} />
    </div>
  );
}

type ThreadComment = FeedbackGroupDto["comments"][number];

/** A thread: the first comment and the last two, with the ones between behind a toggle. */
function Thread({ comments }: { comments: ThreadComment[] }) {
  const [all, setAll] = useState(false);
  const hidden = all || comments.length <= 3 ? 0 : comments.length - 3;
  const shown = hidden > 0 ? [comments[0]!, ...comments.slice(-2)] : comments;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {shown.map((c, i) => (
        <div key={`${c.createdAt}:${i}`}>
          {hidden > 0 && i === 1 && (
            <button className="mb-2 text-[11.5px] text-accent hover:underline" onClick={() => setAll(true)}>
              Show {plural(hidden, "more comment")}
            </button>
          )}
          <div className="text-[11.5px] font-medium text-fg-2">
            @{c.author}
            {c.heron && <span className="font-normal text-fg-3"> · Heron</span>}
          </div>
          <ClampedMarkdown text={c.body} />
        </div>
      ))}
    </div>
  );
}

function ClampedMarkdown({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 500 || text.split("\n").length > 8;
  return (
    <div>
      <div className={cn("text-[12.5px]", long && !open && "max-h-[150px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>
        <Markdown>{text}</Markdown>
      </div>
      {long && (
        <button className="mt-0.5 text-[11.5px] text-accent hover:underline" onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ── the iteration ────────────────────────────────────────────────────────────

/** `on`: iterations are turned on for the repo (Push and Re-run need it). */
function IterationRun({ pr, summary, dryRun, on }: { pr: PrDetail; summary: IterationSummary; dryRun: boolean; on: boolean }) {
  if (isInFlightIteration(summary)) return <LiveIteration summary={summary} />;
  if (summary.state === "queued" || summary.state === "held") return <PendingIteration summary={summary} />;
  return <FinishedIteration pr={pr} summary={summary} dryRun={dryRun} on={on} />;
}

function PendingIteration({ summary }: { summary: IterationSummary }) {
  const now = useNow(5_000);
  const cancel = useMutation(orpc.iterations.cancel.mutationOptions());
  const when = summary.runAfter && summary.runAfter > now ? relativeTime(summary.runAfter, now) : null;
  return (
    <div className="flex items-center gap-3 rounded-[10px] bg-content-2 px-4 py-3 shadow-[0_0_0_0.5px_var(--line)]">
      <Clock className="size-4 text-warn" />
      <div className="min-w-0 flex-1 text-[12.5px]">
        <span className="font-medium">{summary.state === "held" ? "Waiting for the current iteration" : "Queued"}</span>
        <span className="text-fg-2">
          {summary.triageChange > 0 && ` · ${plural(summary.triageChange, "comment")} to address`}
          {when && ` · ${summary.attempt > 0 ? `retry ${when}` : `starts ${when}`}`}
        </span>
        {summary.lastError && <div className="mt-0.5 truncate text-[11.5px] text-fg-2">Last error: {summary.lastError}</div>}
        {cancel.error && <div className="mt-1"><ErrorNote>{errorText(cancel.error)}</ErrorNote></div>}
      </div>
      <Button size="sm" icon={<Square className="size-3" />} busy={cancel.isPending} onClick={() => cancel.mutate({ id: summary.id })}>
        Cancel
      </Button>
    </div>
  );
}

function LiveIteration({ summary }: { summary: IterationSummary }) {
  const now = useNow(1_000);
  const cancel = useMutation(orpc.iterations.cancel.mutationOptions());
  const { items: steps } = useStream<AgentStepEvent>(`iteration-steps:${summary.id}`, (signal) =>
    client.iterations.agentSteps({ iterationId: summary.id }, { signal }),
  );
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Spinner className="text-accent" />
        <div className="text-[13px] font-medium">{ITERATION_LABEL[summary.state]}</div>
        <div className="min-w-0 truncate text-[12px] text-fg-2">
          {summary.headSha ? `${shortSha(summary.headSha)} · ` : ""}
          {summary.profileName} · {summary.model}
          {summary.effort ? ` · ${summary.effort}` : ""}
          {summary.cwdKind === "local" ? " · local checkout" : ""}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="font-mono text-[11.5px] tabular-nums text-fg-2">{summary.startedAt ? duration(now - summary.startedAt) : ""}</span>
          {summary.state !== "pushing" && summary.state !== "replying" && (
            <Button size="sm" icon={<Square className="size-3" />} busy={cancel.isPending} onClick={() => cancel.mutate({ id: summary.id })}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      {summary.attempt > 0 && <div className="text-[11.5px] text-fg-2">Attempt {summary.attempt + 1}. Last error: {summary.lastError}</div>}
      {cancel.error && <ErrorNote>{errorText(cancel.error)}</ErrorNote>}
      {steps.length > 0 ? (
        <StepList steps={steps} live />
      ) : (
        <div className="rounded-[8px] bg-content-2 px-3 py-3 text-[12px] text-fg-2 shadow-[0_0_0_0.5px_var(--line)]">
          {summary.state === "preparing" ? "Checking out the PR head…" : "Waiting for the agent…"}
        </div>
      )}
    </section>
  );
}

const FINISHED_NOTE: Partial<Record<IterationSummary["state"], string>> = {
  no_changes: "The agent didn't change any files, so there's nothing to commit.",
  stale: "The PR moved before this was pushed. The same comments run again on the new head.",
  cancelled: "Cancelled before it finished.",
  discarded: "Discarded. Its comments count as handled.",
  uncommitted: "Uncommitted. The changes are staged in your local checkout for you to finish; its comments count as handled.",
};

function FinishedIteration({ pr, summary, dryRun, on }: { pr: PrDetail; summary: IterationSummary; dryRun: boolean; on: boolean }) {
  const detail = useQuery(orpc.iterations.get.queryOptions({ input: { id: summary.id } }));
  const diff = useQuery({ ...orpc.iterations.diff.queryOptions({ input: { id: summary.id } }), enabled: summary.commitSha !== null });
  const steps = useQuery(orpc.iterations.steps.queryOptions({ input: { id: summary.id } }));
  const push = useMutation(orpc.iterations.push.mutationOptions());
  const discard = useMutation(orpc.iterations.discard.mutationOptions());
  const uncommit = useMutation(orpc.iterations.uncommit.mutationOptions());
  const rerun = useMutation(orpc.iterations.rerun.mutationOptions());
  const rerunInWorktree = useMutation(orpc.iterations.rerun.mutationOptions());
  const [showSteps, setShowSteps] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  if (detail.isPending) return <Spinner />;
  if (detail.isError) return <ErrorNote>{errorText(detail.error)}</ErrorNote>;
  const it = detail.data;
  const busy = pr.iterations.some((i) => i.id !== it.id && (isInFlightIteration(i) || i.state === "queued"));
  const canRerun = pr.state === "open" && it.state !== "stale" && it.state !== "skipped" && !busy;
  const error = push.error ?? discard.error ?? uncommit.error ?? rerun.error ?? rerunInWorktree.error;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <IterationMeta it={it} />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {canRerun && (
            <ButtonTip content={on ? null : "Iterations are off for this repo"}>
              <Button size="sm" icon={<RotateCw className="size-3" />} disabled={!on} busy={rerun.isPending} onClick={() => rerun.mutate({ id: it.id })}>
                Re-run
              </Button>
            </ButtonTip>
          )}
          {it.state === "ready" && (
            <>
              <Button size="sm" busy={discard.isPending} onClick={() => setConfirmDiscard(true)}>
                Discard
              </Button>
              {it.cwdKind === "local" && (
                <ButtonTip content="Take the commit off your local checkout and keep its changes staged (git reset --soft)">
                  <Button size="sm" icon={<Undo2 className="size-3" />} busy={uncommit.isPending} onClick={() => uncommit.mutate({ id: it.id })}>
                    Uncommit
                  </Button>
                </ButtonTip>
              )}
              <ButtonTip content={dryRun ? "Dry run is on, so nothing is pushed" : on ? null : "Iterations are off for this repo"}>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Upload className="size-3" />}
                  disabled={dryRun || !on}
                  busy={push.isPending}
                  onClick={() => push.mutate({ id: it.id })}
                >
                  Push
                </Button>
              </ButtonTip>
            </>
          )}
        </div>
      </div>
      {error && <ErrorNote>{errorText(error)}</ErrorNote>}

      {it.state === "failed" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2 rounded-[10px] bg-[color-mix(in_srgb,var(--red)_9%,transparent)] px-4 py-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" />
            <div className="min-w-0 flex-1">
              <div className="selectable whitespace-pre-wrap text-[12.5px] text-fg">{it.lastError ?? "Failed"}</div>
              {it.localCheckoutFailed && canRerun && (
                <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <ButtonTip content={on ? null : "Iterations are off for this repo"}>
                    <Button
                      size="sm"
                      icon={<FolderGit2 className="size-3" />}
                      disabled={!on}
                      busy={rerunInWorktree.isPending}
                      onClick={() => rerunInWorktree.mutate({ id: it.id, worktree: true })}
                    >
                      Re-run in a worktree
                    </Button>
                  </ButtonTip>
                  <span className="text-[11.5px] text-fg-2">Heron checks out the PR head in its own worktree this time. Your checkout stays as it is.</span>
                </div>
              )}
            </div>
          </div>
          {it.rawOutput && (
            <details className="rounded-[8px] bg-content-2 shadow-[0_0_0_0.5px_var(--line)]">
              <summary className="px-3 py-2 text-[12px] font-medium text-fg-2">Raw output</summary>
              <pre className="max-h-[400px] overflow-auto border-t border-line px-3 py-2 font-mono text-[11.5px] leading-[1.5]">{it.rawOutput}</pre>
            </details>
          )}
        </div>
      )}
      {FINISHED_NOTE[it.state] && <div className="text-[12.5px] text-fg-2">{FINISHED_NOTE[it.state]}</div>}

      {it.commitTitle && (
        <div className="rounded-[10px] bg-content px-4 py-3 shadow-[0_0_0_0.5px_var(--line-strong)]">
          <div className="selectable text-[14px] font-semibold">{it.commitTitle}</div>
          {it.commitSha && (
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-fg-2">
              <GitCommitHorizontal className="size-3.5" />
              <span className="selectable font-mono text-[11.5px]">{shortSha(it.commitSha)}</span>
              {it.commitUrl ? (
                <button className="flex items-center gap-1 text-accent hover:underline" onClick={() => void client.app.openExternal({ url: it.commitUrl! })}>
                  View on GitHub <ExternalLink className="size-3" />
                </button>
              ) : (
                it.state === "ready" && <span>· not pushed yet</span>
              )}
            </div>
          )}
        </div>
      )}

      {it.items.length > 0 && <Items it={it} />}

      {diff.data && diff.data.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-fg-2">
            Changes · {plural(diff.data.length, "file")} <span className="font-mono normal-case text-ok">+{diff.data.reduce((n, f) => n + f.additions, 0)}</span>{" "}
            <span className="font-mono normal-case text-bad">−{diff.data.reduce((n, f) => n + f.deletions, 0)}</span>
          </h2>
          <DiffView files={diff.data} />
        </section>
      )}

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

      <Confirm
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this commit?"
        message={
          it.cwdKind === "local"
            ? "Heron takes the commit back off your local checkout (git reset --keep). Its comments count as handled."
            : `Nothing is pushed; the commit stays in Heron's clone (refs/heron/iterations/${it.id}). Its comments count as handled.`
        }
        confirmLabel="Discard"
        danger
        onConfirm={() => discard.mutate({ id: it.id })}
      />
    </section>
  );
}

function IterationMeta({ it }: { it: IterationDetail }) {
  const now = useNow(30_000);
  const parts = [
    ago(it.finishedAt ?? it.createdAt, now),
    it.profileName,
    it.model ? `${it.model}${it.effort ? `, ${it.effort}` : ""}` : null,
    it.startedAt && it.finishedAt ? duration(it.finishedAt - it.startedAt) : null,
    it.triageTotal > 0 ? `${it.triageChange} of ${it.triageTotal} to change` : null,
    it.cwdKind === "local" ? "local checkout" : null,
    it.usage ? `${compactNumber(it.usage.input + it.usage.output)} tokens` : null,
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-2">
      <Badge tone={ITERATION_TONE[it.state]}>{ITERATION_LABEL[it.state]}</Badge>
      {it.dryRun && <Badge tone="teal">Dry run</Badge>}
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-fg-3">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

function Items({ it }: { it: IterationDetail }) {
  const addressed = it.items.filter((i) => i.status === "addressed").length;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-fg-2">
        {it.addressed === null ? plural(it.items.length, "comment") : `${addressed} of ${it.items.length} addressed`}
      </h2>
      <div className="overflow-hidden rounded-[10px] bg-content shadow-[0_0_0_0.5px_var(--line-strong)]">
        {it.items.map((item, i) => (
          <ItemRow key={item.number} item={item} first={i === 0} />
        ))}
      </div>
    </section>
  );
}

function ItemRow({ item, first }: { item: IterationDetail["items"][number]; first: boolean }) {
  const [open, setOpen] = useState(false);
  const author = item.comments.find((c) => !c.heron)?.author;
  return (
    <div className={cn("flex gap-2.5 px-4 py-2.5", !first && "border-t border-line")}>
      <span className="mt-[3px] shrink-0">
        {item.status === "addressed" ? <Check className="size-3.5 text-ok" strokeWidth={2.5} /> : <Minus className="size-3.5 text-fg-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11.5px] text-fg-2">
          <span className="font-mono">{item.number}.</span>
          <span className="selectable min-w-0 truncate font-mono">{location(item)}</span>
          {item.outdated && <Badge>Outdated</Badge>}
          {author && <span className="shrink-0 text-fg-3">@{author}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {item.comments.length > 0 && (
              <button className="text-accent hover:underline" onClick={() => setOpen((v) => !v)}>
                {open ? "Hide comments" : plural(item.comments.length, "comment")}
              </button>
            )}
            <OpenLink url={item.url} label="Open on GitHub" />
          </span>
        </div>
        <div className="selectable mt-0.5 text-[12.5px]">{item.note ?? <span className="text-fg-3">No note</span>}</div>
        {open && <Thread comments={item.comments} />}
      </div>
    </div>
  );
}
