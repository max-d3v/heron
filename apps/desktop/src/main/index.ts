import { Menu, Notification, app, dialog, ipcMain, powerMonitor, shell, type BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RPCHandler } from "@orpc/server/message-port";
import { AuthError, DEFAULT_PROFILE, EFFORT_LEVELS, MODEL_ALIASES, type Settings } from "@heron/core";
import { HeronDb } from "@heron/db";
import { GitClient } from "@heron/git";
import { GitHubClient, ghAuthToken } from "@heron/github";
import { probeClaude } from "@heron/harness";
import type { DoctorReport, ModelOption } from "@heron/rpc";
import { createBus } from "./bus.ts";
import { runDoctor } from "./doctor.ts";
import { loadShellEnv, resolveBinaries, type Binaries } from "./env.ts";
import { ensureLayout, makePaths } from "./paths.ts";
import { Pipeline } from "./pipeline.ts";
import { Poller } from "./poller.ts";
import { DEFAULT_PROMPT } from "./prompts.ts";
import { createRouter } from "./router.ts";
import { Scheduler } from "./scheduler.ts";
import { SkillService } from "./skills.ts";
import { Store } from "./store.ts";
import { HeronTray } from "./tray.ts";
import { createMainWindow, installCsp } from "./window.ts";

app.setName("Heron");
// HERON_DATA_DIR keeps a development copy apart from the real data.
app.setPath("userData", process.env.HERON_DATA_DIR ?? join(app.getPath("appData"), "Heron"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const preloadDir = join(here, "../preload");
  const rendererDir = join(here, "../renderer");

  await app.whenReady();
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
  if (!app.isPackaged) app.dock?.setIcon(join(resourcesDir, "icon.png"));

  const version = app.getVersion();
  const paths = makePaths(app.getPath("userData"));
  ensureLayout(paths, version);

  const db = new HeronDb(paths.db);
  if (db.listProfiles().length === 0) {
    db.saveProfile({
      name: "Default",
      isDefault: true,
      entry: { type: "prompt", markdown: DEFAULT_PROMPT },
      model: "opus",
      effort: "high",
      timeoutMin: DEFAULT_PROFILE.timeoutMin,
      maxTurns: DEFAULT_PROFILE.maxTurns,
    });
  }

  const bus = createBus();
  const store = new Store(db, bus);
  let env: NodeJS.ProcessEnv = await loadShellEnv();
  let bins: Binaries = resolveBinaries(env);
  let doctorReport: DoctorReport | null = null;
  let viewerLogin: string | null = null;

  const github = new GitHubClient({
    getToken: () => (bins.gh ? ghAuthToken(bins.gh, env) : Promise.reject(new AuthError("github", "The GitHub CLI (gh) isn't installed"))),
    userAgent: `heron/${version}`,
  });
  const git = new GitClient({
    gitPath: () => bins.git ?? "/usr/bin/git",
    env: () => env,
    getToken: () => (bins.gh ? ghAuthToken(bins.gh, env) : Promise.reject(new AuthError("github", "The GitHub CLI (gh) isn't installed"))),
  });
  const skills = new SkillService(db, paths);
  const settings = () => db.getSettings();

  let mainWindow: BrowserWindow | null = null;
  let quitConfirmed = false;
  const showWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow(preloadDir, rendererDir);
      mainWindow.on("close", (e) => {
        if (!quitConfirmed) {
          // Closing the window keeps Heron running in the Dock and menu bar.
          e.preventDefault();
          mainWindow?.hide();
        }
      });
    }
    mainWindow.show();
    mainWindow.focus();
  };

  const notify = (n: { title: string; body: string; prId: number }) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body, silent: false });
    note.on("click", () => {
      showWindow();
      bus.publish("app", { kind: "openPr", prId: n.prId });
    });
    note.show();
  };

  const pipeline = new Pipeline({ db, store, github, git, paths, skills, version, env: () => env, claudePath: () => bins.claude, settings });
  // eslint-disable-next-line prefer-const -- assigned after the scheduler, which needs a reference to it
  let poller: Poller;
  const scheduler = new Scheduler({
    db,
    store,
    bus,
    pipeline,
    git,
    paths,
    settings,
    setSettings: (patch) => db.setSettings(patch),
    viewerLogin: () => viewerLogin,
    notify,
    requestPoll: () => void poller.pollNow(),
  });
  poller = new Poller({
    db,
    store,
    github,
    scheduler,
    intervalSec: () => settings().pollIntervalSec,
    ready: () => doctorReport?.ok ?? false,
  });

  let doctorRunning: Promise<DoctorReport> | null = null;
  const doctor = (): Promise<DoctorReport> => {
    doctorRunning ??= (async () => {
      env = await loadShellEnv();
      bins = resolveBinaries(env);
      const report = await runDoctor(bins, env, github, { ghConfigDir: paths.ghConfig, cwd: paths.root });
      doctorReport = report;
      if (report.viewer) viewerLogin = report.viewer.login;
      scheduler.setDoctorOk(report.ok);
      store.prsChanged();
      if (report.ok) void poller.pollNow();
      return report;
    })().finally(() => {
      doctorRunning = null;
    });
    return doctorRunning;
  };

  let modelsCache: { at: number; models: ModelOption[] } | null = null;
  const models = async (): Promise<ModelOption[]> => {
    if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.models;
    const fallback: ModelOption[] = MODEL_ALIASES.map((m) => ({ value: m, displayName: m[0]!.toUpperCase() + m.slice(1), description: "", efforts: [...EFFORT_LEVELS] }));
    if (!bins.claude) return fallback;
    try {
      const probe = await probeClaude(bins.claude, env, paths.ghConfig, paths.root);
      const list = probe.models
        .filter((m) => m.value !== "default")
        .map((m) => ({ value: m.value, displayName: m.displayName || m.value, description: m.description ?? "", efforts: m.supportedEffortLevels ?? [] }));
      modelsCache = { at: Date.now(), models: list.length ? list : fallback };
      return modelsCache.models;
    } catch {
      return fallback;
    }
  };

  const updateSettings = (patch: Partial<Settings>): Settings => {
    const before = settings();
    const { manualPause, ...rest } = patch;
    db.setSettings(rest);
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }
    if (manualPause !== undefined && manualPause !== before.manualPause) scheduler.pauseManual(manualPause);
    bus.publish("app", { kind: "config", what: "settings" });
    scheduler.tick();
    return settings();
  };

  // oRPC over a MessagePort: the renderer creates the channel and the preload forwards one end here.
  const handler = new RPCHandler(
    createRouter({
      db,
      store,
      bus,
      scheduler,
      poller,
      github,
      git,
      skills,
      paths,
      version,
      claudePath: () => bins.claude,
      viewerLogin: () => viewerLogin,
      doctor: { last: () => doctorReport, run: doctor },
      models,
      updateSettings,
      pickFolder: async (defaultPath) => {
        const options: Electron.OpenDialogOptions = {
          title: "Import a skill folder",
          defaultPath,
          properties: ["openDirectory"],
          message: "Choose a folder that contains SKILL.md",
        };
        const res = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        return res.canceled ? null : (res.filePaths[0] ?? null);
      },
      openExternal: (url) => shell.openExternal(url),
      reveal: (path) => shell.showItemInFolder(path),
    }),
  );
  ipcMain.on("heron:rpc-port", (event) => {
    const url = event.senderFrame?.url ?? "";
    const trusted = url.startsWith("file://") || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL));
    const [port] = event.ports;
    if (!trusted || !port) return;
    handler.upgrade(port);
    port.start();
  });

  installCsp();
  buildAppMenu(() => {
    showWindow();
    bus.publish("app", { kind: "openSettings" });
  });

  const tray = new HeronTray(resourcesDir, {
    open: showWindow,
    pause: () => scheduler.pauseManual(true),
    resume: () => scheduler.pauseManual(false),
    quit: () => app.quit(),
  });
  bus.subscribe("queue", (status) => tray.update(status));

  if (settings().launchAtLogin !== app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: settings().launchAtLogin });
  }

  showWindow();
  await scheduler.start();
  poller.start();
  void doctor();

  // While something is broken (logged out, missing tool), re-check every minute.
  setInterval(() => {
    if (!doctorReport?.ok || scheduler.authProblem) void doctor();
  }, 60_000).unref();

  powerMonitor.on("resume", () => {
    void poller.pollNow();
    scheduler.tick();
  });

  app.on("activate", showWindow);
  app.on("second-instance", showWindow);

  app.on("before-quit", (event) => {
    if (quitConfirmed) return;
    event.preventDefault();
    void (async () => {
      const n = scheduler.runningCount;
      if (n > 0) {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Quit", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: `${n} review${n === 1 ? "" : "s"} running. Quit anyway?`,
          detail: "They stop now and pick up from the start of their current step the next time Heron opens.",
        });
        if (response !== 0) return;
      }
      quitConfirmed = true;
      poller.stop();
      await scheduler.shutdown();
      tray.destroy();
      db.close();
      app.quit();
    })();
  });
}

function buildAppMenu(openSettings: () => void): void {
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
