import { FolderGit2, Settings as Gear, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { Dialog as RDialog } from "radix-ui";
import { useState } from "react";
import { cn } from "../lib/cn";
import { GeneralPane } from "./GeneralPane";
import { HeaderSlot } from "./HeaderActions";
import { ProfilesPane } from "./ProfilesPane";
import { ReposPane } from "./ReposPane";
import { SkillsPane } from "./SkillsPane";

export type SettingsTab = "repos" | "profiles" | "skills" | "general";

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Gear }> = [
  { id: "repos", label: "Repos", icon: FolderGit2 },
  { id: "profiles", label: "Profiles", icon: SlidersHorizontal },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "general", label: "General", icon: Gear },
];

/**
 * Settings: a large modal over the main window, with its sections in a sidebar. Being a Radix
 * dialog, Escape closes whatever is on top first (a select, a nested dialog), then the modal.
 * It is open while `tab` is set, and stays mounted when closed so the closing animation can play.
 */
export function Settings({ tab: openTab, onTab, onClose }: { tab: SettingsTab | null; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  // The section to show: the open one, or while closing, the one that was open.
  const [tab, setTab] = useState<SettingsTab>(openTab ?? "repos");
  if (openTab && openTab !== tab) setTab(openTab);
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <RDialog.Root open={openTab !== null} onOpenChange={(open) => !open && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay data-overlay className="settings-overlay fixed inset-0 z-30 bg-black/30" />
        <RDialog.Content
          aria-describedby={undefined}
          className="settings-modal fixed left-1/2 top-1/2 z-30 flex h-[min(760px,calc(100vh-80px))] w-[min(1080px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[12px] bg-content shadow-pop outline-none"
        >
          <nav className="flex w-[184px] shrink-0 flex-col gap-0.5 border-r border-line bg-content-2 p-2">
            <RDialog.Title className="px-2 pb-2 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-3">Settings</RDialog.Title>
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => onTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className={cn(
                  "flex h-[30px] w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px]",
                  tab === t.id ? "bg-selected font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
                )}
              >
                <t.icon className={cn("size-4 shrink-0", tab === t.id ? "text-accent" : "text-fg-3")} strokeWidth={1.7} />
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-[44px] shrink-0 items-center gap-2 border-b border-line pl-5 pr-3">
              <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{current.label}</h2>
              <div ref={setSlot} className="flex shrink-0 items-center gap-1.5" />
              <RDialog.Close aria-label="Close settings" className="flex size-7 items-center justify-center rounded-[6px] text-fg-2 hover:bg-hover hover:text-fg">
                <X className="size-4" />
              </RDialog.Close>
            </div>
            <HeaderSlot value={slot}>
              <div className="min-h-0 flex-1">
                {tab === "repos" && <ReposPane />}
                {tab === "profiles" && <ProfilesPane />}
                {tab === "skills" && <SkillsPane />}
                {tab === "general" && (
                  <div className="h-full overflow-y-auto">
                    <GeneralPane />
                  </div>
                )}
              </div>
            </HeaderSlot>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
