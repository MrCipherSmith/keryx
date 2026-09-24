// Flow 313 (W4 portability), T6 — `keryx bundle verify`'s deterministic core:
// recompute every `contents[].sha256` against the bundle's actual bytes.

import { sha256Hex } from "./checksum";
import { openBundle, type BundleSource } from "./archive";
import { parseManifest } from "./manifest";
import type { BundleManifest, BundleRefusal } from "./types";

export type VerifyEntryStatus = "ok" | "checksum-mismatch" | "size-mismatch" | "missing-entry";

export interface VerifyEntryResult {
  path: string;
  kind: string;
  status: VerifyEntryStatus;
}

export interface VerifyResult {
  ok: boolean;
  entries: VerifyEntryResult[];
  unlisted: string[];
}

export function verifyBundle(source: BundleSource, manifest: BundleManifest): VerifyResult {
  const entries: VerifyEntryResult[] = [];
  const listedPaths = new Set(manifest.contents.map((e) => e.path));

  for (const entry of manifest.contents) {
    const bytes = source.files.get(entry.path);
    if (bytes === undefined) {
      entries.push({ path: entry.path, kind: entry.kind, status: "missing-entry" });
      continue;
    }
    if (bytes.length !== entry.sizeBytes) {
      entries.push({ path: entry.path, kind: entry.kind, status: "size-mismatch" });
      continue;
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      entries.push({ path: entry.path, kind: entry.kind, status: "checksum-mismatch" });
      continue;
    }
    entries.push({ path: entry.path, kind: entry.kind, status: "ok" });
  }

  const unlisted = [...source.files.keys()].filter((p) => !listedPaths.has(p)).sort();

  const ok = entries.every((e) => e.status === "ok") && unlisted.length === 0;
  return { ok, entries, unlisted };
}

export type VerifyBundlePathResult = { ok: true; result: VerifyResult; manifest: BundleManifest } | { ok: false; refusals: BundleRefusal[] };

export async function verifyBundlePath(bundlePath: string): Promise<VerifyBundlePathResult> {
  const opened = await openBundle(bundlePath);
  if (!opened.ok) {
    return { ok: false, refusals: [opened.refusal] };
  }
  const parsed = parseManifest(opened.value.manifestBytes);
  if (!parsed.ok) {
    return { ok: false, refusals: parsed.refusals };
  }
  const result = verifyBundle(opened.value, parsed.manifest);
  return { ok: true, result, manifest: parsed.manifest };
}
