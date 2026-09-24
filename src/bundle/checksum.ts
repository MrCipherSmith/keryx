// Flow 313 (W4 portability), T6 — content-addressing, reusing the sha256
// pattern already established for asset integrity (`src/assets/resolver.ts`)
// and canonical-JSON fingerprints rather than inventing a new hashing scheme.

import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
