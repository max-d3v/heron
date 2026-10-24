import type { AccessibleRepo, RepoDto } from "@heron/rpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Lock, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { ago } from "../lib/format";
import { errorText, orpc } from "../lib/rpc";
import { Badge, Button, Checkbox, Confirm, Dialog, Empty, ErrorNote, Field, Segmented, Select, Spinner, Switch } from "../components/ui";

export function ReposPane() {
  const qc = useQueryClient();
  const repos = useQuery(orpc.repos.list.queryOptions());
  const [selected, setSelected] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const current = repos.data?.find((r) => r.id === selected) ?? repos.data?.[0] ?? null;

  return (
    <div className="flex h-full">
      <div className="flex w-[240px] shrink-0 flex-col border-r border-line">
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {repos.data?.length === 0 && <div className="px-2 py-6 text-center text-[12px] text-fg-3">No repositories yet.</div>}
          {repos.data?.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={cn("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left", current?.id === r.id ? "bg-accent text-white" : "hover:bg-hover")}
            >
              <FolderGit2 className={cn("size-4 shrink-0", current?.id === r.id ? "text-white/80" : "text-fg-3")} />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[13px]", !r.enabled && current?.id !== r.id && "text-fg-3")}>{r.name}</span>
                <span className={cn("block truncate text-[11px]", current?.id === r.id ? "text-white/70" : "text-fg-3")}>{r.owner}</span>
              </span>
              {!r.enabled && <span className="text-[10.5px] opacity-70">Paused</span>}
            </button>
          ))}
        </div>
        <div className="border-t border-line p-2">
          <Button icon={<Plus className="size-3.5" />} className="w-full" onClick={() => setAdding(true)}>
            Add repository
          </Button>
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {current ? (
          <RepoEditor key={current.id} repo={current} onRemoved={() => setSelected(null)} />
        ) : (
          <Empty icon={<FolderGit2 className="size-8" />} title="Add a repository to start">
            Heron watches the repositories you add and reviews their pull requests.
          </Empty>
        )}
      </div>
      <AddRepoDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(r) => {
          setSelected(r.id);
          void qc.invalidateQueries({ queryKey: orpc.repos.key() });
        }}
      />
    </div>
  );
}

