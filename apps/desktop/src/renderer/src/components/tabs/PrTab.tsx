import type { PrDetail } from "@heron/rpc";
import { useQuery } from "@tanstack/react-query";
import { errorText, orpc } from "../../lib/rpc";
import { Markdown } from "../Markdown";
import { ErrorNote, Spinner } from "../ui";

const STATUS: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "" };

export function PrTab({ pr }: { pr: PrDetail }) {
  const files = useQuery(orpc.prs.files.queryOptions({ input: { id: pr.id } }));
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5 px-5 py-4">
      <article className="rounded-[10px] bg-content px-5 py-4 shadow-[0_0_0_0.5px_var(--line-strong)]">
        {pr.body.trim() ? <Markdown>{pr.body}</Markdown> : <div className="text-[12.5px] italic text-fg-3">No description.</div>}
      </article>

      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-fg-2">Changed files</h2>
          {files.data && (
            <span className="text-[11.5px] text-fg-3">
              {files.data.length} files ·{" "}
              <span className="text-ok">+{files.data.reduce((n, f) => n + f.additions, 0)}</span>{" "}
              <span className="text-bad">−{files.data.reduce((n, f) => n + f.deletions, 0)}</span>
            </span>
          )}
        </div>
        {files.isPending ? (
          <Spinner />
        ) : files.isError ? (
          <ErrorNote>{errorText(files.error)}</ErrorNote>
        ) : (
          <div className="overflow-hidden rounded-[8px] bg-content shadow-[0_0_0_0.5px_var(--line-strong)]">
            {files.data.map((f) => {
              const total = f.additions + f.deletions;
              const addW = total ? Math.round((f.additions / total) * 5) : 0;
              return (
                <div key={f.path} className="flex items-center gap-3 border-b border-line px-3 py-[5px] last:border-b-0">
                  <span className="w-3 shrink-0 text-center font-mono text-[10.5px] text-fg-3">{STATUS[f.status] ?? "?"}</span>
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px]" title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}>
                    {f.path}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums">
                    <span className="text-ok">+{f.additions}</span> <span className="text-bad">−{f.deletions}</span>
                  </span>
                  <span className="flex shrink-0 gap-px">
                    {Array.from({ length: 5 }, (_, i) => (
                      <span key={i} className={i < addW ? "size-[7px] rounded-[1px] bg-ok" : total ? "size-[7px] rounded-[1px] bg-bad" : "size-[7px] rounded-[1px] bg-field"} />
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
