import { skillName, type SkillDto } from "@heron/rpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus, FileText, FolderOpen, Link, Plus, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { labels } from "../lib/platform";
import { errorText, orpc } from "../lib/rpc";
import { HeaderActions } from "./HeaderActions";
import { Badge, Button, Confirm, Dialog, Empty, ErrorNote, MenuButton, Spinner, TextArea, TextField } from "../components/ui";

export function SkillsPane() {
  const qc = useQueryClient();
  const skills = useQuery(orpc.skills.list.queryOptions());
  const [selected, setSelected] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.skills.key() });
  const importDialog = useMutation(
    orpc.skills.importFromDialog.mutationOptions({
      onSuccess: (s) => {
        void invalidate();
        if (s) setSelected(s.id);
      },
    }),
  );
  const current = skills.data?.find((s) => s.id === selected) ?? skills.data?.[0] ?? null;

  return (
    <div className="flex h-full">
      <div className="flex w-[240px] shrink-0 flex-col border-r border-line">
        {importDialog.error && (
          <div className="border-b border-line p-2">
            <ErrorNote>{errorText(importDialog.error)}</ErrorNote>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {skills.data?.length === 0 && <div className="px-2 py-6 text-center text-[12px] text-fg-3">No skills yet.</div>}
          {skills.data?.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={cn("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left", current?.id === s.id ? "bg-accent text-white" : "hover:bg-hover")}
            >
              <Sparkles className={cn("size-3.5 shrink-0", current?.id === s.id ? "text-white/80" : "text-fg-3")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{s.name}</span>
                <span className={cn("block truncate font-mono text-[10.5px]", current?.id === s.id ? "text-white/70" : "text-fg-3")}>{s.command}</span>
              </span>
              {!s.exists && <TriangleAlert className="size-3.5 text-warn" />}
            </button>
          ))}
        </div>
      </div>
      <HeaderActions>
        <MenuButton
          variant="primary"
          icon={<Plus className="size-3.5" />}
          label="Add skill"
          busy={importDialog.isPending}
          items={[
            { label: "New blank skill…", icon: <FilePlus className="size-3.5" />, onSelect: () => setCreating(true) },
            { label: "Import folder…", icon: <FolderOpen className="size-3.5" />, onSelect: () => importDialog.mutate({}) },
            { label: "Link from ~/.claude/skills…", icon: <Link className="size-3.5" />, onSelect: () => setLinking(true) },
          ]}
        />
      </HeaderActions>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {current ? (
          <SkillEditor key={current.id} skill={current} onRemoved={() => setSelected(null)} />
        ) : (
          <Empty icon={<Sparkles className="size-8" />} title="Use a skill as a review profile">
            Start a blank skill and write it here, import a skill folder (copied into Heron, editable here) or link one from ~/.claude/skills (used in place). Then pick it in a profile.
          </Empty>
        )}
      </div>
      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(s) => {
          void invalidate();
          setSelected(s.id);
        }}
      />
      <LinkDialog
        open={linking}
        onOpenChange={setLinking}
        onLinked={(s) => {
          void invalidate();
          setSelected(s.id);
        }}
      />
    </div>
  );
}

