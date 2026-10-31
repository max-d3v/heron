import { Notification, app, dialog, ipcMain, powerMonitor, shell, type BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RPCHandler } from "@orpc/server/message-port";
import { AuthError, DEFAULT_PROFILE, EFFORT_LEVELS, MODEL_ALIASES, type QueueStatus, type Settings } from "@heron/core";
import { HeronDb } from "@heron/db";
import { GitClient } from "@heron/git";
import { GitHubClient, ghAuthToken } from "@heron/github";
import { probeClaude } from "@heron/harness";
import { FALLBACK_GIT, loadEnv, resolveBinaries, setupShell, type Binaries } from "@heron/platform";
import type { DoctorReport, ModelOption } from "@heron/rpc";
import { createBus } from "./bus.ts";
import { CommitStatusReporter } from "./commit-status.ts";
import { runDoctor } from "./doctor.ts";
import { ensureLayout, makePaths } from "./paths.ts";
import { IterationPipeline } from "./iteration-pipeline.ts";
import { IterationScheduler } from "./iterations.ts";
import { Pipeline } from "./pipeline.ts";
import { dataRoot, initPlatform, installAppMenu, loginItem, setRunningBadge, showTrayHint, startedHidden } from "./platform.ts";
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
app.setPath("userData", process.env.HERON_DATA_DIR ?? dataRoot());
initPlatform();

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
  const skills = new SkillService(db, paths);
  // The skills that ship with Heron come pre-installed; pr-review backs the Default profile.
  try {
    db.setSettings({ bundledSkills: await skills.syncBundled(join(resourcesDir, "skills"), db.getSettings().bundledSkills) });
  } catch {
    // Missing from the build: the Default profile falls back to the plain prompt.
  }
  // (Migrations create the default iteration profile; the review one depends on the bundled skill.)
  if (db.listProfiles("review").length === 0) {
    const prReview = db.listSkills().find((s) => s.source === "imported" && s.name === "pr-review");
    db.saveProfile({
      name: "Default",
      kind: "review",
      isDefault: true,
      entry: prReview ? { type: "skill", skillId: prReview.id } : { type: "prompt", markdown: DEFAULT_PROMPT },
      model: "opus",
      effort: "high",
      timeoutMin: DEFAULT_PROFILE.timeoutMin,
      maxTurns: DEFAULT_PROFILE.maxTurns,
    });
  }

  const bus = createBus();
  const store = new Store(db, bus);
  let env: NodeJS.ProcessEnv = await loadEnv();
  let bins: Binaries = resolveBinaries(env);
  let doctorReport: DoctorReport | null = null;
  let viewerLogin: string | null = null;

  const github = new GitHubClient({
    getToken: () => (bins.gh ? ghAuthToken(bins.gh, env) : Promise.reject(new AuthError("github", "The GitHub CLI (gh) isn't installed"))),
    userAgent: `heron/${version}`,
  });
  const git = new GitClient({
    gitPath: () => bins.git ?? FALLBACK_GIT,
    env: () => env,
    getToken: () => (bins.gh ? ghAuthToken(bins.gh, env) : Promise.reject(new AuthError("github", "The GitHub CLI (gh) isn't installed"))),
  });
  const settings = () => db.getSettings();

  let mainWindow: BrowserWindow | null = null;
  let quitConfirmed = false;
  let queueStatus: QueueStatus | null = null;
  const showWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow(preloadDir, rendererDir);
      mainWindow.on("close", (e) => {
        if (!quitConfirmed) {
          // Closing the window keeps Heron running in the Dock and menu bar (the system tray on Windows).
          e.preventDefault();
          mainWindow?.hide();
          if (!settings().trayHintShown && showTrayHint(showWindow)) db.setSettings({ trayHintShown: true });
        }
      });
    }
    mainWindow.show();
    mainWindow.focus();
    setRunningBadge(mainWindow, queueStatus?.running ?? 0, resourcesDir);
  };

  const notify = (n: { title: string; body: string; prId: number; tab?: "iteration" }) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body, silent: false });
    note.on("click", () => {
      showWindow();
      bus.publish("app", { kind: "openPr", prId: n.prId, ...(n.tab ? { tab: n.tab } : {}) });
    });
    note.show();
  };

  new CommitStatusReporter({ db, store, github }).start(bus);
  const pipeline = new Pipeline({ db, store, github, git, paths, skills, version, env: () => env, claudePath: () => bins.claude });
  const iterationPipeline = new IterationPipeline({
    db,
    store,
    github,
    git,
    paths,
    version,
    env: () => env,
    claudePath: () => bins.claude,
    gitPath: () => bins.git,
    viewerLogin: () => viewerLogin,
  });
  // eslint-disable-next-line prefer-const -- assigned after the scheduler, which needs a reference to it
  let poller: Poller;
  // eslint-disable-next-line prefer-const -- the two schedulers share pauses and the queue status, so each refers to the other
  let iterations: IterationScheduler;
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
    iterations: () => ({ running: iterations.runningCount, readyToPush: iterations.readyToPush() }),
  });
  iterations = new IterationScheduler({
    db,
    store,
    pipeline: iterationPipeline,
    github,
    git,
    paths,
    settings,
    viewerLogin: () => viewerLogin,
    notify,
    requestPoll: () => void poller.pollNow(),
    queue: {
      pauseReasons: () => scheduler.pauseReasons(),
      pauseForLimit: (until, message) => scheduler.pauseForLimit(until, message),
      pauseForAuth: (message) => scheduler.pauseForAuth(message),
    },
  });
  poller = new Poller({
    db,
    store,
    github,
    scheduler,
    iterations,
    intervalSec: () => settings().pollIntervalSec,
    ready: () => doctorReport?.ok ?? false,
  });

  let doctorRunning: Promise<DoctorReport> | null = null;
  const doctor = (): Promise<DoctorReport> => {
    doctorRunning ??= (async () => {
      env = await loadEnv();
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
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin) loginItem.set(patch.launchAtLogin);
    if (manualPause !== undefined && manualPause !== before.manualPause) scheduler.pauseManual(manualPause);
    bus.publish("app", { kind: "config", what: "settings" });
    scheduler.tick();
    iterations.tick();
    return settings();
  };

  // oRPC over a MessagePort: the renderer creates the channel and the preload forwards one end here.
  const handler = new RPCHandler(
    createRouter({
      db,
      store,
      bus,
      scheduler,
      iterations,
      poller,
      github,
      git,
      skills,
      paths,
      version,
      claudePath: () => bins.claude,
      setupShell: () => setupShell(env, bins.git),
      viewerLogin: () => viewerLogin,
      doctor: { last: () => doctorReport, run: doctor },
      models,
      updateSettings,
      pickFolder: async ({ title, message, defaultPath }) => {
        const options: Electron.OpenDialogOptions = { title, defaultPath, properties: ["openDirectory"], message };
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
  installAppMenu(() => {
    showWindow();
    bus.publish("app", { kind: "openSettings" });
  });

  const tray = new HeronTray(resourcesDir, {
    open: showWindow,
    openReady: () => {
      const ready = db.listIterationsInStates(["ready"])[0];
      showWindow();
      if (ready) bus.publish("app", { kind: "openPr", prId: ready.prId, tab: "iteration" });
    },
    pause: () => scheduler.pauseManual(true),
    resume: () => scheduler.pauseManual(false),
    quit: () => app.quit(),
  });
  bus.subscribe("queue", (status) => {
    queueStatus = status;
    tray.update(status);
    if (mainWindow) setRunningBadge(mainWindow, status.running, resourcesDir);
  });

  if (settings().launchAtLogin !== loginItem.get()) loginItem.set(settings().launchAtLogin);

  // Launch at login starts Heron in the tray on Windows (§17.8).
  if (!startedHidden) showWindow();
  await scheduler.start();
  await iterations.start();
  poller.start();
  void doctor();

  // While something is broken (logged out, missing tool), re-check every minute.
  setInterval(() => {
    if (!doctorReport?.ok || scheduler.authProblem) void doctor();
  }, 60_000).unref();

  powerMonitor.on("resume", () => {
    void poller.pollNow();
    scheduler.tick();
    iterations.tick();
  });

  app.on("activate", showWindow);
  app.on("second-instance", showWindow);

  app.on("before-quit", (event) => {
    if (quitConfirmed) return;
    event.preventDefault();
    void (async () => {
      const n = scheduler.runningCount + iterations.runningCount;
      if (n > 0) {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Quit", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: `${n} run${n === 1 ? "" : "s"} in progress. Quit anyway?`,
          detail: "They stop now and pick up from the start of their current step the next time Heron opens.",
        });
        if (response !== 0) return;
      }
      quitConfirmed = true;
      // Everything that writes to the database stops before it closes: a late write
      // throws "The database connection is not open" in the main process.
      const idle = await Promise.race([
        Promise.allSettled([poller.stop(), scheduler.shutdown(), iterations.shutdown()]).then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
      ]);
      tray.destroy();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      // Still busy after the wait: the database closes with the process (SQLite replays its WAL on the next open).
      if (idle) db.close();
      app.quit();
    })();
  });
}
