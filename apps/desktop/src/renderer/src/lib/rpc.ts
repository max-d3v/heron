import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { HeronClient } from "@heron/rpc";

// Hand one end of a MessageChannel to the preload, which forwards it to the main process.
const { port1: clientPort, port2: serverPort } = new MessageChannel();
window.postMessage("heron:rpc-port", "*", [serverPort]);
clientPort.start();

export const client: HeronClient = createORPCClient(new RPCLink({ port: clientPort }));
export const orpc = createTanstackQueryUtils(client);

/** The message of an RPC error, for showing to the user. */
export function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
