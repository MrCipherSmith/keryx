// Asset Resolver (specification.md §6a; arch §3; AC0-13, AC0-14, AC0-16).
//
// `resolveAsset(cfg, id)` resolves an opt-in asset from exactly one of three
// tiers and verifies its sha256 on EVERY load:
//   T1  user-provided config path      (registry entry `.path`)
//   T2  pulled asset                   (well-known cache, written by `pullAsset`)
//   T3  well-known user cache          (~/.cache/keryx/assets/<id>)
// It returns `null` (⇒ the caller runs its deterministic fallback) whenever the
// asset is missing or fails checksum verification, and it NEVER initiates a
// network call — reading local files only. The sole network path lives in
// `pull.ts`.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { AssetRegistry } from "./lock";

export interface ResolvedAsset {
  path: string;
  sha256: string;
  verified: boolean;
}

// The well-known cache root for pulled/cached assets (tiers T2/T3).
// `KERYX_ASSET_CACHE` overrides the default so operators (and CI) can pin a
// deterministic cache location; otherwise it is `~/.cache/keryx/assets`.
export function assetCacheDir(): string {
  const override = process.env.KERYX_ASSET_CACHE;
  if (override && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), ".cache", "keryx", "assets");
}

export function cacheAssetPath(id: string): string {
  return path.join(assetCacheDir(), id);
}

// sha256 of a file's bytes. Throws only on read failure (caught by callers).
export async function sha256File(file: string): Promise<string> {
  const buffer = await readFile(file);
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Resolve + verify an asset. Reads local files only; never opens a socket.
// Returns the first candidate whose sha256 matches the pinned registry entry,
// or `null` when none matches (missing OR tampered ⇒ deterministic fallback).
export async function resolveAsset(
  cfg: AssetRegistry,
  id: string,
): Promise<ResolvedAsset | null> {
  const entry = cfg.assets[id];
  if (!entry) {
    return null;
  }

  // T1 user path (if configured), then T2/T3 well-known cache.
  const candidates = [entry.path, cacheAssetPath(id)].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    let actual: string;
    try {
      actual = await sha256File(candidate);
    } catch {
      continue;
    }
    if (actual === entry.sha256) {
      return { path: candidate, sha256: actual, verified: true };
    }
    // Checksum mismatch (tampered/stale) — do not trust this file; keep looking.
  }

  return null;
}
