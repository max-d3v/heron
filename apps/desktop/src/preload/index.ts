/// <reference lib="dom" />
import { ipcRenderer } from "electron";

// The renderer creates a MessageChannel and posts one end here; forward it to the
// main process, where the oRPC handler takes it over. Nothing else is exposed.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== "heron:rpc-port") return;
  const [port] = event.ports;
  if (port) ipcRenderer.postMessage("heron:rpc-port", null, [port]);
});

// The CSS keys off <html data-platform> (§17.2). `data-mica`:
// Windows draws Mica behind the window, so the sidebar stays transparent as it does over vibrancy.
const mark = () => {
  document.documentElement.dataset.platform = process.platform;
  if (process.argv.includes("--heron-mica")) document.documentElement.dataset.mica = "";
};
if (document.documentElement) mark();
else document.addEventListener("DOMContentLoaded", mark, { once: true });
