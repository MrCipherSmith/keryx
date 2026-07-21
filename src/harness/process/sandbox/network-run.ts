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
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxProfile } from "./profile";
import type { CredentialMask } from "./proxy";

/**
 * A credential to mask: the contained process sees `sentinel` (set by
 * setupNetworkRun) in env var `name`; the proxy substitutes the real value on
 * outbound HTTP requests to `injectHosts`. The real value is supplied by the
 * caller (read from its own env) and never returned to the contained process.
 */
export interface MaskedCredential {
  name: string;
  realValue: string;
  injectHosts: string[];
}

/**
 * Parse a `NAME@host1,host2` credential-mask spec (the CLI/env surface).
 * Returns undefined for a malformed spec. Hosts accept the same `*.domain`
 * wildcards as the allowlist.
 */
export function parseMaskSpec(spec: string): { name: string; injectHosts: string[] } | undefined {
  const at = spec.indexOf("@");
  if (at <= 0) return undefined;
  const name = spec.slice(0, at).trim();
  const injectHosts = spec
    .slice(at + 1)
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (name.length === 0 || injectHosts.length === 0) return undefined;
  return { name, injectHosts };
}

export interface NetworkRunOptions {
  masks?: MaskedCredential[];
  /**
   * OPT-IN TLS termination (MITM) for allowlisted HTTPS — required for credential
   * masking over HTTPS. The run CA is created inside the proxy worker (its
   * private key never leaves it); the CA CERTIFICATE is written to a temp file
   * and the contained process is pointed at it via the standard CA-trust env
   * vars. Not every tool honors those (Go-based tools like `gh`/`terraform` use
   * the system pool and will fail TLS under termination).
   */
  tlsTerminate?: boolean;
}

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
function startProxyWorker(
  allowedDomains: string[],
  masks: CredentialMask[],
  tlsTerminate: boolean,
): Promise<{ port: number; caCertPem?: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./proxy-worker.ts", import.meta.url), {
      workerData: { allowedDomains, masks, tlsTerminate },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        void worker.terminate();
        reject(new Error("allowlist proxy worker did not start in time"));
      }
    }, 5000);

    worker.on("message", (msg: { type?: string; port?: number; caCertPem?: string }) => {
      if (settled || msg?.type !== "ready" || typeof msg.port !== "number") {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        port: msg.port,
        ...(typeof msg.caCertPem === "string" ? { caCertPem: msg.caCertPem } : {}),
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
export async function setupNetworkRun(
  profile: SandboxProfile,
  options: NetworkRunOptions = {},
): Promise<NetworkRunSetup> {
  if (profile.network !== "restricted") {
    return { profile, envAdditions: {}, close: NOOP_CLOSE };
  }

  // Generate a per-run sentinel for each masked credential. The contained
  // process gets the SENTINEL in its env var; only the proxy (worker) holds the
  // real value and substitutes it on the wire to the inject hosts.
  const maskedEnv: Record<string, string> = {};
  const proxyMasks: CredentialMask[] = [];
  for (const cred of options.masks ?? []) {
    if (cred.realValue.length === 0) continue; // nothing to mask
    const sentinel = `keryx-sentinel-${randomUUID()}`;
    maskedEnv[cred.name] = sentinel;
    proxyMasks.push({ sentinel, realValue: cred.realValue, injectHosts: cred.injectHosts });
  }

  const tlsTerminate = options.tlsTerminate === true;
  const { port, caCertPem, close } = await startProxyWorker(
    profile.allowedDomains,
    proxyMasks,
    tlsTerminate,
  );

  // When terminating TLS the contained process must trust the run CA. Deliver it
  // through the standard CA-trust env vars pointing at a temp PEM — never by
  // touching the system trust store.
  const trustEnv: Record<string, string> = {};
  let caPemPath: string | undefined;
  if (tlsTerminate && caCertPem) {
    caPemPath = path.join(tmpdir(), `keryx-run-ca-${randomUUID()}.pem`);
    await writeFile(caPemPath, caCertPem, { mode: 0o644 });
    trustEnv.SSL_CERT_FILE = caPemPath; // openssl / curl
    trustEnv.CURL_CA_BUNDLE = caPemPath; // curl
    trustEnv.NODE_EXTRA_CA_CERTS = caPemPath; // node / bun
    trustEnv.REQUESTS_CA_BUNDLE = caPemPath; // python requests
    trustEnv.GIT_SSL_CAINFO = caPemPath; // git
  }

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
      // CA trust for the terminated TLS (only when terminating).
      ...trustEnv,
      // Masked credentials: contained process sees only the sentinel.
      ...maskedEnv,
    },
    close: async () => {
      await close();
      if (caPemPath) {
        await rm(caPemPath, { force: true });
      }
    },
  };
}
