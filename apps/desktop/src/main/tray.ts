import { Menu, Tray } from "electron";
import type { QueueStatus } from "@heron/core";
import { trayBehavior, trayIcons, type TrayIcons } from "./platform.ts";

export interface TrayActions {
  open: () => void;
  /** Show the window on the first PR whose iteration waits for Push. */
  openReady: () => void;
  pause: () => void;
  resume: () => void;
  quit: () => void;
}

/**
 * Menu bar icon (the system tray on Windows, §17.8): status (idle / N running / paused + reason),
 * Open, Pause/Resume, Quit (§12). The counts are in the tooltip too, since only macOS shows a title.
 */
export class HeronTray {
  private readonly tray: Tray;
  private readonly icons: TrayIcons;

  constructor(
    resourcesDir: string,
    private readonly actions: TrayActions,
  ) {
    this.icons = trayIcons(resourcesDir);
    this.tray = new Tray(this.icons.idle);
    this.tray.setToolTip("Heron");
    // Windows: a left click opens the window; the menu is on right-click.
    if (trayBehavior.openOnClick) this.tray.on("click", () => this.actions.open());
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

    this.tray.setImage(paused ? this.icons.paused : running > 0 ? this.icons.running : this.icons.idle);
    if (trayBehavior.showsTitle) this.tray.setTitle(running > 0 ? ` ${running}` : "", { fontType: "monospacedDigit" });
    const ready = status?.readyToPush ?? 0;
    this.tray.setToolTip(`Heron: ${line}${ready > 0 ? ` · ${ready} ready to push` : ""}`);

    const manualPaused = status?.reasons.includes("manual") ?? false;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: line, enabled: false },
        ...(ready > 0 ? [{ label: `${ready} ready to push`, click: this.actions.openReady }] : []),
        { type: "separator" },
        { label: "Open Heron", click: this.actions.open },
        manualPaused ? { label: "Resume", click: this.actions.resume } : { label: "Pause All", click: this.actions.pause },
        { type: "separator" },
        { label: "Quit Heron", accelerator: trayBehavior.quitAccelerator, click: this.actions.quit },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}
