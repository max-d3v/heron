import { FolderGit2, Settings as Gear, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "../lib/cn";
import { GeneralPane } from "./GeneralPane";
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

/** Settings, laid out like a macOS settings window (toolbar tabs) over the main window. */
export function Settings({ tab, onTab, onClose }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog],[role=alertdialog],[data-radix-popper-content-wrapper]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-content">
      <div className="drag relative flex h-[76px] shrink-0 items-end justify-center border-b border-line bg-content-2 pb-1.5">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              className={cn(
                "flex w-[72px] flex-col items-center gap-0.5 rounded-[7px] px-2 py-1 text-[11px]",
                tab === t.id ? "bg-selected text-accent" : "text-fg-2 hover:bg-hover hover:text-fg",
              )}
            >
              <t.icon className="size-[19px]" strokeWidth={1.6} />
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          aria-label="Close settings"
          className="absolute right-3 top-3 rounded-[6px] p-1 text-fg-2 hover:bg-hover hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </div>
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
    </div>
  );
}
