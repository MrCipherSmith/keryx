// Capability init/update wiring (specification.md §4, §5, §9; AC0-10, AC0-12).
//
// The four-part opt-in mechanism's write side: parse uniform `--<cap>` /
// `--no-<cap>` flags (ceilings default OFF), upsert the enriched capability
// entry into the owning module's `metaproject.json` `capabilities[]` array
// WITHOUT disabling already-enabled modules, and materialize the module config
// (deep-merged over defaults, malformed-JSON → defaults). Mirrors the
// `mergeSecurityConfig` / `moduleEnabled` reconciliation discipline.
//
// Block 0 ships an EMPTY registry (it ships no feature); these functions are the
// substrate A–E instantiate. All logic is pure + independently tested.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

// Static description of an opt-in capability (registered by a block).
export interface CapabilityDescriptor {
  id: string; // e.g. "gdgraph.treesitter" — matches ^[a-z0-9-]+\.[a-z0-9-]+$
  flag: string; // CLI flag stem: `--<flag>` / `--no-<flag>`
  module: string; // owning module key in metaproject.json
  kind: "floor" | "ceiling";
  optionalDependency?: string;
  asset?: string;
  config?: string; // path to the module config file, relative to project root
  configDefaults?: Record<string, unknown>;
}

// The enriched manifest entry (specification.md §4).
export interface CapabilityManifestEntry {
  id: string;
  enabled: boolean;
  kind: "floor" | "ceiling";
  optionalDependency?: string;
  asset?: string;
  config?: string;
}

export interface CapabilitySelection {
  descriptor: CapabilityDescriptor;
  enabled: boolean;
}

// Build the enriched manifest entry for a descriptor at a chosen enabled state.
export function capabilityManifestEntry(
  descriptor: CapabilityDescriptor,
  enabled: boolean,
): CapabilityManifestEntry {
  return {
    id: descriptor.id,
    enabled,
    kind: descriptor.kind,
    ...(descriptor.optionalDependency !== undefined
      ? { optionalDependency: descriptor.optionalDependency }
      : {}),
    ...(descriptor.asset !== undefined ? { asset: descriptor.asset } : {}),
    ...(descriptor.config !== undefined ? { config: descriptor.config } : {}),
  };
}

// Parse uniform capability flags. `--<flag>` selects on, `--no-<flag>` selects
// off; a capability with neither flag is omitted (defaults are applied by the
// caller — ceilings default OFF). `--no-` wins if both are present.
export function parseCapabilitySelections(
  args: string[],
  registry: readonly CapabilityDescriptor[],
): CapabilitySelection[] {
  const selections: CapabilitySelection[] = [];
  for (const descriptor of registry) {
    const on = args.includes(`--${descriptor.flag}`);
    const off = args.includes(`--no-${descriptor.flag}`);
    if (!on && !off) {
      continue;
    }
    selections.push({ descriptor, enabled: on && !off });
  }
  return selections;
}

// Upsert a capability entry into a module's `capabilities[]`, preserving all
// other entries (including bare-string floors). Replaces an existing entry with
// the same id. Does NOT touch `module.enabled`.
export function upsertModuleCapability(
  capabilities: unknown[],
  entry: CapabilityManifestEntry,
): unknown[] {
  const next = capabilities.filter((capability) => {
    if (capability && typeof capability === "object") {
      return (capability as { id?: unknown }).id !== entry.id;
    }
    // Preserve bare-string capabilities unless they name the same id.
    return capability !== entry.id;
  });
  next.push(entry);
  return next;
}

// Reconcile one selection into a manifest object in place. When the owning
// module exists it upserts the enriched entry into its `capabilities[]` without
// altering `enabled`. When the module is absent the selection is skipped (a
// capability cannot attach to a module that is not present). Returns whether the
// manifest was modified.
export function reconcileManifestCapability(
  manifest: Record<string, unknown>,
  selection: CapabilitySelection,
): boolean {
  const modules = (manifest.modules ?? {}) as Record<string, unknown>;
  const moduleEntry = modules[selection.descriptor.module];
  if (!moduleEntry || typeof moduleEntry !== "object") {
    return false;
  }
  const moduleObject = moduleEntry as Record<string, unknown>;
  const existing = Array.isArray(moduleObject.capabilities)
    ? (moduleObject.capabilities as unknown[])
    : [];
  moduleObject.capabilities = upsertModuleCapability(
    existing,
    capabilityManifestEntry(selection.descriptor, selection.enabled),
  );
  modules[selection.descriptor.module] = moduleObject;
  manifest.modules = modules;
  return true;
}

// Deep-merge a partial object over a base (plain objects only; arrays/scalars
// from the override replace the base). The building block for config merges.
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      result[key] = deepMerge(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

// The default config object for a descriptor, with the capability toggle set.
// The config key is the capability's short name (the part after the dot).
export function defaultCapabilityConfig(
  descriptor: CapabilityDescriptor,
  enabled: boolean,
): Record<string, unknown> {
  const shortName = descriptor.id.includes(".")
    ? descriptor.id.slice(descriptor.id.indexOf(".") + 1)
    : descriptor.id;
  const base: Record<string, unknown> = descriptor.configDefaults
    ? deepMerge({ schemaVersion: 1, capabilities: {} }, descriptor.configDefaults)
    : { schemaVersion: 1, capabilities: {} };
  const capabilities = { ...((base.capabilities as Record<string, unknown>) ?? {}) };
  const existing = (capabilities[shortName] as Record<string, unknown>) ?? {};
  capabilities[shortName] = { ...existing, enabled, ...(descriptor.asset ? { asset: descriptor.asset } : {}) };
  base.capabilities = capabilities;
  return base;
}

// Load a module's capability config from disk, deep-merged over the descriptor
// defaults. Missing OR malformed JSON falls back to the defaults (`C0-8`, never
// throws) — mirrors `loadSecurityConfig`.
export async function loadCapabilityConfig(
  cwd: string,
  descriptor: CapabilityDescriptor,
  enabled = false,
): Promise<Record<string, unknown>> {
  const defaults = defaultCapabilityConfig(descriptor, enabled);
  if (!descriptor.config) {
    return defaults;
  }
  const file = path.join(cwd, descriptor.config);
  if (!(await pathExists(file))) {
    return defaults;
  }
  const parsed = await readJsonFileOr<Record<string, unknown>>(file, {});
  return deepMerge(defaults, parsed);
}

// Render a config file body for a descriptor at a chosen enabled state.
export function renderCapabilityConfig(
  descriptor: CapabilityDescriptor,
  enabled: boolean,
): string {
  return `${JSON.stringify(defaultCapabilityConfig(descriptor, enabled), null, 2)}\n`;
}
