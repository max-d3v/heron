import type { ProfileDto, ProfileInput } from "@heron/rpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, SlidersHorizontal, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { errorText, orpc } from "../lib/rpc";
import { Badge, Button, Confirm, Empty, ErrorNote, Field, Segmented, Select, TextArea, TextField } from "../components/ui";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const NEW_PROFILE: ProfileInput = {
  name: "New profile",
  isDefault: false,
  entry: { type: "prompt", markdown: "Review this pull request. Focus on correctness and security.\n" },
  model: "opus",
  effort: "high",
  timeoutMin: 20,
  maxTurns: 100,
};

export function ProfilesPane() {
  const profiles = useQuery(orpc.profiles.list.queryOptions());
  const [selected, setSelected] = useState<number | "new" | null>(null);
  const current: ProfileInput | null =
    selected === "new" ? NEW_PROFILE : (profiles.data?.find((p) => p.id === selected) ?? profiles.data?.[0] ?? null);

  return (
    <div className="flex h-full">
      <div className="flex w-[220px] shrink-0 flex-col border-r border-line">
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {profiles.data?.map((p) => {
            const active = current && "id" in current && current.id === p.id && selected !== "new";
            return (
              <button
                key={p.id}
                onClick={() => setSelected(p.id)}
                className={cn("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left", active ? "bg-accent text-white" : "hover:bg-hover")}
              >
                <SlidersHorizontal className={cn("size-3.5 shrink-0", active ? "text-white/80" : "text-fg-3")} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
                {p.isDefault && <Star className={cn("size-3 shrink-0", active ? "fill-white text-white" : "fill-caution text-caution")} />}
              </button>
            );
          })}
          {selected === "new" && (
            <div className="flex items-center gap-2 rounded-[6px] bg-accent px-2 py-1.5 text-[13px] text-white">
              <SlidersHorizontal className="size-3.5 text-white/80" />
              New profile
            </div>
          )}
        </div>
        <div className="border-t border-line p-2">
          <Button icon={<Plus className="size-3.5" />} className="w-full" onClick={() => setSelected("new")}>
            New profile
          </Button>
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {current ? (
          <ProfileEditor
            key={selected === "new" ? "new" : (current.id ?? "x")}
            profile={current}
            onSaved={(p) => setSelected(p.id)}
            onDeleted={() => setSelected(null)}
          />
        ) : (
          <Empty title="No profiles" />
        )}
      </div>
    </div>
  );
}

