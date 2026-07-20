// Worker-thread entry for the allowlist proxy (flow 098 slice 2).
//
// The proxy MUST run off the main thread: a contained command is spawned via the
// synchronous `spawnSync` adapter, which blocks the main event loop for the
// whole run — an in-thread proxy could not accept the contained process's
// connections during that window. Running it in a worker gives it an independent
// event loop that keeps serving while the main thread is blocked.
//
// Protocol: parent passes `{ allowedDomains, host }` via workerData; the worker
// posts `{ type: "ready", port }` once listening, then serves until it receives
// `{ type: "close" }`, closes the proxy, and exits.

import { parentPort, workerData } from "node:worker_threads";
import { createAllowlistProxy, type AllowlistProxy } from "./proxy";

interface WorkerData {
  allowedDomains: string[];
  host?: string;
}

async function main(): Promise<void> {
  if (!parentPort) {
    return; // not run as a worker
  }
  const data = (workerData ?? {}) as WorkerData;
  const proxy: AllowlistProxy = await createAllowlistProxy({
    allowedDomains: Array.isArray(data.allowedDomains) ? data.allowedDomains : [],
    ...(typeof data.host === "string" ? { host: data.host } : {}),
  });
  parentPort.postMessage({ type: "ready", port: proxy.port, host: proxy.host });

  parentPort.on("message", (msg: { type?: string }) => {
    if (msg && msg.type === "close") {
      void proxy.close().then(() => process.exit(0));
    }
  });
}

void main();
