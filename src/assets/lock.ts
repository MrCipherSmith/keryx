// Asset lockfile reader + registry builder (specification.md §5, §6a; arch §3).
//
// `.metaproject/assets.lock.json` is the committed, pinned provenance record
// (`A-4`, AC0-17): one entry per asset id with `{ version, url, sha256, size }`.
// The resolver verifies every on-disk asset against this pinned sha256. This
// module only reads/normalizes the lockfile; it NEVER touches the network and
// imports nothing but shared libs + Node builtins (keeps `src/assets/` acyclic).

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

// A pinned lockfile entry: what the asset should be, by provenance.
export interface AssetLockEntry {
  version: string;
  url: string;
  sha256: string;
  size: number;
}

export interface AssetsLock {
  schemaVersion: number;
  assets: Record<string, AssetLockEntry>;
}

// The runtime registry the resolver reads (arch §3): `{ id, path?, url?, sha256,
// size }` per asset. `path` is an optional user-provided override (tier T1).
export interface AssetRegistryEntry {
  id: string;
  sha256: string;
  size: number;
  url?: string;
  path?: string;
}

export interface AssetRegistry {
  assets: Record<string, AssetRegistryEntry>;
}

export const EMPTY_LOCK: AssetsLock = { schemaVersion: 1, assets: {} };

export function lockPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "assets.lock.json");
}

// Coerce an unknown parsed lockfile into a well-formed `AssetsLock`, dropping
// malformed entries. Mirrors the "malformed input degrades to a safe default"
// discipline of `loadSecurityConfig`. Never throws.
export function normalizeLock(parsed: Partial<AssetsLock> | undefined): AssetsLock {
  const assets: Record<string, AssetLockEntry> = {};
  const rawAssets = (parsed?.assets ?? {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(rawAssets)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.url === "string" &&
      typeof entry.sha256 === "string" &&
      typeof entry.size === "number"
    ) {
      assets[id] = {
        version: typeof entry.version === "string" ? entry.version : "0.0.0",
        url: entry.url,
        sha256: entry.sha256,
        size: entry.size,
      };
    }
  }
  return {
    schemaVersion: typeof parsed?.schemaVersion === "number" ? parsed.schemaVersion : 1,
    assets,
  };
}

// Load `.metaproject/assets.lock.json`, falling back to an empty lock when it is
// absent or malformed (so a default command never fails on a missing lockfile).
export async function loadAssetsLock(cwd: string): Promise<AssetsLock> {
  const file = lockPath(cwd);
  if (!(await pathExists(file))) {
    return { schemaVersion: 1, assets: {} };
  }
  const parsed = await readJsonFileOr<Partial<AssetsLock>>(file, {});
  return normalizeLock(parsed);
}

// Build the resolver's runtime registry from a pinned lock, applying optional
// per-id user-path overrides (config field, tier T1). Only ids present in the
// lock are resolvable, so provenance is always pinned.
export function registryFromLock(
  lock: AssetsLock,
  overrides?: Record<string, { path?: string }>,
): AssetRegistry {
  const assets: Record<string, AssetRegistryEntry> = {};
  for (const [id, entry] of Object.entries(lock.assets)) {
    const override = overrides?.[id];
    assets[id] = {
      id,
      sha256: entry.sha256,
      size: entry.size,
      url: entry.url,
      ...(override?.path ? { path: override.path } : {}),
    };
  }
  return { assets };
}

// Structural validation for the committed lockfile (AC0-17: file present +
// schema-valid). Returns a list of human-readable problems; empty = valid.
export function validateAssetsLock(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") {
    return ["assets.lock.json: root must be an object"];
  }
  const lock = value as Record<string, unknown>;
  if (typeof lock.schemaVersion !== "number") {
    errors.push("assets.lock.json: schemaVersion must be a number");
  }
  if (!lock.assets || typeof lock.assets !== "object") {
    errors.push("assets.lock.json: assets must be an object");
    return errors;
  }
  for (const [id, entry] of Object.entries(lock.assets as Record<string, unknown>)) {
    if (!/^[a-z0-9-]+$/.test(id)) {
      errors.push(`assets.${id}: id must match ^[a-z0-9-]+$`);
    }
    if (!entry || typeof entry !== "object") {
      errors.push(`assets.${id}: entry must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.version !== "string") {
      errors.push(`assets.${id}.version: must be a string`);
    }
    if (typeof e.url !== "string") {
      errors.push(`assets.${id}.url: must be a string`);
    }
    if (typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256)) {
      errors.push(`assets.${id}.sha256: must be a 64-char hex string`);
    }
    if (typeof e.size !== "number") {
      errors.push(`assets.${id}.size: must be a number`);
    }
  }
  return errors;
}