function ProfileEditor({ profile, onSaved, onDeleted }: { profile: ProfileInput; onSaved: (p: ProfileDto) => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ProfileInput>(profile);
  const [customModel, setCustomModel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const models = useQuery({ ...orpc.profiles.models.queryOptions(), staleTime: 10 * 60_000 });
  const skills = useQuery(orpc.skills.list.queryOptions());
  const contract = useQuery({ ...orpc.profiles.outputContract.queryOptions(), staleTime: Infinity });
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.profiles.key() });
  const save = useMutation(orpc.profiles.save.mutationOptions({ onSuccess: (p) => (invalidate(), onSaved(p)) }));
  const remove = useMutation(orpc.profiles.remove.mutationOptions({ onSuccess: () => (invalidate(), onDeleted()) }));
  const makeDefault = useMutation(orpc.profiles.setDefault.mutationOptions({ onSuccess: invalidate }));

  useEffect(() => setDraft(profile), [profile]);

  const modelList = useMemo(() => models.data ?? [], [models.data]);
  const known = modelList.some((m) => m.value === draft.model);
  useEffect(() => {
    if (models.data && !known) setCustomModel(true);
  }, [models.data, known]);

  const efforts = useMemo(() => {
    const m = modelList.find((x) => x.value === draft.model);
    return m && m.efforts.length ? m.efforts : [...EFFORTS];
  }, [modelList, draft.model]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);
  const isNew = draft.id === undefined;
  const set = (p: Partial<ProfileInput>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <div className="mx-auto max-w-[720px] px-6 py-5">
      <div className="mb-3 flex items-center gap-2">
        <TextField value={draft.name} onChange={(e) => set({ name: e.target.value })} className="h-[28px] flex-1 text-[15px] font-semibold" aria-label="Profile name" />
        {profile.isDefault ? (
          <Badge tone="orange">Default</Badge>
        ) : (
          !isNew && (
            <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate({ id: draft.id! })}>
              Make default
            </Button>
          )
        )}
      </div>

      <Field label="Instructions">
        <Segmented
          value={draft.entry.type}
          onChange={(t) =>
            set({
              entry:
                t === "prompt"
                  ? { type: "prompt", markdown: profile.entry.type === "prompt" ? profile.entry.markdown : "" }
                  : { type: "skill", skillId: skills.data?.[0]?.id ?? 0 },
            })
          }
          options={[
            { value: "prompt", label: "Prompt" },
            { value: "skill", label: "Skill" },
          ]}
        />
      </Field>

      {draft.entry.type === "prompt" ? (
        <div className="mb-2 mt-1">
          <TextArea
            value={draft.entry.markdown}
            onChange={(e) => set({ entry: { type: "prompt", markdown: e.target.value } })}
            className="h-[300px]"
            aria-label="Prompt"
          />
        </div>
      ) : (
        <Field label="Skill" hint={skills.data?.length === 0 ? "Import or link a skill in the Skills tab first." : "Heron sends the skill's slash command as the prompt."}>
          <Select
            value={draft.entry.skillId ? String(draft.entry.skillId) : undefined}
            onChange={(v) => set({ entry: { type: "skill", skillId: Number(v) } })}
            placeholder="Choose a skill"
            className="min-w-[260px]"
            options={(skills.data ?? []).map((s) => ({ value: String(s.id), label: s.command, hint: s.source }))}
          />
        </Field>
      )}

      <div className="mb-3 rounded-[8px] bg-content-2 px-3 py-2.5 shadow-[0_0_0_0.5px_var(--line)]">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-2">Output contract (added by Heron)</div>
        <pre className="selectable whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-fg-2">{contract.data ?? "…"}</pre>
      </div>

      <Field label="Model" hint={models.isPending ? "Loading the models your Claude Code offers…" : undefined}>
        <div className="flex items-center gap-2">
          {customModel ? (
            <TextField value={draft.model} onChange={(e) => set({ model: e.target.value })} className="w-[260px] font-mono text-[12px]" placeholder="claude-…" />
          ) : (
            <Select
              value={draft.model}
              onChange={(v) => set({ model: v })}
              className="min-w-[220px]"
              options={(modelList.length ? modelList : [{ value: draft.model, displayName: draft.model, description: "", efforts: [] }]).map((m) => ({
                value: m.value,
                label: m.displayName,
                hint: m.value !== m.displayName.toLowerCase() ? m.value : undefined,
              }))}
            />
          )}
          <Button size="sm" variant="ghost" onClick={() => setCustomModel((v) => !v)}>
            {customModel ? "Pick from list" : "Custom ID…"}
          </Button>
        </div>
      </Field>

      <Field label="Effort">
        <Select
          value={draft.effort ?? "default"}
          onChange={(v) => set({ effort: v === "default" ? null : (v as ProfileInput["effort"]) })}
          options={[{ value: "default", label: "Model default" }, ...efforts.map((e) => ({ value: e, label: e }))]}
        />
      </Field>

      <Field label="Timeout">
        <div className="flex items-center gap-2">
          <TextField
            type="number"
            min={1}
            max={240}
            value={draft.timeoutMin}
            onChange={(e) => set({ timeoutMin: Number(e.target.value) })}
            className="w-[70px] text-right tabular-nums"
          />
          <span className="text-[12px] text-fg-2">minutes</span>
        </div>
      </Field>

      <Field label="Max turns">
        <TextField
          type="number"
          min={1}
          max={1000}
          value={draft.maxTurns}
          onChange={(e) => set({ maxTurns: Number(e.target.value) })}
          className="w-[70px] text-right tabular-nums"
        />
      </Field>

      {(save.error || remove.error) && (
        <div className="mt-2">
          <ErrorNote>{errorText(save.error ?? remove.error)}</ErrorNote>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
        {!isNew && !profile.isDefault && (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
        <div className="flex-1" />
        {dirty && !isNew && <Button onClick={() => setDraft(profile)}>Revert</Button>}
        <Button variant="primary" disabled={!dirty && !isNew} busy={save.isPending} onClick={() => save.mutate(draft)}>
          {isNew ? "Create profile" : "Save"}
        </Button>
      </div>

      <Confirm
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${profile.name}"?`}
        message="Repositories using it fall back to the default profile. Past runs keep their snapshot."
        confirmLabel="Delete"
        danger
        onConfirm={() => remove.mutate({ id: draft.id! })}
      />
    </div>
  );
}
