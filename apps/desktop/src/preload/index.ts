/// <reference lib="dom" />
import { ipcRenderer } from "electron";

// The renderer creates a MessageChannel and posts one end here; forward it to the
// main process, where the oRPC handler takes it over. Nothing else is exposed.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== "heron:rpc-port") return;
  const [port] = event.ports;
  if (port) ipcRenderer.postMessage("heron:rpc-port", null, [port]);
});
