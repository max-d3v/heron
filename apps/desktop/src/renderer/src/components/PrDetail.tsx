import type { IterationSummary, PrDetail as PrDetailDto, RunSummary } from "@heron/rpc";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, Play, RotateCw, Square } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { shortSha } from "../lib/format";
import { defaultIteration } from "../lib/iterations";
import { errorText, orpc } from "../lib/rpc";
import { Avatar } from "./Avatar";
import { PrIcon, prStatusLabel } from "./StatusDot";
import { ActivityTab } from "./tabs/ActivityTab";
import { IterationTab } from "./tabs/IterationTab";
import { PrTab } from "./tabs/PrTab";
import { ReviewTab } from "./tabs/ReviewTab";
import { RunsTab } from "./tabs/RunsTab";
import { TranscriptTab } from "./tabs/TranscriptTab";
import { Button, Empty, ErrorNote, Segmented, Spinner, Tooltip } from "./ui";

export type Tab = "review" | "iteration" | "activity" | "runs" | "transcript" | "pr";

const ACTIVE = new Set(["debouncing", "queued", "preparing", "running", "validating", "posting"]);
const IN_FLIGHT = new Set(["preparing", "running", "validating", "posting"]);

export function isActiveRun(r: RunSummary): boolean {
  return ACTIVE.has(r.state);
}
export function isInFlightRun(r: RunSummary): boolean {
  return IN_FLIGHT.has(r.state);
}

/** The run the Review tab shows by default: the newest one that produced something (or failed). */
function defaultRun(runs: RunSummary[]): RunSummary | null {
  return runs.find((r) => r.state === "posted" || r.state === "completed" || r.state === "failed" || isInFlightRun(r)) ?? runs[0] ?? null;
}

/** Which run the Transcript tab shows: the one of the Review or Iteration tab last looked at. */
type TranscriptFor = "review" | "iteration";

export function PrDetail({ prId, requestedTab }: { prId: number; requestedTab?: { tab: Tab; at: number } | null }) {
  const query = useQuery(orpc.prs.get.queryOptions({ input: { id: prId } }));
  const [tab, setTabState] = useState<Tab>(requestedTab?.tab ?? "review");
  const [transcriptFor, setTranscriptFor] = useState<TranscriptFor>(requestedTab?.tab === "iteration" ? "iteration" : "review");
  const [pickedRunId, setPickedRunId] = useState<number | null>(null);
  const [pickedIterationId, setPickedIterationId] = useState<number | null>(null);

  const setTab = (t: Tab) => {
    setTabState(t);
    if (t === "review" || t === "iteration") setTranscriptFor(t);
  };

  useEffect(() => {
    setPickedRunId(null);
    setPickedIterationId(null);
  }, [prId]);

  // A notification or the menu bar asked for a tab (e.g. Ready to push → Iteration).
  useEffect(() => {
    if (!requestedTab) return;
    setTabState(requestedTab.tab);
    if (requestedTab.tab === "iteration") {
      setTranscriptFor("iteration");
      setPickedIterationId(null);
    }
  }, [requestedTab]);

  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return <Empty title="Couldn't load this PR">{errorText(query.error)}</Empty>;
  }
  const pr = query.data;
  const shown = (pickedRunId !== null ? pr.runs.find((r) => r.id === pickedRunId) : null) ?? defaultRun(pr.runs);
  const shownIteration: IterationSummary | null =
    (pickedIterationId !== null ? pr.iterations.find((i) => i.id === pickedIterationId) : null) ??
    defaultIteration(pr.iterations, pr.state === "open");
  const runCount = pr.runs.length + pr.iterations.filter((i) => i.startedAt !== null || i.state === "skipped").length;
  const picked = tab === "iteration" ? pickedIterationId !== null && shownIteration : tab === "review" && pickedRunId !== null && shown;

  return (
    <div className="flex h-full flex-col">
      <Header pr={pr} shown={shown} />
      <div className="flex shrink-0 items-center justify-between border-b border-line px-5 pb-2.5">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "review", label: "Review" },
            { value: "iteration", label: "Iteration" },
            { value: "activity", label: "Activity" },
            { value: "runs", label: runCount ? `Runs (${runCount})` : "Runs" },
            { value: "transcript", label: "Transcript" },
            { value: "pr", label: "Pull Request" },
          ]}
        />
        {picked && (
          <button
            className="text-[11.5px] text-accent hover:underline"
            onClick={() => (tab === "iteration" ? setPickedIterationId(null) : setPickedRunId(null))}
          >
            {tab === "iteration" ? `Showing iteration ${shownIteration!.id}` : `Showing run of ${shortSha(shown!.headSha)}`} · show latest
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "review" && <ReviewTab pr={pr} run={shown} />}
        {tab === "iteration" && <IterationTab pr={pr} iteration={shownIteration} />}
        {tab === "activity" && <ActivityTab prId={pr.id} />}
        {tab === "runs" && (
          <RunsTab
            runs={pr.runs}
            iterations={pr.iterations}
            selectedRunId={shown?.id ?? null}
            selectedIterationId={shownIteration?.id ?? null}
            onOpenRun={(id) => {
              setPickedRunId(id);
              setTab("review");
            }}
            onOpenIteration={(id) => {
              setPickedIterationId(id);
              setTab("iteration");
            }}
          />
        )}
        {tab === "transcript" && (
          <TranscriptTab
            target={
              transcriptFor === "iteration"
                ? shownIteration && { kind: "iteration", iteration: shownIteration }
                : shown && { kind: "review", run: shown }
            }
          />
        )}
        {tab === "pr" && <PrTab pr={pr} />}
      </div>
    </div>
  );
}

