import type {
  CapabilitiesReport,
  MetaprojectManifest,
  ModuleCapability,
} from "./types";

// Normalize a single `capabilities[]` entry to its id string. Accepts both the
// legacy bare-string form (`"gdgraph.treesitter"`) and the enriched object form
// (`{ id, enabled, kind, ... }`, specification.md §4). Returns `null` for
// entries that carry no usable id so they can be dropped.
function capabilityId(entry: unknown): string | null {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object") {
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string") {
      return id;
    }
  }
  return null;
}

// Extract the standard-capability view from a discovery manifest: the standard
// version, declared profiles, and each module with its commands/capabilities.
// Sourced entirely from `metaproject.json` (no filesystem reads). Capability
// entries are normalized to their ids so both the bare-string and enriched
// object forms are surfaced uniformly.
export function extractCapabilities(manifest: MetaprojectManifest): CapabilitiesReport {
  const modules: ModuleCapability[] = Object.entries(manifest.modules ?? {})
    .map(([key, entry]) => ({
      key,
      enabled: entry?.enabled === true,
      commands: Array.isArray(entry?.commands) ? [...entry.commands] : [],
      capabilities: Array.isArray(entry?.capabilities)
        ? entry.capabilities
            .map(capabilityId)
            .filter((id): id is string => id !== null)
        : [],
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    standardVersion:
      typeof manifest.standardVersion === "string" ? manifest.standardVersion : null,
    profiles: Array.isArray(manifest.profiles) ? [...manifest.profiles] : [],
    modules,
  };
}