function RepoEditor({ repo, onRemoved }: { repo: RepoDto; onRemoved: () => void }) {
  const qc = useQueryClient();
  const profiles = useQuery(orpc.profiles.list.queryOptions());
  const settings = useQuery(orpc.settings.get.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.repos.key() });
  const update = useMutation(orpc.repos.update.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(orpc.repos.remove.mutationOptions({ onSuccess: () => (invalidate(), onRemoved()) }));
  const ackAll = useMutation(orpc.settings.update.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: orpc.settings.key() }) }));
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const patch = (p: Parameters<typeof update.mutate>[0]["patch"]) => update.mutate({ id: repo.id, patch: p });
  const defaultProfile = profiles.data?.find((p) => p.isDefault);

  return (
    <div className="mx-auto max-w-[640px] px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">
            {repo.owner}/{repo.name}
          </div>
          <div className="mt-0.5 text-[11.5px] text-fg-2">
            {repo.openPrCount} open PRs
            {repo.lastPolledAt ? ` · checked ${ago(repo.lastPolledAt)}` : " · not checked yet"}
          </div>
        </div>
        <Switch checked={repo.enabled} onChange={(v) => patch({ enabled: v })} label="Enabled" />
        <span className="text-[12px] text-fg-2">{repo.enabled ? "Enabled" : "Paused"}</span>
      </div>
      {repo.lastPollError && (
        <div className="mb-3">
          <ErrorNote>Last check failed: {repo.lastPollError}</ErrorNote>
        </div>
      )}
      {update.error && (
        <div className="mb-3">
          <ErrorNote>{errorText(update.error)}</ErrorNote>
        </div>
      )}

      <Field
        label="Review"
        hint={
          repo.scope === "all"
            ? "Every PR is reviewed when it's opened or pushed to."
            : repo.scope === "mine"
              ? "Only PRs you opened are reviewed."
              : "Only the PRs you pick below are reviewed."
        }
      >
        <Segmented
          value={repo.scope}
          onChange={(v) => {
            if (v === "all" && !settings.data?.allScopeWarningAck) setConfirmAll(true);
            else patch({ scope: v });
          }}
          options={[
            { value: "all", label: "All PRs" },
            { value: "mine", label: "Only mine" },
            { value: "manual", label: "Manual" },
          ]}
        />
      </Field>

      {repo.scope === "manual" && (
        <Field label="Pull requests" align="start">
          <ManualPicker repo={repo} />
        </Field>
      )}

      <Field label="Drafts" hint={repo.scope === "manual" ? "A draft you pick is always reviewed." : undefined}>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={repo.includeDrafts} onChange={(v) => patch({ includeDrafts: v })} />
          Review draft PRs
        </label>
      </Field>

      <Field label="Profile">
        <Select
          value={repo.profileId === null ? "default" : String(repo.profileId)}
          onChange={(v) => patch({ profileId: v === "default" ? null : Number(v) })}
          className="min-w-[220px]"
          options={[
            { value: "default", label: !defaultProfile || defaultProfile.name === "Default" ? "Default profile" : `Default profile (${defaultProfile.name})` },
            ...(profiles.data ?? []).map((p) => ({ value: String(p.id), label: p.name })),
          ]}
        />
      </Field>

      <Field
        label="Repo's .claude config"
        align="start"
        hint="Also load the repository's own .claude/ settings, CLAUDE.md, skills and hooks. Only turn this on for repositories whose contributors you trust: their hooks run on this Mac."
      >
        <label className="flex items-center gap-2 pt-1 text-[13px]">
          <Checkbox checked={repo.trustRepoClaudeConfig} onChange={(v) => patch({ trustRepoClaudeConfig: v })} />
          Trust this repository's Claude config
        </label>
      </Field>

      <div className="mt-6 border-t border-line pt-4">
        <Button variant="danger" onClick={() => setConfirmRemove(true)}>
          Remove repository…
        </Button>
      </div>

      <Confirm
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Review every PR?"
        message="The agent runs with full tools on other people's code on this Mac. Their code can contain instructions aimed at the agent. Heron hides your GitHub token from it, but this is best-effort isolation."
        confirmLabel="Review all PRs"
        onConfirm={() => {
          ackAll.mutate({ allScopeWarningAck: true });
          patch({ scope: "all" });
        }}
      />
      <Confirm
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${repo.name}?`}
        message="Its PRs, review history and local checkout are deleted from Heron. Reviews already posted on GitHub stay."
        confirmLabel="Remove"
        danger
        onConfirm={() => remove.mutate({ id: repo.id })}
      />
    </div>
  );
}

function ManualPicker({ repo }: { repo: RepoDto }) {
  const qc = useQueryClient();
  const prs = useQuery(orpc.repos.openPrs.queryOptions({ input: { id: repo.id } }));
  const set = useMutation(orpc.repos.setManualPrs.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: orpc.repos.key() }) }));
  const picked = new Set(repo.manualPrs);
  if (prs.isPending) return <Spinner />;
  if (!prs.data?.length) return <div className="pt-1 text-[12px] text-fg-3">No open PRs.</div>;
  return (
    <div className="max-h-[260px] w-full overflow-y-auto rounded-[8px] bg-content shadow-[0_0_0_0.5px_var(--line-strong)]">
      {prs.data.map((p) => (
        <label key={p.number} className="flex items-center gap-2.5 border-b border-line px-3 py-1.5 last:border-b-0 hover:bg-hover">
          <Checkbox
            checked={picked.has(p.number)}
            onChange={(v) => {
              const next = new Set(picked);
              if (v) next.add(p.number);
              else next.delete(p.number);
              set.mutate({ id: repo.id, numbers: [...next] });
            }}
          />
          <span className="w-[44px] shrink-0 text-[12px] tabular-nums text-fg-2">#{p.number}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.title}</span>
          {p.isDraft && <Badge>Draft</Badge>}
          <span className="shrink-0 text-[11px] text-fg-3">{p.author}</span>
        </label>
      ))}
      <div className="px-3 py-1.5 text-[11px] text-fg-3">Picking a PR queues a review of its current head right away.</div>
    </div>
  );
}

function AddRepoDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: (r: RepoDto) => void }) {
  const available = useQuery({ ...orpc.repos.available.queryOptions(), enabled: open, staleTime: 60_000 });
  const add = useMutation(
    orpc.repos.add.mutationOptions({
      onSuccess: (r) => {
        onAdded(r);
        onOpenChange(false);
      },
    }),
  );
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (available.data ?? []).filter((r: AccessibleRepo) => !term || `${r.owner}/${r.name}`.toLowerCase().includes(term)).slice(0, 200);
  }, [available.data, q]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add a repository" description="Repositories your gh account can access." width={560}>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter, or type owner/name"
          className="h-[28px] w-full rounded-[7px] bg-field pl-7 pr-2 text-[13px] outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)]"
        />
      </div>
      {add.error && (
        <div className="mb-2">
          <ErrorNote>{errorText(add.error)}</ErrorNote>
        </div>
      )}
      {available.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : available.isError ? (
        <ErrorNote>{errorText(available.error)}</ErrorNote>
      ) : (
        <div className="h-[340px] overflow-y-auto rounded-[8px] shadow-[0_0_0_0.5px_var(--line-strong)]">
          {list.map((r) => (
            <div key={`${r.owner}/${r.name}`} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px]">
                  <span className="text-fg-2">{r.owner}/</span>
                  <span className="font-medium">{r.name}</span>
                  {r.private && <Lock className="size-3 text-fg-3" />}
                </div>
                {r.description && <div className="truncate text-[11.5px] text-fg-3">{r.description}</div>}
              </div>
              {r.added ? (
                <span className="text-[11.5px] text-fg-3">Added</span>
              ) : (
                <Button size="sm" busy={add.isPending && add.variables?.name === r.name} onClick={() => add.mutate({ owner: r.owner, name: r.name })}>
                  Add
                </Button>
              )}
            </div>
          ))}
          {list.length === 0 && /^[\w.-]+\/[\w.-]+$/.test(q.trim()) && (
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[13px]">{q.trim()}</span>
              <Button size="sm" onClick={() => add.mutate({ owner: q.trim().split("/")[0]!, name: q.trim().split("/")[1]! })}>
                Add
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
