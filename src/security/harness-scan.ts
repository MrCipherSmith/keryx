// The harness's content scanner (flow 134, S2).
//
// `runOffline` redacts every tool result before persisting it, through an
// injected `scan`. The seam was correct from the start; the only implementation
// was a stub that answered `hasSecret: false` to everything, so the redaction
// step could never redact. This module supplies the real one.
//
// Why a builder rather than a direct call: the run loop is synchronous, offline
// and replayable by contract — it may not touch the filesystem mid-loop. The
// deterministic detectors (`runDetectors`) are synchronous and pure and fit that
// contract exactly; what they need is a `SecurityConfig`, and configuration
// lives on disk. So the async work happens once, here, before the run starts,
// and the loop receives a closure over the already-resolved config.
//
// The optional model backends (`runDetectorsAsync`) are deliberately not used:
// they are async, off by default, and no model runtime ships. The deterministic
// floor — regex rules plus entropy — is what the harness scans on, which is the
// same floor `keryx security scan` reports from.

import type { ScanResult } from "../harness/evidence/redaction";
import { isSecurityEnabled } from "./guard";
import { loadSecurityConfig } from "./config";
import { runDetectors } from "./detect";
import type { SecurityCategory, SecurityConfig } from "./types";

/** A synchronous content scanner, plus whether it can actually detect anything. */
export interface HarnessScanner {
  scan: (content: string) => ScanResult;
  /**
   * False when the security module is off or its config could not be read. The
   * caller passes this to the mutation guard's `scanAvailable`, which is
   * fail-closed: a guarded mutation with no scanner behind it is denied rather
   * than waved through. Pinning that flag to `true` was how the guard came to be
   * jammed open.
   */
  available: boolean;
}

/** The permissive scanner used when security is off: reports nothing, blocks nothing. */
const PERMISSIVE: HarnessScanner = {
  scan: () => ({ hasSecret: false }),
  available: false,
};

/**
 * Categories `runDetectors` can report, ordered by how much they should alarm a
 * reader of the redacted record. The first match present wins the category, so a
 * result carrying both a secret and a URL is filed under the secret.
 */
const CATEGORY_PRECEDENCE: readonly SecurityCategory[] = [
  "secret",
  "pii",
  "prompt-injection",
  "egress",
  "artifact-safety",
  "raw-retention",
];

/**
 * Build the harness scanner for `cwd`. Resolves the security module state and
 * config once; the returned `scan` is synchronous, pure and safe to call inside
 * the run loop.
 *
 * Never throws. A project with security disabled, or a config that cannot be
 * read, yields the permissive scanner with `available: false` — the run still
 * happens, and any *guarded mutation* in it is denied by the fail-closed
 * `scanAvailable` check rather than silently proceeding unscanned.
 */
export async function buildHarnessScanner(cwd: string): Promise<HarnessScanner> {
  let config: SecurityConfig;
  try {
    if (!(await isSecurityEnabled(cwd))) {
      return PERMISSIVE;
    }
    config = await loadSecurityConfig(cwd);
  } catch {
    return PERMISSIVE;
  }

  return {
    available: true,
    scan: (content: string): ScanResult => {
      if (content.length === 0) {
        return { hasSecret: false };
      }
      let matches;
      try {
        matches = runDetectors(content, config);
      } catch {
        // A detector that threw leaves the content unscanned, and unscanned
        // content must not be persisted verbatim. `redactForPersistence` treats
        // this as terminal and writes nothing — the same posture the security
        // module takes on a redaction failure.
        return { hasSecret: false, scanFailed: true };
      }
      if (matches.length === 0) {
        return { hasSecret: false };
      }
      const present = new Set(matches.map((m) => m.category));
      const category =
        CATEGORY_PRECEDENCE.find((c) => present.has(c)) ?? matches[0]?.category ?? "unknown";
      return { hasSecret: true, category };
    },
  };
}
