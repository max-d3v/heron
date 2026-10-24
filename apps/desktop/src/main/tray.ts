import { Menu, Tray, nativeImage } from "electron";
import { join } from "node:path";
import type { QueueStatus } from "@heron/core";

export interface TrayActions {
  open: () => void;
  pause: () => void;
  resume: () => void;
  quit: () => void;
}

/** Menu bar icon: status (idle / N running / paused + reason), Open, Pause/Resume, Quit (§12). */
export class HeronTray {
  private readonly tray: Tray;
  private readonly idleIcon: Electron.NativeImage;
  private readonly pausedIcon: Electron.NativeImage;

  constructor(
    resourcesDir: string,
    private readonly actions: TrayActions,
  ) {
    this.idleIcon = nativeImage.createFromPath(join(resourcesDir, "trayTemplate.png"));
    this.idleIcon.setTemplateImage(true);
    this.pausedIcon = nativeImage.createFromPath(join(resourcesDir, "trayPausedTemplate.png"));
    this.pausedIcon.setTemplateImage(true);
    this.tray = new Tray(this.idleIcon);
    this.tray.setToolTip("Heron");
    this.update(null);
  }

  update(status: QueueStatus | null): void {
    const paused = status?.paused ?? false;
    const running = status?.running ?? 0;
    let line: string;
    if (!status) line = "Starting…";
    else if (paused) line = `Paused: ${status.message ?? status.reasons.join(", ")}`;
    else if (running > 0) line = `${running} review${running === 1 ? "" : "s"} running`;
    else if (status.queued + status.debouncing > 0) line = `Idle · ${status.queued + status.debouncing} waiting`;
    else line = "Idle";

    this.tray.setImage(paused ? this.pausedIcon : this.idleIcon);
    this.tray.setTitle(running > 0 ? ` ${running}` : "", { fontType: "monospacedDigit" });
    this.tray.setToolTip(`Heron: ${line}`);

    const manualPaused = status?.reasons.includes("manual") ?? false;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: line, enabled: false },
        { type: "separator" },
        { label: "Open Heron", click: this.actions.open },
        manualPaused ? { label: "Resume", click: this.actions.resume } : { label: "Pause All", click: this.actions.pause },
        { type: "separator" },
        { label: "Quit Heron", accelerator: "Command+Q", click: this.actions.quit },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}