function SkillEditor({ skill, onRemoved }: { skill: SkillDto; onRemoved: () => void }) {
  const qc = useQueryClient();
  const files = useQuery(orpc.skills.files.queryOptions({ input: { id: skill.id } }));
  const [md, setMd] = useState("");
  const [confirm, setConfirm] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.skills.key() });
  const save = useMutation(orpc.skills.writeSkillMd.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(orpc.skills.remove.mutationOptions({ onSuccess: () => (invalidate(), onRemoved()) }));
  const reveal = useMutation(orpc.skills.reveal.mutationOptions());

  useEffect(() => {
    if (files.data) setMd(files.data.skillMd);
  }, [files.data]);

  const dirty = files.data ? md !== files.data.skillMd : false;

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-6 py-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">{skill.name}</span>
            <Badge tone={skill.source === "imported" ? "purple" : "blue"}>{skill.source}</Badge>
          </div>
          <div className="mt-0.5 font-mono text-[11.5px] text-fg-2">{skill.command}</div>
          {skill.description && <div className="mt-1 text-[12px] text-fg-2">{skill.description}</div>}
          <div className="mt-1 text-[11px] text-fg-3">
            {skill.usedBy.length ? `Used by ${skill.usedBy.join(", ")}` : "Not used by any profile"} · hash {skill.contentHash.slice(0, 10)}
          </div>
        </div>
        <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => reveal.mutate({ id: skill.id })}>
          {labels.showInFileManager}
        </Button>
      </div>

      {!skill.exists && <ErrorNote>SKILL.md is missing at {skill.path}. Runs using this skill will fail.</ErrorNote>}

      {files.isPending ? (
        <Spinner />
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-fg-2">SKILL.md</span>
            {!files.data?.editable && <span className="text-[11px] text-fg-3">Linked skills are edited where they live.</span>}
          </div>
          <TextArea value={md} onChange={(e) => setMd(e.target.value)} readOnly={!files.data?.editable} className="h-[360px]" aria-label="SKILL.md" />
          {save.error && <ErrorNote>{errorText(save.error)}</ErrorNote>}
          {files.data?.editable && (
            <div className="flex justify-end gap-2">
              {dirty && <Button onClick={() => setMd(files.data!.skillMd)}>Revert</Button>}
              <Button variant="primary" disabled={!dirty} busy={save.isPending} onClick={() => save.mutate({ id: skill.id, content: md })}>
                Save SKILL.md
              </Button>
            </div>
          )}
          {files.data && files.data.files.length > 1 && (
            <div>
              <div className="mb-1 text-[12px] font-medium text-fg-2">Other files (view in {labels.fileManager})</div>
              <div className="rounded-[8px] bg-content-2 py-1 shadow-[0_0_0_0.5px_var(--line)]">
                {files.data.files
                  .filter((f) => f !== "SKILL.md")
                  .map((f) => (
                    <div key={f} className="flex items-center gap-2 px-3 py-[3px] font-mono text-[11.5px] text-fg-2">
                      <FileText className="size-3.5 text-fg-3" />
                      {f}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-2 border-t border-line pt-4">
        {remove.error && (
          <div className="mb-2">
            <ErrorNote>{errorText(remove.error)}</ErrorNote>
          </div>
        )}
        <Button variant="danger" onClick={() => setConfirm(true)}>
          {skill.source === "imported" ? "Delete skill…" : "Unlink skill…"}
        </Button>
      </div>
      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title={skill.source === "imported" ? `Delete ${skill.name}?` : `Unlink ${skill.name}?`}
        message={skill.source === "imported" ? "Heron's copy of the skill is deleted." : "The skill stays in ~/.claude/skills; Heron just stops listing it."}
        confirmLabel={skill.source === "imported" ? "Delete" : "Unlink"}
        danger
        onConfirm={() => remove.mutate({ id: skill.id })}
      />
    </div>
  );
}

function CreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (s: SkillDto) => void }) {
  const [name, setName] = useState("");
  const create = useMutation(
    orpc.skills.create.mutationOptions({
      onSuccess: (s) => {
        onCreated(s);
        onOpenChange(false);
      },
    }),
  );
  useEffect(() => {
    if (open) {
      setName("");
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const trimmed = name.trim();
  const parsed = skillName.safeParse(name);
  const valid = parsed.success;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New blank skill"
      description="Creates an empty SKILL.md in Heron for you to write in."
      width={420}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-skill" disabled={!valid} busy={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form
        id="create-skill"
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed.success && !create.isPending) create.mutate({ name: parsed.data });
        }}
      >
        <TextField
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="skill-name"
          aria-label="Skill name"
          spellCheck={false}
          className="h-[28px] w-full font-mono"
        />
        <div className="text-[11.5px] text-fg-3">
          {trimmed && !valid ? "Use letters, digits, - and _." : <>Profiles run it as <span className="font-mono">/heron:{trimmed || "skill-name"}</span>.</>}
        </div>
        {create.error && <ErrorNote>{errorText(create.error)}</ErrorNote>}
      </form>
    </Dialog>
  );
}

function LinkDialog({ open, onOpenChange, onLinked }: { open: boolean; onOpenChange: (v: boolean) => void; onLinked: (s: SkillDto) => void }) {
  const linkable = useQuery({ ...orpc.skills.linkable.queryOptions(), enabled: open });
  const link = useMutation(
    orpc.skills.link.mutationOptions({
      onSuccess: (s) => {
        onLinked(s);
        onOpenChange(false);
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Link a skill" description="Skills in ~/.claude/skills are used in place, not copied.">
      {link.error && (
        <div className="mb-2">
          <ErrorNote>{errorText(link.error)}</ErrorNote>
        </div>
      )}
      {linkable.isPending ? (
        <Spinner />
      ) : !linkable.data?.length ? (
        <div className="py-6 text-center text-[12px] text-fg-3">No skills found in ~/.claude/skills.</div>
      ) : (
        <div className="max-h-[360px] overflow-y-auto rounded-[8px] shadow-[0_0_0_0.5px_var(--line-strong)]">
          {linkable.data.map((s) => (
            <div key={s.name} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{s.name}</div>
                {s.description && <div className="line-clamp-2 text-[11.5px] text-fg-3">{s.description}</div>}
              </div>
              {s.linked ? (
                <span className="text-[11.5px] text-fg-3">Linked</span>
              ) : (
                <Button size="sm" onClick={() => link.mutate({ name: s.name })}>
                  Link
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
