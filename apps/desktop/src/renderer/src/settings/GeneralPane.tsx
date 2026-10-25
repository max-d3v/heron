import type { SettingsDto } from "@heron/rpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { bytes } from "../lib/format";
import { client, errorText, orpc } from "../lib/rpc";
import { DoctorList } from "../components/Doctor";
import { Button, ErrorNote, Field, Switch, TextField } from "../components/ui";

export function GeneralPane() {
  const qc = useQueryClient();
  const settings = useQuery(orpc.settings.get.queryOptions());
  const info = useQuery(orpc.app.info.queryOptions());
  const usage = useQuery(orpc.settings.diskUsage.queryOptions());
  const update = useMutation(
    orpc.settings.update.mutationOptions({ onSuccess: (s) => qc.setQueryData(orpc.settings.get.queryKey(), s) }),
  );
  const clear = useMutation(orpc.settings.clearWorktreeCache.mutationOptions({ onSuccess: () => usage.refetch() }));

  if (!settings.data) return null;
  const s = settings.data;
  const set = (patch: Partial<SettingsDto>) => update.mutate(patch);

  return (
    <div className="mx-auto max-w-[640px] px-6 py-5">
      {update.error && (
        <div className="mb-3">
          <ErrorNote>{errorText(update.error)}</ErrorNote>
        </div>
      )}
      <Field label="Parallel reviews" hint="How many reviews run at the same time.">
        <NumberInput value={s.parallelRuns} min={1} max={8} onCommit={(v) => set({ parallelRuns: v })} />
      </Field>
      <Field label="Check GitHub every" hint="Unchanged repos cost nothing against the rate limit (ETags).">
        <NumberInput value={s.pollIntervalSec} min={10} max={3600} suffix="seconds" onCommit={(v) => set({ pollIntervalSec: v })} />
      </Field>
      <Field label="Wait after a push" hint="Another push in this window restarts it, so a burst of commits gets one review.">
        <NumberInput value={s.debounceMin} min={0} max={120} suffix="minutes" onCommit={(v) => set({ debounceMin: v })} />
      </Field>
      <Field label="Dry run" hint="Run reviews but don't post them to GitHub. Results show in the app only.">
        <Switch checked={s.dryRun} onChange={(v) => set({ dryRun: v })} label="Dry run" />
      </Field>

      <div className="my-3 border-t border-line" />

      <Field label="Launch at login">
        <Switch checked={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} label="Launch at login" />
      </Field>
      <Field label="Notify when a review">
        <div className="flex items-center gap-5 text-[13px]">
          <label className="flex items-center gap-2">
            <Switch checked={s.notifyPosted} onChange={(v) => set({ notifyPosted: v })} label="Posted" /> is posted
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={s.notifyFailed} onChange={(v) => set({ notifyFailed: v })} label="Failed" /> fails
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
