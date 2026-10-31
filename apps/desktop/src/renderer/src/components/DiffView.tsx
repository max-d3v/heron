import type { DiffFileDto } from "@heron/rpc";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";

/** A unified diff: one collapsible section per file, no syntax highlighting. */
export function DiffView({ files }: { files: DiffFileDto[] }) {
  // Small diffs open in full; big ones start collapsed.
  const lines = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  const startOpen = files.length <= 8 && lines <= 600;
  return (
    <div className="flex flex-col gap-2">
      {files.map((f) => (
        <DiffFileSection key={`${f.oldPath ?? ""}→${f.path}`} file={f} defaultOpen={startOpen} />
      ))}
    </div>
  );
}

function DiffFileSection({ file, defaultOpen }: { file: DiffFileDto; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const label = file.status === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <div className="overflow-hidden rounded-[8px] bg-content shadow-[0_0_0_0.5px_var(--line-strong)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn("flex w-full items-center gap-2 bg-content-2 px-3 py-1.5 text-left hover:bg-hover", open && "border-b border-line")}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
        <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px]">{label}</span>
        {file.status !== "modified" && file.status !== "renamed" && <span className="shrink-0 text-[10.5px] text-fg-3">{file.status}</span>}
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-ok">+{file.additions}</span> <span className="text-bad">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.binary ? (
          <div className="px-3 py-2 text-[12px] text-fg-3">Binary file</div>
        ) : (
          <div className="selectable overflow-x-auto font-mono text-[11.5px] leading-[1.55] [tab-size:4]">
            <table className="w-full border-collapse">
              <tbody>
                {file.hunks.map((h, hi) => [
                  <tr key={`h${hi}`} className="bg-accent-soft/50">
                    <td colSpan={4} className="whitespace-pre px-2 py-0.5 text-fg-3">
                      {h.header}
                    </td>
                  </tr>,
                  ...h.lines.map((l, i) => (
                    <tr key={`${hi}:${i}`} className={cn(l.kind === "add" && "bg-diff-add", l.kind === "del" && "bg-diff-del")}>
                      <td className="w-[1%] select-none whitespace-nowrap px-2 text-right text-fg-3">{l.oldLine ?? ""}</td>
                      <td className="w-[1%] select-none whitespace-nowrap px-2 text-right text-fg-3">{l.newLine ?? ""}</td>
                      <td className="w-[1%] select-none pl-1 text-fg-3">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</td>
                      <td className="whitespace-pre pr-4">{l.text}</td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
