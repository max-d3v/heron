import type { UpdateStatus } from "@heron/rpc";
import { useMutation } from "@tanstack/react-query";
import { ArrowDownToLine } from "lucide-react";
import type { ReactNode } from "react";
import { ago } from "../lib/format";
import { useNow, useStream } from "../lib/hooks";
import { labels } from "../lib/platform";
import { client, errorText, orpc } from "../lib/rpc";
import { Button, Spinner, Tooltip } from "./ui";

/** Heron's own update (§13.1), live from the main process. */
export function useUpdateStatus(): UpdateStatus | null {
  return useStream<UpdateStatus>("update", (signal) => client.updates.status(undefined, { signal }), "latest").latest;
}

/** In the sidebar's footer once an update is downloaded. */
export function UpdateButton() {
  const status = useUpdateStatus();
  const install = useMutation(orpc.updates.install.mutationOptions());
  if (status?.state !== "ready") return null;
  return (
    <Tooltip content={install.error ? errorText(install.error) : `Heron ${status.version} is downloaded. ${labels.installUpdateHint}`} side="top">
      <button
        disabled={install.isPending}
        onClick={() => install.mutate({})}
        className="flex h-[22px] items-center gap-1.5 rounded-[6px] bg-accent-soft px-2.5 text-[11.5px] font-medium text-accent hover:brightness-110 disabled:opacity-60"
      >
        <ArrowDownToLine className="size-3.5" />
        {labels.installUpdate}
      </button>
    </Tooltip>
  );
}

/** Settings → General, under the version: where the update stands, and Check for Updates. */
export function UpdateRow() {
  const status = useUpdateStatus();
  const now = useNow(30_000);
  const check = useMutation(orpc.updates.check.mutationOptions());
  const install = useMutation(orpc.updates.install.mutationOptions());
  if (!status) return null;

  const checkButton = (label: string) => (
    <Button size="sm" busy={check.isPending} onClick={() => check.mutate({})}>
      {label}
    </Button>
  );
  let text: ReactNode;
  let action: ReactNode = null;
  switch (status.state) {
    case "off":
      text = "Development build: only installed copies update.";
      break;
    case "idle":
      text = status.checkedAt ? `Up to date · checked ${ago(status.checkedAt, now)}` : "Heron checks for updates every few hours.";
      action = checkButton("Check for Updates");
      break;
    case "checking":
      text = (
        <span className="flex items-center gap-1.5">
          <Spinner className="size-3" /> Checking for updates…
        </span>
      );
      break;
    case "downloading":
      text = (
        <span className="flex items-center gap-1.5">
          <Spinner className="size-3" /> Downloading Heron {status.version}… {status.percent}%
        </span>
      );
      break;
    case "ready":
      text = `Heron ${status.version} is downloaded. ${labels.installUpdateHint}`;
      action = (
        <Button size="sm" variant="primary" busy={install.isPending} onClick={() => install.mutate({})}>
          {labels.installUpdate}
        </Button>
      );
      break;
    case "error":
      text = <span className="text-bad">Couldn't update: {status.message}</span>;
      action = checkButton("Try Again");
      break;
  }
  return (
    <div className="mt-1 flex flex-col items-start gap-1.5 text-[12px] text-fg-2">
      <span className="selectable">{text}</span>
      {action}
      {install.error && <span className="text-bad">{errorText(install.error)}</span>}
    </div>
  );
}
