import type { PrListItem, QueueStatusDto } from "@heron/rpc";
import { Eye, EyeOff, GitPullRequest, Pause, Play, Search, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { relativeTime } from "../lib/format";
import { useNow } from "../lib/hooks";
import { client } from "../lib/rpc";
import { isListed } from "../lib/visibility";
import { Avatar } from "./Avatar";
import { PrIcon, prStatusLabel } from "./StatusDot";
import { Empty, IconButton, Select, Tooltip } from "./ui";

export function Sidebar({
  prs,
  selectedId,
  onSelect,
  onOpenSettings,
  queue,
  loading,
  showAll,
  onShowAllChange,
}: {
  prs: PrListItem[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpenSettings: () => void;
  queue: QueueStatusDto | null;
  loading: boolean;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [repo, setRepo] = useState("all");
  const now = useNow(30_000);

  const repos = useMemo(() => [...new Set(prs.map((p) => p.repo))].sort(), [prs]);
  const hiddenCount = useMemo(() => prs.filter((p) => !isListed(p, false)).length, [prs]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return prs.filter((p) => {
      if (!isListed(p, showAll)) return false;
      if (repo !== "all" && p.repo !== repo) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        `${p.repo}#${p.number}`.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q) ||
        String(p.number) === q.replace("#", "")
      );
    });
  }, [prs, search, repo, showAll]);

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-line">
      <div className="drag flex h-[52px] shrink-0 items-center justify-end gap-1 pl-[84px] pr-2.5">
        <QueueIndicator queue={queue} />
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="h-[26px] w-full rounded-[7px] bg-field pl-7 pr-2 text-[13px] outline-none placeholder:text-fg-3 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
        </div>
        {repos.length > 1 && (
          <Select
            value={repo}
            onChange={setRepo}
            className="!h-[26px] !min-w-0 max-w-[118px] !bg-field !shadow-none"
            options={[{ value: "all", label: "All repos" }, ...repos.map((r) => ({ value: r, label: r.split("/")[1] ?? r, hint: r.split("/")[0] }))]}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {visible.length === 0 ? (
          <Empty
            icon={<GitPullRequest className="size-7" />}
            title={loading ? "Loading…" : prs.length === 0 ? "No pull requests yet" : search || repo !== "all" ? "Nothing matches" : "No PRs in scope"}
          >
            {!loading && prs.length === 0 && "Add a repository in Settings and its open PRs show up here."}
            {!loading && prs.length > 0 && !search && repo === "all" && !showAll && "New PRs in scope show up here. The other open PRs are one click away below."}
          </Empty>
        ) : (
          <ul className="flex flex-col gap-px">
            {visible.map((p) => (
              <li key={p.id}>
                <PrRow pr={p} selected={p.id === selectedId} now={now} onClick={() => onSelect(p.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex h-[38px] shrink-0 items-center justify-between border-t border-line px-2">
        <IconButton label="Settings (⌘,)" onClick={onOpenSettings}>
          <Settings className="size-[15px]" />
        </IconButton>
        {hiddenCount > 0 || showAll ? (
          <Tooltip content={showAll ? "Hide PRs outside each repo's scope" : `Show ${hiddenCount} open PRs outside each repo's scope`}>
            <button
              onClick={() => onShowAllChange(!showAll)}
              className="flex h-[24px] items-center gap-1.5 rounded-[6px] px-2 text-[11.5px] text-fg-2 hover:bg-hover hover:text-fg"
            >
              {showAll ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {showAll ? "In scope only" : `${hiddenCount} more`}
            </button>
          </Tooltip>
        ) : null}
      </div>
    </aside>
  );
}

function PrRow({ pr, selected, now, onClick }: { pr: PrListItem; selected: boolean; now: number; onClick: () => void }) {
  const closed = pr.state !== "open";
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left outline-none",
        selected ? "bg-accent text-white" : "hover:bg-hover",
        !pr.repoEnabled && !selected && "opacity-60",
      )}
    >
      <Tooltip content={prStatusLabel(pr.state, pr.status) + (pr.headUnreviewed ? " (older commit)" : "")} side="right">
        <span className="flex h-[18px] w-3 items-center justify-center">
          <PrIcon state={pr.state} status={pr.status} selected={selected} />
        </span>
      </Tooltip>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("truncate text-[13px] font-[500] leading-[18px]", closed && !selected && "text-fg-2")}>{pr.title}</span>
          <span className={cn("ml-auto shrink-0 text-[11px] tabular-nums", selected ? "text-white/75" : "text-fg-3")}>
            {/* The clock ticks every 30s, so a fresh timestamp can be slightly ahead of it. */}
            {relativeTime(Math.min(pr.lastActivityAt, now), now)}
          </span>
        </span>
        <span className={cn("mt-0.5 flex items-center gap-1.5 text-[11.5px]", selected ? "text-white/80" : "text-fg-2")}>
          <Avatar login={pr.author} url={pr.authorAvatarUrl} size={14} />
          <span className="truncate">
            {pr.repo.split("/")[1]}#{pr.number}
          </span>
          {pr.isDraft && <Tag selected={selected}>Draft</Tag>}
          {closed && <Tag selected={selected}>{pr.state === "merged" ? "Merged" : "Closed"}</Tag>}
          {pr.headUnreviewed && !closed && <Tag selected={selected}>New commits</Tag>}
        </span>
      </span>
    </button>
  );
}

function Tag({ children, selected }: { children: string; selected: boolean }) {
  return (
    <span className={cn("shrink-0 rounded-[4px] px-1 text-[10px] font-medium", selected ? "bg-white/20 text-white" : "bg-field text-fg-2")}>{children}</span>
  );
}

function QueueIndicator({ queue }: { queue: QueueStatusDto | null }) {
  if (!queue) return null;
  const manual = queue.reasons.includes("manual");
  const label = queue.paused
    ? queue.reasons.includes("limit")
      ? "Usage limit"
      : queue.reasons.includes("auth")
        ? "Logged out"
        : queue.reasons.includes("doctor")
          ? "Setup needed"
          : "Paused"
    : queue.running > 0
      ? `${queue.running} running`
      : queue.queued + queue.debouncing > 0
        ? `${queue.queued + queue.debouncing} waiting`
        : "Idle";
  return (
    <div className="flex items-center gap-1">
      <Tooltip content={queue.message ?? (queue.paused ? "Paused" : "Reviews run automatically")}>
        <span
          className={cn(
            "flex h-[20px] items-center gap-1.5 rounded-full px-2 text-[11px] font-medium",
            queue.paused ? "bg-[color-mix(in_srgb,var(--orange)_16%,transparent)] text-warn" : "text-fg-2",
          )}
        >
          {queue.running > 0 && !queue.paused && <span className="spin size-2.5 rounded-full border-[1.5px] border-accent border-t-transparent" />}
          {label}
        </span>
      </Tooltip>
      <IconButton
        label={manual ? "Resume reviews" : "Pause all reviews"}
        onClick={() => void (manual ? client.queue.resume() : client.queue.pause())}
      >
        {manual ? <Play className="size-[14px]" /> : <Pause className="size-[14px]" />}
      </IconButton>
    </div>
  );
}
