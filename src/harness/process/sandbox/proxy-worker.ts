// Worker-thread entry for the allowlist proxy (flow 098 slice 2).
//
// The proxy MUST run off the main thread: a contained command is spawned via the
// synchronous `spawnSync` adapter, which blocks the main event loop for the
// whole run — an in-thread proxy could not accept the contained process's
// connections during that window. Running it in a worker gives it an independent
// event loop that keeps serving while the main thread is blocked.
//
// Protocol: parent passes `{ allowedDomains, host, masks }` via workerData; the
// worker posts `{ type: "ready", port }` once listening, one
// `{ type: "decision", host, allowed, kind }` per allow/deny ruling, and serves
// until it receives `{ type: "close" }`, closes the proxy, and exits. `masks`
// carry real credential values, but only across the in-process worker boundary
// (same trust domain) — never to the contained process, which sees only
// sentinels. A decision message carries the hostname and the verdict only: no
// headers, no bodies, nothing credential-bearing.

import { parentPort, workerData } from "node:worker_threads";
import {
  createAllowlistProxy,
  type AllowlistProxy,
  type CredentialMask,
  type ProxyDecision,
} from "./proxy";
import { createRunCa, type RunCa } from "./tls-ca";

interface WorkerData {
  allowedDomains: string[];
  host?: string;
  masks?: CredentialMask[];
  /** Enable TLS termination; the run CA is created HERE (it cannot be serialized). */
  tlsTerminate?: boolean;
}

async function main(): Promise<void> {
  if (!parentPort) {
    return; // not run as a worker
  }
  const data = (workerData ?? {}) as WorkerData;

  // The run CA lives in the worker: its PRIVATE KEY never crosses a boundary.
  // Only the CA CERTIFICATE is reported back, for the contained process to trust.
  let ca: RunCa | undefined;
  if (data.tlsTerminate === true) {
    ca = await createRunCa();
  }

  const port = parentPort;
  const proxy: AllowlistProxy = await createAllowlistProxy({
    allowedDomains: Array.isArray(data.allowedDomains) ? data.allowedDomains : [],
    ...(typeof data.host === "string" ? { host: data.host } : {}),
    ...(Array.isArray(data.masks) ? { masks: data.masks } : {}),
    ...(ca ? { tlsTerminate: ca } : {}),
    onDecision: (d: ProxyDecision) => {
      port.postMessage({ type: "decision", host: d.host, allowed: d.allowed, kind: d.kind });
    },
  });
  parentPort.postMessage({
    type: "ready",
    port: proxy.port,
    host: proxy.host,
    ...(ca ? { caCertPem: ca.caCertPem } : {}),
  });

  parentPort.on("message", (msg: { type?: string }) => {
    if (msg && msg.type === "close") {
      void proxy
        .close()
        .then(() => (ca ? ca.dispose() : undefined))
        .then(() => process.exit(0));
    }
  });
}

void main();
