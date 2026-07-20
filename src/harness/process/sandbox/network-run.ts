// Restricted-network run lifecycle (flow 098).
//
// Bridges the allowlist proxy to a (synchronous) contained spawn: for a
// `network: "restricted"` profile it starts the loopback proxy IN A WORKER
// THREAD (so it keeps serving while the main thread is blocked inside
// `spawnSync`), fills the profile's proxy address (so the launcher can allow only
// that socket), and yields the `HTTP(S)_PROXY` env the contained process must use
// to reach it. For any other posture it is a no-op. The caller MUST `close()`
// after the run.

import { Worker } from "node:worker_threads";
import type { SandboxProfile } from "./profile";

export interface NetworkRunSetup {
  /** Profile with `proxy` filled in when restricted (unchanged otherwise). */
  profile: SandboxProfile;
  /** Env vars to merge into the contained command (empty unless restricted). */
  envAdditions: Record<string, string>;
  /** Tear down the proxy worker (no-op when not restricted). Always call after the run. */
  close: () => Promise<void>;
}

const NOOP_CLOSE = async (): Promise<void> => {};

/** Spawn the proxy worker and resolve once it reports its listening port. */
function startProxyWorker(allowedDomains: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./proxy-worker.ts", import.meta.url), {
      workerData: { allowedDomains },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        void worker.terminate();
        reject(new Error("allowlist proxy worker did not start in time"));
      }
    }, 5000);

    worker.on("message", (msg: { type?: string; port?: number }) => {
      if (settled || msg?.type !== "ready" || typeof msg.port !== "number") {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        port: msg.port,
        close: () =>
          new Promise<void>((res) => {
            worker.once("exit", () => res());
            worker.postMessage({ type: "close" });
            // Fallback: force-terminate if the graceful close stalls.
            setTimeout(() => void worker.terminate().then(() => res()), 2000);
          }),
      });
    });
    worker.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Prepare the network side of a contained run. Starts the loopback allowlist
 * proxy (worker) only for `network: "restricted"`; returns the proxy-addressed
 * profile + the proxy env. A restricted profile with an empty allowlist still
 * starts a proxy that denies every host (fail-safe: reachable but nothing allowed).
 */
export async function setupNetworkRun(profile: SandboxProfile): Promise<NetworkRunSetup> {
  if (profile.network !== "restricted") {
    return { profile, envAdditions: {}, close: NOOP_CLOSE };
  }

  const { port, close } = await startProxyWorker(profile.allowedDomains);
  // The env URL uses `localhost` (not the bind IP) so it matches the launcher's
  // loopback network rule — macOS Seatbelt's `remote ip` host must be `localhost`.
  const url = `http://localhost:${port}`;
  return {
    profile: { ...profile, proxy: { host: "127.0.0.1", port } },
    envAdditions: {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      ALL_PROXY: url,
    },
    close,
  };
}
