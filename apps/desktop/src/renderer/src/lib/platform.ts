/** Set on <html> by the preload, which the CSS keys off too (§17.2). */
export const isWindows = document.documentElement.dataset.platform === "win32";

/** The few labels that differ on Windows (§17.8). */
export const labels = isWindows
  ? { settingsShortcut: "Ctrl+,", showInFileManager: "Show in Explorer", fileManager: "Explorer", thisComputer: "this computer" }
  : { settingsShortcut: "⌘,", showInFileManager: "Show in Finder", fileManager: "Finder", thisComputer: "this Mac" };
