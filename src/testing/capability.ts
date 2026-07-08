// Testing capability gate (Block D · D2; specification.md §4). Mirrors
// `isSecurityEnabled`: reads `.metaproject/metaproject.json` and reports whether
// the given testing capability is enabled. A missing manifest ⇒ off (`C0-9`) ⇒
// the caller runs its byte-identical static fallback.
//
// Accepts both manifest forms so it is robust to how the capability was written:
//   - a bare string in `modules.testing.capabilities` (e.g. "coverageMap"), and
//   - the enriched object `{ id: "coverageMap" | "testing.coverageMap",
//     enabled: true }` written by the uniform capability-wiring seam.
// Never throws.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

type ManifestCapability = string | { id?: unknown; enabled?: unknown };
type ManifestSlice = {
  modules?: Record<string, { capabilities?: unknown } | undefined>;
};

export async function isTestingCapabilityEnabled(cwd: string, capability: string): Promise<boolean> {
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return false;
  }
  const manifest = await readJsonFileOr<ManifestSlice>(manifestPath, {});
  const testing = manifest.modules?.testing;
  const capabilities = Array.isArray(testing?.capabilities) ? (testing?.capabilities as ManifestCapability[]) : [];
  const qualified = `testing.${capability}`;
  for (const entry of capabilities) {
    if (typeof entry === "string") {
      if (entry === capability || entry === qualified) {
        return true;
      }
    } else if (entry && typeof entry === "object") {
      if ((entry.id === capability || entry.id === qualified) && entry.enabled === true) {
        return true;
      }
    }
  }
  return false;
}
