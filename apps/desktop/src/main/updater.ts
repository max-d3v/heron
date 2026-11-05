import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { app, net, shell } from "electron";
import electronUpdater, { type AppUpdater, type UpdateInfo } from "electron-updater";
import type { UpdateStatus } from "@heron/rpc";
import type { Bus } from "./bus.ts";
import { updateBehavior } from "./platform.ts";

/** Release downloads; the repo `publish` names in electron-builder.yml. semantic-release tags each release v<version>. */
const RELEASES = "https://github.com/max-d3v/heron/releases/download";
/** After launch, so the first check doesn't compete with the Doctor and the first poll. */
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

export interface UpdaterDeps {
  bus: Bus;
  /** Where macOS keeps the downloaded .dmg. */
  dir: string;
  /** Quit the way Quit Heron does, confirming running runs. `install`: run the downloaded installer on the way out. */
  quit: (install: boolean) => void;
}

/**
 * Heron's own updates from GitHub Releases (§13.1): a check at launch and every few hours, and the
 * newer release downloaded in the background. Windows installs it when Heron quits (or on Restart to
 * Update); macOS opens the .dmg on Install Update. Only installed copies update; a development build is "off".
 */
export class Updater {
  private status: UpdateStatus;
  private readonly updater: AppUpdater | null;
  private running: Promise<void> | null = null;
  private dmgPath: string | null = null;

  constructor(private readonly deps: UpdaterDeps) {
    this.updater = app.isPackaged ? electronUpdater.autoUpdater : null;
    this.status = this.updater ? { state: "idle", checkedAt: null } : { state: "off" };
    if (!this.updater) return;
    this.updater.autoDownload = updateBehavior.installsInPlace;
    this.updater.autoInstallOnAppQuit = updateBehavior.installsInPlace;
    this.updater.on("download-progress", (p) => this.progress(p.percent));
  }

  get current(): UpdateStatus {
    return this.status;
  }

  start(): void {
    if (!this.updater) return;
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref();
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  /** One check at a time, and none once an update is downloaded: the next launch looks for anything newer. */
  check(): Promise<void> {
    const updater = this.updater;
    if (!updater || this.status.state === "ready") return Promise.resolve();
    this.running ??= this.checkAndDownload(updater).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Windows: quit, install and reopen. macOS: open the .dmg, whose window shows Heron and Applications, and quit. */
  async install(): Promise<void> {
    if (this.status.state !== "ready") return;
    if (updateBehavior.installsInPlace) return this.deps.quit(true);
    if (!this.dmgPath) return;
    const error = await shell.openPath(this.dmgPath);
    if (error) throw new Error(`Couldn't open the update: ${error}`);
    this.deps.quit(false);
  }

  /**
   * The last step of a quit that `quit(true)` started, after everything has stopped: start the installer,
   * which waits for Heron to exit, installs silently and reopens it. False if it didn't start.
   */
  runInstaller(): boolean {
    return this.updater instanceof electronUpdater.BaseUpdater && this.updater.install(true, true);
  }

  private async checkAndDownload(updater: AppUpdater): Promise<void> {
    this.set({ state: "checking" });
    try {
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        this.set({ state: "idle", checkedAt: Date.now() });
        if (!updateBehavior.installsInPlace) await rm(this.deps.dir, { recursive: true, force: true });
        return;
      }
      const { version } = result.updateInfo;
      this.set({ state: "downloading", version, percent: 0 });
      if (updateBehavior.installsInPlace) await (result.downloadPromise ?? updater.downloadUpdate());
      else this.dmgPath = await this.downloadDmg(result.updateInfo);
      this.set({ state: "ready", version });
    } catch (err) {
      this.set({ state: "error", message: errorLine(err), checkedAt: Date.now() });
    }
  }

  /**
   * The release's .dmg into `dir`, checked against the sha512 in latest-mac.yml. Kept until it's
   * installed, so a relaunch doesn't download it again. Heron writes it itself, so it carries no
   * quarantine flag and the copy dragged out of it opens without another Open Anyway.
   */
  private async downloadDmg(info: UpdateInfo): Promise<string> {
    const file = info.files.find((f) => f.url.endsWith(".dmg"));
    if (!file) throw new Error(`Heron ${info.version} has no .dmg in its update feed`);
    const dir = this.deps.dir;
    const dest = join(dir, `Heron-${info.version}.dmg`);
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(dir)) {
      if (join(dir, name) !== dest) await rm(join(dir, name), { recursive: true, force: true });
    }
    if (existsSync(dest) && (await sha512(dest)) === file.sha512) return dest;

    const res = await net.fetch(`${RELEASES}/v${info.version}/${file.url}`);
    if (!res.ok || !res.body) throw new Error(`Downloading Heron ${info.version} failed (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length")) || file.size || 0;
    const hash = createHash("sha512");
    const part = `${dest}.part`;
    const out = await open(part, "w");
    try {
      const reader = res.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await out.write(value);
        received += value.length;
        if (total) this.progress((received / total) * 100);
      }
    } finally {
      await out.close();
    }
    if (hash.digest("base64") !== file.sha512) {
      await rm(part, { force: true });
      throw new Error(`The download of Heron ${info.version} was damaged. Heron tries again at the next check.`);
    }
    await rename(part, dest);
    return dest;
  }

  private progress(percent: number): void {
    if (this.status.state !== "downloading") return;
    const rounded = Math.min(100, Math.floor(percent));
    if (rounded !== this.status.percent) this.set({ ...this.status, percent: rounded });
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    this.deps.bus.publish("update", status);
  }
}

async function sha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("base64");
}

/** electron-updater's errors carry the whole HTTP exchange; the first line says what went wrong. */
function errorLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split("\n")[0]?.trim() || "Unknown error";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}
