// Uniform Capability Seam (specification.md §6a; arch §0, §2; AC0-4, AC0-5,
// AC0-8, AC0-11). Generalizes the proven `security.backends` opt-in idiom into a
// single, project-wide substrate every Block A–E instantiates.
//
// `resolveCapability(cwd, spec)` returns a `CapabilityAdapter` ONLY when all
// coordinated parts are satisfied:
//   1. the capability is enabled in `metaproject.json` (missing manifest = off),
//   2. its optional dependency (if any) imports (lazy `await import`, try/catch),
//   3. its asset (if any) resolves + verifies via the Asset Resolver, and
//   4. the built adapter reports `isAvailable()` true.
// The instant any part fails it returns `null` (warn-once on an *enabled* but
// unsatisfiable ceiling) so the caller runs its deterministic fallback. It
// NEVER throws — every failure is caught and mapped to `null`.
//
// This module imports only shared libs + the Asset Resolver; it never imports a
// module's internals or an optional dependency at top level (`C0-2`), keeping
// the seam acyclic (mirrors `security/guard.ts`).

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { loadAssetsLock, registryFromLock } from "../assets/lock";
import { resolveAsset } from "../assets/resolver";
import { warnCapabilityDegraded } from "./warn-once";

export interface CapabilityAdapter<In, Out> {
  readonly id: string;
  // dep importable AND asset resolved+verified AND any runtime precondition.
  isAvailable(): Promise<boolean>;
  // Called ONLY after `isAvailable()` resolved true.
  run(input: In): Promise<Out>;
}

export interface CapabilityLoadContext {
  // The lazily-imported optional dependency module (or `undefined` if none).
  dep: unknown;
  // The resolved+verified asset path (or `null` if none declared).
  asset: { path: string } | null;
}

export interface CapabilitySpec<In, Out> {
  readonly id: string;
  // Module specifier for `await import()`; loaded ONLY inside `resolveCapability`.
  readonly optionalDependency?: string;
  // Asset id resolved via `resolveAsset()` before the adapter is built.
  readonly asset?: string;
  // Factory: given the imported dep + resolved asset, build the adapter.
  load(ctx: CapabilityLoadContext): CapabilityAdapter<In, Out>;
}

// Minimal shape of the manifest slice the seam reads.
type ManifestCapabilityEntry = {
  id?: unknown;
  enabled?: unknown;
};
type ManifestSlice = {
  modules?: Record<string, { capabilities?: unknown } | undefined>;
};

// Whether a capability id is enabled in the workspace manifest. A capability is
// enabled only when some module's `capabilities[]` array carries the enriched
// object entry `{ id, enabled: true, ... }`. Bare-string capability entries are
// advertised floors, never enabled ceilings. A missing manifest = off (`C0-9`,
// mirrors `isSecurityEnabled`). Never throws.
export async function isCapabilityEnabled(cwd: string, id: string): Promise<boolean> {
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return false;
  }
  const manifest = await readJsonFileOr<ManifestSlice>(manifestPath, {});
  const modules = manifest.modules ?? {};
  for (const moduleEntry of Object.values(modules)) {
    const capabilities = Array.isArray(moduleEntry?.capabilities)
      ? moduleEntry.capabilities
      : [];
    for (const capability of capabilities) {
      if (capability && typeof capability === "object") {
        const entry = capability as ManifestCapabilityEntry;
        if (entry.id === id && entry.enabled === true) {
          return true;
        }
      }
    }
  }
  return false;
}

// Resolve a capability to an adapter, or `null` when it must degrade. See the
// module header for the four gates. Never throws.
export async function resolveCapability<In, Out>(
  cwd: string,
  spec: CapabilitySpec<In, Out>,
): Promise<CapabilityAdapter<In, Out> | null> {
  try {
    // Gate 1: manifest-enabled. Disabled ⇒ null with NO dep load, NO asset
    // touch, and NO warning (a disabled ceiling is the normal default path).
    if (!(await isCapabilityEnabled(cwd, spec.id))) {
      return null;
    }

    // Gate 2: optional dependency importable (lazy, try/catch — the only place
    // an optional dep is loaded).
    let dep: unknown;
    if (spec.optionalDependency) {
      try {
        dep = await import(spec.optionalDependency);
      } catch {
        warnCapabilityDegraded(
          spec.id,
          `optional dependency "${spec.optionalDependency}" is not installed`,
        );
        return null;
      }
    }

    // Gate 3: asset resolved + sha256-verified (no network — resolver reads
    // local files only).
    let asset: { path: string } | null = null;
    if (spec.asset) {
      const lock = await loadAssetsLock(cwd);
      const registry = registryFromLock(lock);
      const resolved = await resolveAsset(registry, spec.asset);
      if (!resolved) {
        warnCapabilityDegraded(
          spec.id,
          `asset "${spec.asset}" is missing or failed checksum verification`,
        );
        return null;
      }
      asset = { path: resolved.path };
    }

    // Build the adapter, then Gate 4: `isAvailable()` — caught so an adapter
    // that throws while probing degrades to the deterministic path (AC0-8).
    const adapter = spec.load({ dep, asset });
    let available: boolean;
    try {
      available = await adapter.isAvailable();
    } catch {
      warnCapabilityDegraded(spec.id, "adapter availability check threw");
      return null;
    }
    if (!available) {
      warnCapabilityDegraded(spec.id, "adapter reported unavailable");
      return null;
    }

    return adapter;
  } catch {
    // Absolute backstop: the seam must never throw out to a caller (`C0-11`).
    return null;
  }
}

// Convenience for the sanctioned call-site pattern (spec §6a): run the adapter
// when present, catching any `run()` error and degrading to the deterministic
// fallback so an opt-in ceiling can never break a deterministic seam (AC0-8).
export async function runCapabilityOrFallback<In, Out>(
  adapter: CapabilityAdapter<In, Out> | null,
  input: In,
  fallback: () => Out | Promise<Out>,
): Promise<Out> {
  if (!adapter) {
    return fallback();
  }
  try {
    return await adapter.run(input);
  } catch {
    warnCapabilityDegraded(adapter.id, "adapter run() threw");
    return fallback();
  }
}
