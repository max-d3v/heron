import type { AccessibleRepo, ProfileDto, RepoDto, RepoPatch } from "@heron/rpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, FolderOpen, Lock, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { ago } from "../lib/format";
import { errorText, orpc } from "../lib/rpc";
import { Button, Checkbox, Confirm, Dialog, Empty, ErrorNote, Field, Segmented, Select, Spinner, Switch, TextField } from "../components/ui";

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
          {repos.data?.map((r) => {
            const off = !r.reviewEnabled && !r.iterationEnabled;
            return (
              <button
                key={r.id}
                onClick={() => setSelected(r.id)}
                className={cn("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left", current?.id === r.id ? "bg-accent text-white" : "hover:bg-hover")}
              >
                <FolderGit2 className={cn("size-4 shrink-0", current?.id === r.id ? "text-white/80" : "text-fg-3")} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[13px]", off && current?.id !== r.id && "text-fg-3")}>{r.name}</span>
                  <span className={cn("block truncate text-[11px]", current?.id === r.id ? "text-white/70" : "text-fg-3")}>{r.owner}</span>
                </span>
                {off && <span className="text-[10.5px] opacity-70">Off</span>}
              </button>
            );
          })}
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
  const reviewProfiles = profiles.data?.filter((p) => p.kind === "review") ?? [];
  const defaultProfile = reviewProfiles.find((p) => p.isDefault);

  return (
    <div className="mx-auto max-w-[640px] px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">
            {repo.owner}/{repo.name}
          </div>
          <div className="mt-0.5 text-[11.5px] text-fg-2">
            {repo.openPrCount} open PRs
            {!repo.reviewEnabled && !repo.iterationEnabled
              ? " · not watched while reviews and iterations are off"
              : repo.lastPolledAt
                ? ` · checked ${ago(repo.lastPolledAt)}`
                : " · not checked yet"}
          </div>
        </div>
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

      <Section title="Review" first on={repo.reviewEnabled} onToggle={(v) => patch({ reviewEnabled: v })}>
        <Field
          label="Pull requests"
          hint={
            repo.scope === "all"
              ? "Every PR is reviewed when it's opened or pushed to."
              : repo.scope === "mine"
                ? "Only PRs you opened are reviewed."
                : "Every PR is listed; a review only starts when you click Review now."
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

        {repo.scope !== "manual" && (
          <Field label="Drafts">
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={repo.includeDrafts} onChange={(v) => patch({ includeDrafts: v })} />
              Review draft PRs
            </label>
          </Field>
        )}

        <Field label="Profile">
          <Select
            value={repo.profileId === null ? "default" : String(repo.profileId)}
            onChange={(v) => patch({ profileId: v === "default" ? null : Number(v) })}
            className="min-w-[220px]"
            options={[
              { value: "default", label: !defaultProfile || defaultProfile.name === "Default" ? "Default profile" : `Default profile (${defaultProfile.name})` },
              ...reviewProfiles.map((p) => ({ value: String(p.id), label: p.name })),
            ]}
          />
        </Field>
      </Section>

      <Section title="Iteration" on={repo.iterationEnabled} onToggle={(v) => patch({ iterationEnabled: v })}>
        <IterationFields repo={repo} profiles={profiles.data ?? []} dryRun={settings.data?.dryRun ?? false} onPatch={patch} />
      </Section>

      <div className="mt-6 border-t border-line pt-2">
        <Field
          label="Repo's .claude config"
          align="start"
          hint="Reviews and iterations also load the repository's own .claude/ settings, CLAUDE.md, skills and hooks. Only turn this on for repositories whose contributors you trust: their hooks run on this Mac."
        >
          <label className="flex items-center gap-2 pt-1 text-[13px]">
            <Checkbox checked={repo.trustRepoClaudeConfig} onChange={(v) => patch({ trustRepoClaudeConfig: v })} />
            Trust this repository's Claude config
          </label>
        </Field>
      </div>

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

const COMMENTS_HINT: Record<RepoDto["iterationComments"], string> = {
  all: "Anyone's comments, bots included.",
  mine: "Only your own comments, Heron's reviews included (they post as you).",
};

/** A titled section with its own switch. While it's off, its fields stay visible but inactive. */
function Section({
  title,
  on,
  onToggle,
  first,
  children,
}: {
  title: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn(!first && "mt-6 border-t border-line pt-4")}>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <Switch checked={on} onChange={onToggle} label={title} />
      </div>
      <div inert={!on} className={cn("transition-opacity", !on && "opacity-45")}>
        {children}
      </div>
    </section>
  );
}

/** Settings → Repos → Iteration (§15.2). */
function IterationFields({
  repo,
  profiles,
  dryRun,
  onPatch,
}: {
  repo: RepoDto;
  profiles: ProfileDto[];
  dryRun: boolean;
  onPatch: (p: RepoPatch) => void;
}) {
  const iterationProfiles = profiles.filter((p) => p.kind === "iteration");
  const defaultProfile = iterationProfiles.find((p) => p.isDefault);
  const local = repo.useLocalCheckout;

  return (
    <>
      <Field
        label="Automatic iteration"
        hint={
          repo.iterationAutoStart
            ? "Once new comments are triaged, the agent starts on its own."
            : "New comments are triaged, then wait for you to click Iterate."
        }
      >
        <Segmented
          value={repo.iterationAutoStart ? "automatic" : "manual"}
          onChange={(v) => onPatch({ iterationAutoStart: v === "automatic" })}
          options={[
            { value: "manual", label: "Manual" },
            { value: "automatic", label: "Automatic" },
          ]}
        />
      </Field>

      <Field label="Comments to iterate on" hint={COMMENTS_HINT[repo.iterationComments]}>
        <Segmented
          value={repo.iterationComments}
          onChange={(v) => onPatch({ iterationComments: v })}
          options={[
            { value: "all", label: "All comments" },
            { value: "mine", label: "My comments" },
          ]}
        />
      </Field>

      <Field label="Profile">
        <Select
          value={repo.iterationProfileId === null ? "default" : String(repo.iterationProfileId)}
          onChange={(v) => onPatch({ iterationProfileId: v === "default" ? null : Number(v) })}
          className="min-w-[220px]"
          options={[
            { value: "default", label: !defaultProfile || defaultProfile.name === "Default" ? "Default iteration profile" : `Default (${defaultProfile.name})` },
            ...iterationProfiles.map((p) => ({ value: String(p.id), label: p.name })),
          ]}
        />
      </Field>

      <Field label="Push" hint={dryRun ? "Dry run is on, so nothing is pushed and Push stays disabled." : repo.iterationAutoPush ? undefined : "Results wait for Push."}>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={repo.iterationAutoPush} onChange={(v) => onPatch({ iterationAutoPush: v })} />
          Push automatically
        </label>
      </Field>

      <Field
        label="Replies"
        hint="“Addressed in abc1234 — <note>” on each inline thread the agent addressed, after the push, then the thread is resolved. “Not addressed — <reason>” on each one it left alone, which stays open."
      >
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={repo.iterationReply} onChange={(v) => onPatch({ iterationReply: v })} />
          Reply on threads and resolve addressed ones
        </label>
      </Field>

      <Field
        label="Setup command"
        hint={
          local
            ? "Not used with a local checkout: your checkout is already set up."
            : "Runs in full before every agent run, in a fresh checkout (it counts toward the timeout). With it, the agent may run tests and type checks."
        }
      >
        <div className="flex w-full">
          <CommitField
            value={repo.setupCommand ?? ""}
            placeholder="e.g. pnpm install"
            disabled={local}
            mono
            onCommit={(v) => onPatch({ setupCommand: v.trim() || null })}
          />
        </div>
      </Field>

      <LocalCheckoutField repo={repo} />
    </>
  );
}

/**
 * Local checkout: off by default (Heron works in its own clone). Switching it on reuses the folder
 * chosen before, or opens the folder picker; the path can also be typed.
 */
function LocalCheckoutField({ repo }: { repo: RepoDto }) {
  const qc = useQueryClient();
  // On, but no folder saved yet: the field shows until one is chosen.
  const [choosing, setChoosing] = useState(false);
  const save = useMutation(orpc.repos.update.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: orpc.repos.key() }) }));
  const use = (path: string | null) => path && save.mutate({ id: repo.id, patch: { useLocalCheckout: true, localCheckoutPath: path } });
  const pick = useMutation(orpc.repos.pickCheckout.mutationOptions({ onSuccess: use }));
  useEffect(() => {
    if (repo.useLocalCheckout) setChoosing(false);
  }, [repo.useLocalCheckout]);

  const on = repo.useLocalCheckout || choosing;
  const toggle = (v: boolean) => {
    save.reset();
    if (!v) {
      setChoosing(false);
      save.mutate({ id: repo.id, patch: { useLocalCheckout: false } });
      return;
    }
    setChoosing(true);
    if (repo.localCheckoutPath) save.mutate({ id: repo.id, patch: { useLocalCheckout: true } });
    else pick.mutate({ id: repo.id });
  };

  return (
    <Field
      label="Local checkout"
      hint={`Run the agent in your own clone of ${repo.owner}/${repo.name} instead of Heron's copy. An iteration fails while it's on another branch, has uncommitted changes, or isn't at the PR's head.`}
    >
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox checked={on} onChange={toggle} />
        Use my own checkout
      </label>
      {on && (
        <div className="mt-1.5 flex w-full items-center gap-1.5">
          <CommitField
            value={repo.localCheckoutPath ?? ""}
            placeholder="/path/to/your/checkout"
            mono
            onCommit={(v) => save.mutate({ id: repo.id, patch: { useLocalCheckout: true, localCheckoutPath: v.trim() || null } })}
          />
          <Button size="sm" icon={<FolderOpen className="size-3.5" />} busy={pick.isPending} onClick={() => pick.mutate({ id: repo.id })}>
            Choose…
          </Button>
        </div>
      )}
      {save.error && (
        <div className="mt-1.5 w-full">
          <ErrorNote>{errorText(save.error)}</ErrorNote>
        </div>
      )}
    </Field>
  );
}

/** A text field that saves on blur or Enter. */
function CommitField({
  value,
  placeholder,
  disabled,
  mono,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() !== value.trim()) onCommit(text);
  };
  return (
    <TextField
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className={cn("min-w-0 flex-1 disabled:opacity-45", mono && "font-mono text-[12px]")}
    />
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
