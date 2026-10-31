import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Copy, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import { errorText, orpc } from "../lib/rpc";
import { Button, ErrorNote, Spinner } from "./ui";

/** git, gh and claude: installed and logged in, each with a fix hint (§12). Non-blocking checks fail as warnings (§17.8). */
export function DoctorList({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const report = useQuery(orpc.doctor.get.queryOptions());
  const check = useMutation(
    orpc.doctor.check.mutationOptions({
      onSuccess: (r) => {
        qc.setQueryData(orpc.doctor.get.queryKey(), r);
        void qc.invalidateQueries({ queryKey: orpc.prs.key() });
      },
    }),
  );
  const data = check.data ?? report.data;

  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-1.5" : "gap-2")}>
      {!data ? (
        <div className="flex items-center gap-2 text-[12px] text-fg-2">
          <Spinner /> Checking…
        </div>
      ) : (
        data.checks.map((c) => (
          <div key={c.id} className={cn("flex items-start gap-2.5", !compact && "rounded-[10px] bg-content-2 px-3.5 py-2.5 shadow-[0_0_0_0.5px_var(--line)]")}>
            {c.ok ? (
              <CircleCheck className="mt-[1px] size-4 shrink-0 text-ok" />
            ) : c.blocking ? (
              <CircleX className="mt-[1px] size-4 shrink-0 text-bad" />
            ) : (
              <TriangleAlert className="mt-[1px] size-4 shrink-0 text-warn" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{c.label}</div>
              <div className="selectable text-[11.5px] text-fg-2">{c.detail}</div>
              {!c.ok && c.fix && <FixHint text={c.fix} />}
            </div>
          </div>
        ))
      )}
      {check.error && <ErrorNote>{errorText(check.error)}</ErrorNote>}
      <div>
        <Button size={compact ? "sm" : "md"} icon={<RotateCw className="size-3.5" />} busy={check.isPending} onClick={() => check.mutate({})}>
          Check again
        </Button>
      </div>
    </div>
  );
}

function FixHint({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <code className="selectable min-w-0 flex-1 truncate rounded-[5px] bg-field px-2 py-1 font-mono text-[11.5px]">{text}</code>
      <button
        aria-label="Copy"
        className="rounded-[5px] p-1 text-fg-3 hover:bg-hover hover:text-fg"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <CircleCheck className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** First run: nothing else works until the tools are ready. */
export function DoctorScreen() {
  return (
    <div className="flex h-full flex-col bg-content">
      <div className="drag h-[52px] shrink-0" />
      <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col items-center px-6 pt-6">
        <img src="./heron.png" alt="" className="size-20" />
        <h1 className="mt-3 text-[20px] font-semibold tracking-[-0.01em]">Welcome to Heron</h1>
        <p className="mt-1.5 text-center text-[13px] text-fg-2">
          Heron reviews pull requests with your own Claude subscription. It needs git, the GitHub CLI and Claude Code, all logged in.
        </p>
        <div className="mt-6 w-full">
          <DoctorList />
        </div>
      </div>
    </div>
  );
}
