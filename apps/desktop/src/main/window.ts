import { BrowserWindow, nativeTheme, session, shell } from "electron";
import { join } from "node:path";
import { rendererArgs, setUpWindow, windowChrome } from "./platform.ts";

const isDev = !!process.env.ELECTRON_RENDERER_URL;

export function installCsp(): void {
  const csp = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com https://*.githubusercontent.com",
    "font-src 'self' data:",
    isDev ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
}

export function createMainWindow(preloadDir: string, rendererDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 860,
    minHeight: 520,
    show: false,
    title: "Heron",
    ...windowChrome(),
    webPreferences: {
      preload: join(preloadDir, "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: rendererArgs,
    },
  });

  win.once("ready-to-show", () => win.show());
  setUpWindow(win);

  // Never navigate the app window away; links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else void win.loadFile(join(rendererDir, "index.html"));

  nativeTheme.themeSource = "system";
  return win;
}
