// Restricted-network run lifecycle (flow 098).
//
// Bridges the async allowlist proxy to a (synchronous) contained spawn: for a
// `network: "restricted"` profile it starts the loopback proxy, fills the
// profile's proxy address (so the launcher can allow only that socket), and
// yields the `HTTP(S)_PROXY` env the contained process must use to reach it.
// For any other posture it is a no-op. The caller MUST `close()` after the run.

import type { SandboxProfile } from "./profile";
import { createAllowlistProxy } from "./proxy";

export interface NetworkRunSetup {
  /** Profile with `proxy` filled in when restricted (unchanged otherwise). */
  profile: SandboxProfile;
  /** Env vars to merge into the contained command (empty unless restricted). */
  envAdditions: Record<string, string>;
  /** Tear down the proxy (no-op when not restricted). Always call after the run. */
  close: () => Promise<void>;
}

const NOOP_CLOSE = async (): Promise<void> => {};

/**
 * Prepare the network side of a contained run. Starts the loopback allowlist
 * proxy only for `network: "restricted"`; returns the proxy-addressed profile +
 * the proxy env. A restricted profile with an empty allowlist still starts a
 * proxy that denies every host (fail-safe: reachable but nothing allowed).
 */
export async function setupNetworkRun(profile: SandboxProfile): Promise<NetworkRunSetup> {
  if (profile.network !== "restricted") {
    return { profile, envAdditions: {}, close: NOOP_CLOSE };
  }

  const proxy = await createAllowlistProxy({ allowedDomains: profile.allowedDomains });
  // The env URL uses `localhost` (not the bind IP) so it matches the launcher's
  // loopback network rule — macOS Seatbelt's `remote ip` host must be `localhost`.
  const url = `http://localhost:${proxy.port}`;
  return {
    profile: { ...profile, proxy: { host: proxy.host, port: proxy.port } },
    envAdditions: {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      ALL_PROXY: url,
    },
    close: proxy.close,
  };
}
