/**
 * From the user agent, not <html data-platform>: the preload can only set that at DOMContentLoaded,
 * after this module has run. The CSS keys off the attribute (§17.2).
 */
export const isWindows = navigator.userAgent.includes("Windows");

/** The few labels that differ on Windows (§17.8). */
export const labels = isWindows
  ? { settingsShortcut: "Ctrl+,", showInFileManager: "Show in Explorer", fileManager: "Explorer", thisComputer: "this computer" }
  : { settingsShortcut: "⌘,", showInFileManager: "Show in Finder", fileManager: "Finder", thisComputer: "this Mac" };
