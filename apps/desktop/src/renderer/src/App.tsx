import type { PrListItem, QueueStatusDto } from "@heron/rpc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "./components/Banner";
import { DoctorScreen } from "./components/Doctor";
import { PrDetail, type Tab } from "./components/PrDetail";
import { Sidebar } from "./components/Sidebar";
import { Empty, TooltipProvider } from "./components/ui";
import { useStream } from "./lib/hooks";
import { client, orpc } from "./lib/rpc";
import { isListed } from "./lib/visibility";
import { Settings, type SettingsTab } from "./settings/Settings";

export function App() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [requestedTab, setRequestedTab] = useState<{ tab: Tab; at: number } | null>(null);

  const prs = useStream<PrListItem[]>("prs", (signal) => client.prs.watch(undefined, { signal }), "latest");
  const queue = useStream<QueueStatusDto>("queue", (signal) => client.queue.status(undefined, { signal }), "latest").latest;
  const doctor = useQuery({ ...orpc.doctor.get.queryOptions(), refetchInterval: (q) => (q.state.data ? false : 1000) });
  const repos = useQuery(orpc.repos.list.queryOptions());
  const list = prs.latest;
  const listed = useMemo(() => (list ?? []).filter((p) => isListed(p, showAll)), [list, showAll]);
  const hiddenCount = (list?.length ?? 0) - (list ?? []).filter((p) => isListed(p, false)).length;

  // Live updates: whenever the PR list changes, refresh what the detail view shows.
  useEffect(() => {
    if (!list) return;
    void qc.invalidateQueries({ queryKey: orpc.prs.get.key() });
    void qc.invalidateQueries({ queryKey: orpc.reviews.key() });
    void qc.invalidateQueries({ queryKey: orpc.iterations.key() });
  }, [list, qc]);

  const pauseReasons = queue?.reasons.join(",");
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: orpc.doctor.key() });
  }, [pauseReasons, qc]);

  // Keep the selection on a PR the sidebar lists; with none listed, select nothing.
  useEffect(() => {
    if (!list) return;
    if (selected !== null && listed.some((p) => p.id === selected)) return;
    setSelected(listed[0]?.id ?? null);
  }, [list, listed, selected]);

  const openSettings = useCallback((tab: SettingsTab = "repos") => setSettingsTab(tab), []);

  // Navigation from the tray, notifications and the app menu; config changes made elsewhere.
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        for await (const e of await client.app.events(undefined, { signal: ac.signal })) {
          if (e.kind === "openPr") {
            setSettingsTab(null);
            setSelected(e.prId);
            setRequestedTab(e.tab ? { tab: e.tab, at: Date.now() } : null);
          } else if (e.kind === "openSettings") {
            setSettingsTab((t) => t ?? "repos");
          } else {
            void qc.invalidateQueries({ queryKey: orpc[e.what].key() });
          }
        }
      } catch {
        // stream closed
      }
    })();
    return () => ac.abort();
  }, [qc]);

  if (!doctor.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-content">
        <div className="drag absolute inset-x-0 top-0 h-[52px]" />
        <img src="./heron.png" alt="" className="pulse size-16" />
        <div className="text-[12px] text-fg-2">Checking git, gh and claude…</div>
      </div>
    );
  }

  if (!doctor.data.ok && (repos.data?.length ?? 0) === 0) return <DoctorScreen />;

  return (
    <TooltipProvider delayDuration={500}>
      <div className="relative flex h-full">
        <Sidebar
          prs={list ?? []}
          loading={!list}
          selectedId={selected}
          onSelect={(id) => {
            setSelected(id);
            setRequestedTab(null);
          }}
          onOpenSettings={() => openSettings()}
          queue={queue}
          showAll={showAll}
          onShowAllChange={setShowAll}
        />
        <main className="flex min-w-0 flex-1 flex-col bg-content">
          <Banner queue={queue} onOpenSetup={() => openSettings("general")} />
          <div className="min-h-0 flex-1">
            {selected !== null ? (
              <PrDetail key={selected} prId={selected} requestedTab={requestedTab} />
            ) : (
              <div className="relative h-full">
                <div className="drag absolute inset-x-0 top-0 h-[52px]" />
                {(repos.data?.length ?? 0) === 0 ? (
                  <Empty icon={<GitPullRequest className="size-8" />} title="Add a repository to get started">
                    <button className="text-accent hover:underline" onClick={() => openSettings("repos")}>
                      Open Settings → Repos
                    </button>
                  </Empty>
                ) : listed.length === 0 ? (
                  <Empty icon={<GitPullRequest className="size-8" />} title="No PRs in scope">
                    PRs show up here when they're in a repo's scope or have been reviewed.
                    {hiddenCount > 0 && (
                      <button className="mt-1 block w-full text-accent hover:underline" onClick={() => setShowAll(true)}>
                        Show {hiddenCount} other open PR{hiddenCount === 1 ? "" : "s"}
                      </button>
                    )}
                  </Empty>
                ) : (
                  <Empty icon={<GitPullRequest className="size-8" />} title="Select a pull request" />
                )}
              </div>
            )}
          </div>
        </main>
        {settingsTab && <Settings tab={settingsTab} onTab={setSettingsTab} onClose={() => setSettingsTab(null)} />}
      </div>
    </TooltipProvider>
  );
}
