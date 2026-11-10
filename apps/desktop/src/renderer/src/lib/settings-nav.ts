import { createContext, useContext } from "react";
import type { SettingsTab } from "../settings/Settings";

/** Where Settings opens: a tab, and on Repos optionally a repo and one of its fields scrolled into view. */
export interface SettingsTarget {
  tab: SettingsTab;
  repoId?: number;
  field?: "iterationAutoPush";
}

/** DOM id of a repo field Settings can open on. */
export const REPO_FIELD_ID = { iterationAutoPush: "repo-iteration-auto-push" } as const;

export const OpenSettingsContext = createContext<(target: SettingsTarget) => void>(() => {});

/** Opens Settings from anywhere under the app. */
export function useOpenSettings(): (target: SettingsTarget) => void {
  return useContext(OpenSettingsContext);
}