function Header({ pr, shown }: { pr: PrDetailDto; shown: RunSummary | null }) {
  const reviewNow = useMutation(orpc.reviews.reviewNow.mutationOptions());
  const rerun = useMutation(orpc.reviews.rerun.mutationOptions());
  const cancel = useMutation(orpc.reviews.cancel.mutationOptions());
  const openExternal = useMutation(orpc.app.openExternal.mutationOptions());

  const active = useMemo(() => pr.runs.find(isActiveRun) ?? null, [pr.runs]);
  const headActive = active?.headSha === pr.headSha;
  const headRunning = headActive && active !== null && isInFlightRun(active);
  const open = pr.state === "open";
  // Review now and Re-run need reviews on: with them off, nothing would pick the run up.
  const notOpenReason = !open ? `This PR is ${pr.state}, so it can't be reviewed` : pr.reviewsOn ? null : "Reviews are off for this repo";
  const error = reviewNow.error ?? rerun.error ?? cancel.error;

  return (
    // On Windows the right padding clears the window buttons drawn over this corner.
    <header className="drag shrink-0 pb-3 pl-5 pr-[calc(1.25rem_+_var(--titlebar-right))] pt-[14px]">
      <div className="flex items-start gap-4">
        {/* The text opts out of dragging so it can be selected and its tooltips work; the gaps still move the window. */}
        <div className="no-drag min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Tooltip content={prStatusLabel(pr.state, pr.status)}>
              <span className="flex w-3 items-center justify-center">
                <PrIcon state={pr.state} status={pr.status} />
              </span>
            </Tooltip>
            <h1 className="selectable truncate text-[17px] font-semibold leading-[24px] tracking-[-0.01em]">{pr.title}</h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-fg-2">
            <span className="selectable">
              {pr.repo}#{pr.number}
            </span>
            <span className="text-fg-3">·</span>
            <span className="flex items-center gap-1">
              <Avatar login={pr.author} url={pr.authorAvatarUrl} size={14} />
              {pr.author}
            </span>
            <span className="text-fg-3">·</span>
            <span className="flex items-center gap-1 font-mono text-[11.5px]">
              <span className="max-w-[180px] truncate">{pr.headRef}</span>
              <ArrowRight className="size-3 text-fg-3" />
              <span className="max-w-[140px] truncate">{pr.baseRef}</span>
            </span>
            <span className="text-fg-3">·</span>
            <Tooltip content={pr.headSha}>
              <span className="selectable font-mono text-[11.5px]">{shortSha(pr.headSha)}</span>
            </Tooltip>
            {pr.isDraft && <span className="rounded-[4px] bg-field px-1 text-[10.5px] font-medium">Draft</span>}
            {!open && <span className="rounded-[4px] bg-field px-1 text-[10.5px] font-medium">{pr.state === "merged" ? "Merged" : "Closed"}</span>}
            {!pr.inScope && open && (
              <Tooltip content="This PR is outside the repo's scope, so pushes don't trigger reviews. Review now still works.">
                <span className="rounded-[4px] bg-field px-1 text-[10.5px] font-medium">Out of scope</span>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <Button icon={<ExternalLink className="size-3.5" />} onClick={() => openExternal.mutate({ url: pr.url })}>
            Open on GitHub
          </Button>
          {active && isActiveRun(active) ? (
            <Button icon={<Square className="size-3" />} busy={cancel.isPending} onClick={() => cancel.mutate({ reviewId: active.id })}>
              Cancel
            </Button>
          ) : (
            shown && (
              <ButtonTip content={notOpenReason ?? `Review ${shortSha(shown.headSha)} again`}>
                <Button
                  icon={<RotateCw className="size-3.5" />}
                  disabled={notOpenReason !== null}
                  busy={rerun.isPending}
                  onClick={() => rerun.mutate({ reviewId: shown.id })}
                >
                  Re-run
                </Button>
              </ButtonTip>
            )
          )}
          <ButtonTip content={notOpenReason ?? (headRunning ? `Already reviewing ${shortSha(pr.headSha)}` : null)}>
            <Button
              variant="primary"
              icon={<Play className="size-3.5" />}
              disabled={notOpenReason !== null || headRunning}
              busy={reviewNow.isPending}
              onClick={() => reviewNow.mutate({ prId: pr.id })}
            >
              Review now
            </Button>
          </ButtonTip>
        </div>
      </div>
      {error && (
        <div className="no-drag mt-2">
          <ErrorNote>{errorText(error)}</ErrorNote>
        </div>
      )}
    </header>
  );
}

/**
 * Disabled buttons get no pointer events, so the tooltip hangs off a wrapper and the
 * button lets the pointer through to it. The wrapper also opts out of window dragging.
 */
export function ButtonTip({ content, children }: { content: string | null; children: ReactElement }) {
  if (!content) return children;
  return (
    <Tooltip content={content}>
      <span className="no-drag inline-flex [&>button:disabled]:pointer-events-none">{children}</span>
    </Tooltip>
  );
}
