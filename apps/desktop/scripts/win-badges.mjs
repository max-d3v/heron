// Draws the Windows taskbar badges (resources/win/badge1…9, badge9plus, each at 16px and @2x):
// a red disc with the running count centred on it. Run from apps/desktop: pnpm badges:win
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../resources/win");
const LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "9+"];
const SIZES = [
  { px: 16, suffix: "" },
  { px: 32, suffix: "@2x" },
];

/** Runs in the page: returns base64 PNGs keyed by file name. */
/* global OffscreenCanvas */
async function render(labels, sizes) {
  const RED = "#e5372b";
  const out = {};
  for (const { px, suffix } of sizes) {
    for (const label of labels) {
      const canvas = new OffscreenCanvas(px, px);
      const g = canvas.getContext("2d");
      g.fillStyle = RED;
      g.beginPath();
      g.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
      g.fill();

      // Centre the ink, not the advance width: the glyph box is what the eye sees.
      let size = px * (label.length > 1 ? 0.6 : 0.72);
      const fit = px * (label.length > 1 ? 0.78 : 0.6);
      g.font = `bold ${size}px Arial`;
      let m = g.measureText(label);
      while (m.actualBoundingBoxLeft + m.actualBoundingBoxRight > fit && size > 4) {
        size -= 0.25;
        g.font = `bold ${size}px Arial`;
        m = g.measureText(label);
      }
      const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
      const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      g.fillStyle = "#ffffff";
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      g.fillText(label, (px - w) / 2 + m.actualBoundingBoxLeft, (px - h) / 2 + m.actualBoundingBoxAscent);

      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      out[`badge${label === "9+" ? "9plus" : label}${suffix}.png`] = btoa(bin);
    }
  }
  return out;
}

// No top-level await: it holds back Electron's ready event in an ES module main script.
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false });
    await win.loadURL("about:blank");
    const files = await win.webContents.executeJavaScript(`(${render.toString()})(${JSON.stringify(LABELS)}, ${JSON.stringify(SIZES)})`);
    for (const [name, data] of Object.entries(files)) {
      writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
      console.log("wrote", name);
    }
    app.exit(0);
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
