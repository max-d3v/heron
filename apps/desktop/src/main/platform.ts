import { Menu, Notification, app, nativeImage, nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions, type NativeImage } from "electron";
import { homedir, release } from "node:os";
import { join } from "node:path";

// The Electron differences between macOS and Windows (§17.2, §17.8): data folder, window chrome,
// app menu, tray icons, taskbar badge, login item and notifications. The Node-level ones live in
// @heron/platform; nothing else in the main process asks which OS it's on.

export const isWindows = process.platform === "win32";

/** Windows 11 22H2 (build 22621) and later draw Mica behind the window, as vibrancy does on macOS. */
const mica = isWindows && Number(release().split(".")[2] ?? 0) >= 22621;

/** The height of the drag region at the top of the window, which Windows' window buttons match. */
const TITLE_BAR_HEIGHT = 52;

/** Started by launch at login on Windows: run without showing the window. */
export const startedHidden = process.argv.includes("--hidden");

/**
 * Where Heron keeps its data: Application Support/Heron on macOS. On Windows %LOCALAPPDATA%\Heron
 * rather than Electron's default under the roaming %APPDATA%: clones, worktrees and node_modules
 * mustn't roam with the profile, and the database is no use without them (§17.7).
 */
export function dataRoot(): string {
  if (!isWindows) return join(app.getPath("appData"), "Heron");
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Heron");
}

/** At startup. Windows attributes toasts to the app by this id (the installer's shortcut carries it), and clicks reach it. */
export function initPlatform(): void {
  if (isWindows) app.setAppUserModelId("dev.heron.desktop");
}

// ── window ──────────────────────────────────────────────────────────────────

/** The content area's background in the current theme; must match `--content` in styles.css. */
function contentColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#1e1e1f" : "#ffffff";
}

/** Windows' window buttons in the colors of the content they sit on (`--content` and `--fg` in styles.css). */
function titleBarOverlay(): Electron.TitleBarOverlay {
  return { color: contentColor(), symbolColor: nativeTheme.shouldUseDarkColors ? "#e0e0e0" : "#202020", height: TITLE_BAR_HEIGHT };
}

/**
 * macOS: inset traffic lights and sidebar vibrancy. Windows: its own buttons drawn over the top
 * right, and Mica behind the transparent sidebar where Windows has it; solid backgrounds on Windows 10.
 */
export function windowChrome(): BrowserWindowConstructorOptions {
  if (!isWindows) {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
    };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlay(),
    ...(mica ? { backgroundMaterial: "mica", backgroundColor: "#00000000" } : { backgroundColor: contentColor() }),
  };
}

/** Command-line flags the preload turns into attributes on <html> for the CSS. */
export const rendererArgs: string[] = mica ? ["--heron-mica"] : [];

/** Windows: keep the window buttons in step with light and dark mode, and give dev builds reload and devtools without a menu. */
export function setUpWindow(win: BrowserWindow): void {
  if (!isWindows) return;
  const onTheme = () => {
    if (win.isDestroyed()) return;
    win.setTitleBarOverlay(titleBarOverlay());
    if (!mica) win.setBackgroundColor(contentColor());
  };
  nativeTheme.on("updated", onTheme);
  win.on("closed", () => nativeTheme.off("updated", onTheme));

  if (app.isPackaged) return;
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt) return;
    const key = input.key.toLowerCase();
    if (key === "r" && !input.shift) {
      event.preventDefault();
      win.webContents.reload();
    } else if (key === "i" && input.shift) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
}

/**
 * The running count on the window's taskbar button, from the bundled 1–9 and 9+ images. Windows
 * only; macOS shows the count next to the menu bar icon instead.
 */
export function setRunningBadge(win: BrowserWindow, running: number, resourcesDir: string): void {
  if (!isWindows || win.isDestroyed()) return;
  if (running <= 0) {
    win.setOverlayIcon(null, "");
    return;
  }
  const image = nativeImage.createFromPath(join(resourcesDir, "win", running > 9 ? "badge9plus.png" : `badge${running}.png`));
  win.setOverlayIcon(image, `${running} running`);
}

/**
 * Closing the window keeps Heron running. On Windows, the first time, a notification says so and
 * how to keep the tray icon in view (§17.8). Returns whether it was shown, so it's shown once.
 */
export function showTrayHint(onClick: () => void): boolean {
  if (!isWindows || !Notification.isSupported()) return false;
  const note = new Notification({
    title: "Heron is still running",
    body: "It keeps working from the system tray. To keep its icon in view, drag it from the hidden icons (^) onto the taskbar.",
  });
  note.on("click", onClick);
  note.show();
  return true;
}

// ── menus ───────────────────────────────────────────────────────────────────

/**
 * macOS: the app menu, with Settings on ⌘,. Windows: none, so there's no File/Edit bar; the
 * renderer handles Ctrl+, and Quit is in the tray menu.
 */
export function installAppMenu(openSettings: () => void): void {
  if (isWindows) {
    Menu.setApplicationMenu(null);
    return;
  }
  const isDev = !app.isPackaged;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Heron",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Settings…", accelerator: "Command+,", click: openSettings },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          ...(isDev ? ([{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }] as const) : []),
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

// ── tray ────────────────────────────────────────────────────────────────────

export interface TrayIcons {
  idle: NativeImage;
  running: NativeImage;
  paused: NativeImage;
}

/**
 * macOS: template images the menu bar colors to match (running looks like idle; the count is the
 * icon's title). Windows doesn't recolor templates, so it gets colored icons, one per state.
 */
export function trayIcons(resourcesDir: string): TrayIcons {
  if (isWindows) {
    const icon = (name: string) => nativeImage.createFromPath(join(resourcesDir, "win", `${name}.png`));
    return { idle: icon("trayIdle"), running: icon("trayRunning"), paused: icon("trayPaused") };
  }
  const template = (name: string) => {
    const image = nativeImage.createFromPath(join(resourcesDir, `${name}.png`));
    image.setTemplateImage(true);
    return image;
  };
  const idle = template("trayTemplate");
  return { idle, running: idle, paused: template("trayPausedTemplate") };
}

/** How the tray differs: Windows opens the window on a left click (the menu is on right-click) and has no icon title or ⌘Q. */
export const trayBehavior = isWindows
  ? { openOnClick: true, showsTitle: false, quitAccelerator: undefined }
  : { openOnClick: false, showsTitle: true, quitAccelerator: "Command+Q" };

// ── login item ──────────────────────────────────────────────────────────────

/** Windows registers with --hidden, so Heron starts in the tray; the arguments must match to read the setting back. */
const loginArgs = isWindows ? { args: ["--hidden"] } : {};

export const loginItem = {
  get: (): boolean => app.getLoginItemSettings(isWindows ? loginArgs : undefined).openAtLogin,
  set: (openAtLogin: boolean): void => app.setLoginItemSettings({ openAtLogin, ...loginArgs }),
};
