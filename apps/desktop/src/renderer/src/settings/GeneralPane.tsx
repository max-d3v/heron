import type { SettingsDto } from "@heron/rpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { bytes } from "../lib/format";
import { client, errorText, orpc } from "../lib/rpc";
import { DoctorList } from "../components/Doctor";
import { Badge, Button, ErrorNote, Field, Switch, TextField, Tooltip } from "../components/ui";

export function GeneralPane() {
  const qc = useQueryClient();
  const settings = useQuery(orpc.settings.get.queryOptions());
  const info = useQuery(orpc.app.info.queryOptions());
  const usage = useQuery(orpc.settings.diskUsage.queryOptions());
  const repos = useQuery(orpc.repos.list.queryOptions());
  const update = useMutation(
    orpc.settings.update.mutationOptions({ onSuccess: (s) => qc.setQueryData(orpc.settings.get.queryKey(), s) }),
  );
  const clear = useMutation(orpc.settings.clearWorktreeCache.mutationOptions({ onSuccess: () => usage.refetch() }));

  if (!settings.data) return null;
  const s = settings.data;
  const set = (patch: Partial<SettingsDto>) => update.mutate(patch);
  const iterationsOn = repos.data?.some((r) => r.iterationEnabled) ?? true;

  return (
    <div className="mx-auto max-w-[640px] px-6 py-5">
      {update.error && (
        <div className="mb-3">
          <ErrorNote>{errorText(update.error)}</ErrorNote>
        </div>
      )}
      <Field label="Check GitHub every" hint="Unchanged repos cost nothing against the rate limit (ETags).">
        <NumberInput value={s.pollIntervalSec} min={10} max={3600} suffix="seconds" onCommit={(v) => set({ pollIntervalSec: v })} />
      </Field>

      <Group title="Reviews">
        <Field label="Parallel runs" hint="How many reviews run at the same time.">
          <NumberInput value={s.parallelRuns} min={1} max={8} onCommit={(v) => set({ parallelRuns: v })} />
        </Field>
        <Field label="Wait after a push" hint="Another push in this window restarts it, so a burst of commits gets one review.">
          <NumberInput value={s.debounceSec} min={0} max={7200} suffix="seconds" onCommit={(v) => set({ debounceSec: v })} />
        </Field>
      </Group>

      <Group title="Iterations" offReason={iterationsOn ? null : "Iterations are off for every repository. Turn them on for one in Repos to use these settings."}>
        <Field label="Parallel runs" hint="How many iterations run at the same time, on top of reviews. Triage, pushes and replies don't count.">
          <NumberInput value={s.iterationParallelRuns} min={1} max={8} onCommit={(v) => set({ iterationParallelRuns: v })} />
        </Field>
        <Field label="Wait after a comment" hint="Iterations triage feedback this long after the newest comment, so a burst of comments is one batch.">
          <NumberInput value={s.iterationDebounceSec} min={0} max={7200} suffix="seconds" onCommit={(v) => set({ iterationDebounceSec: v })} />
        </Field>
        <Field label="Loop cap" hint="After this many Heron pushes in a row with no other push, a PR waits for Iterate until someone else pushes.">
          <NumberInput value={s.loopCap} min={1} max={20} suffix="pushes" onCommit={(v) => set({ loopCap: v })} />
        </Field>
      </Group>

      <div className="my-3 border-t border-line" />

      <Field label="Launch at login">
        <Switch checked={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} label="Launch at login" />
      </Field>
      <Field label="Notify" hint="Done: a review is posted, feedback waits for Iterate, or an iteration is ready to push or pushed.">
        <div className="flex items-center gap-5 text-[13px]">
          <label className="flex items-center gap-2">
            <Switch checked={s.notifyPosted} onChange={(v) => set({ notifyPosted: v })} label="Done" /> Done
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={s.notifyFailed} onChange={(v) => set({ notifyFailed: v })} label="Failed" /> Failed
          </label>
        </div>
      </Field>

      <div className="my-3 border-t border-line" />

      <Field
        label="Worktree cache"
        hint={
          usage.data
            ? `Clones ${bytes(usage.data.reposBytes)} · worktrees ${bytes(usage.data.worktreesBytes)} · transcripts ${bytes(usage.data.transcriptsBytes)}`
            : "Measuring…"
        }
      >
        <div className="flex items-center gap-2">
          <Button busy={clear.isPending} onClick={() => clear.mutate({})}>
            Clear clones and worktrees
          </Button>
          {clear.data && <span className="text-[12px] text-fg-2">Freed {bytes(clear.data.freedBytes)}</span>}
        </div>
        {clear.error && (
          <div className="mt-2">
            <ErrorNote>{errorText(clear.error)}</ErrorNote>
          </div>
        )}
      </Field>

      <Field label="Setup" align="start">
        <DoctorList compact />
      </Field>

      {info.data && (
        <Field label="Heron" align="start">
          <div className="flex items-center gap-2 pt-0.5 text-[12px] text-fg-2">
            Version {info.data.version}
            <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => void client.app.revealPath({ path: `${info.data!.dataDir}/heron.db` })}>
              Data folder
            </Button>
          </div>
        </Field>
      )}
    </div>
  );
}

/** A titled group of fields; greyed out, with the reason on hover, while `offReason` is set. */
function Group({ title, offReason, children }: { title: string; offReason?: string | null; children: ReactNode }) {
  const section = (
    <section className="my-3 border-t border-line pt-4">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {offReason && <Badge>Off</Badge>}
      </div>
      <div inert={!!offReason} className={cn("transition-opacity", offReason && "opacity-45")}>
        {children}
      </div>
    </section>
  );
  return offReason ? (
    <Tooltip content={offReason} side="top">
      {section}
    </Tooltip>
  ) : (
    section
  );
}

function NumberInput({ value, min, max, suffix, onCommit }: { value: number; min: number; max: number; suffix?: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n)) return setText(String(value));
    const clamped = Math.min(max, Math.max(min, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div className="flex items-center gap-2">
      <TextField
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className="w-[70px] text-right tabular-nums"
      />
      {suffix && <span className="text-[12px] text-fg-2">{suffix}</span>}
    </div>
  );
}
