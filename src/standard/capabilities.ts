import type {
  CapabilitiesReport,
  MetaprojectManifest,
  ModuleCapability,
} from "./types";

// Extract the standard-capability view from a discovery manifest: the standard
// version, declared profiles, and each module with its commands/capabilities.
// Sourced entirely from `metaproject.json` (no filesystem reads).
export function extractCapabilities(manifest: MetaprojectManifest): CapabilitiesReport {
  const modules: ModuleCapability[] = Object.entries(manifest.modules ?? {})
    .map(([key, entry]) => ({
      key,
      enabled: entry?.enabled === true,
      commands: Array.isArray(entry?.commands) ? [...entry.commands] : [],
      capabilities: Array.isArray(entry?.capabilities) ? [...entry.capabilities] : [],
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    standardVersion:
      typeof manifest.standardVersion === "string" ? manifest.standardVersion : null,
    profiles: Array.isArray(manifest.profiles) ? [...manifest.profiles] : [],
    modules,
  };
}
