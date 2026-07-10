// Manifest-driven discovery / exposure filtering (specification.md §4, §6; M-11,
// US-A103, C0-9). A tool or resource whose owning module is disabled in
// `.metaproject/metaproject.json` is hidden from `tools/list` / `resources/list`.
//
// Imports only shared libs (M-3). Never throws — a missing/malformed manifest
// resolves to "everything disabled", so an uninitialized workspace exposes
// nothing rather than crashing.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

// Maps an MCP tool's `module` label (spec §6) to the manifest module key that
// gates it. A `null` value marks a cross-cutting module (`standard`, `mcp`) that
// has no dedicated manifest entry and is therefore always available.
export const MODULE_MANIFEST_KEY: Record<string, string | null> = {
  gdgraph: "gdgraph",
  security: "security",
  flow: "tasks",
  memory: "memory",
  health: "health",
  wiki: "gdwiki",
  standard: null,
  mcp: null,
};

type ManifestModule = { enabled?: boolean };

type MetaprojectManifest = {
  modules?: Record<string, ManifestModule>;
};

type McpModuleEntry = {
  enabled?: boolean;
  http?: { enabled?: boolean };
  // spec §4 nests the http capability object under `capabilities`; we also read
  // the standard-compatible flat `http` key. Either form gates the HTTP opt-in.
  capabilities?: { http?: { enabled?: boolean } } | string[];
  expose?: {
    tools?: boolean;
    resources?: boolean;
    modules?: string[];
  };
};

export interface McpDiscovery {
  // Whether `modules.mcp.enabled === true`. When false, the server exposes
  // nothing and no SDK is loaded on any non-`serve` path (M-7).
  mcpEnabled: boolean;
  httpCapabilityEnabled: boolean;
  exposeTools: boolean;
  exposeResources: boolean;
  // Explicit allowlist of tool-module labels, or null for "all enabled modules".
  exposedModules: string[] | null;
  isModuleExposed(module: string): boolean;
}

function readMcpEntry(manifest: MetaprojectManifest): McpModuleEntry | undefined {
  const entry = manifest.modules?.mcp as McpModuleEntry | undefined;
  return entry;
}

function httpEnabledFrom(entry: McpModuleEntry | undefined): boolean {
  if (!entry) {
    return false;
  }
  if (entry.http?.enabled === true) {
    return true;
  }
  const caps = entry.capabilities;
  if (caps && !Array.isArray(caps) && caps.http?.enabled === true) {
    return true;
  }
  if (Array.isArray(caps) && caps.includes("http")) {
    return true;
  }
  return false;
}

export function buildDiscovery(manifest: MetaprojectManifest): McpDiscovery {
  const modules = manifest.modules ?? {};
  const mcpEntry = readMcpEntry(manifest);
  const mcpEnabled = mcpEntry?.enabled === true;
  const expose = mcpEntry?.expose ?? {};
  const exposedModules = Array.isArray(expose.modules) ? expose.modules : null;

  const isModuleExposed = (module: string): boolean => {
    const key = MODULE_MANIFEST_KEY[module];
    // Unknown module labels are treated as gated by their own name.
    const manifestKey = key === undefined ? module : key;
    if (manifestKey !== null) {
      if (modules[manifestKey]?.enabled !== true) {
        return false;
      }
    }
    if (exposedModules !== null && !exposedModules.includes(module)) {
      return false;
    }
    return true;
  };

  return {
    mcpEnabled,
    httpCapabilityEnabled: httpEnabledFrom(mcpEntry),
    exposeTools: expose.tools !== false,
    exposeResources: expose.resources !== false,
    exposedModules,
    isModuleExposed,
  };
}

export async function loadDiscovery(cwd: string): Promise<McpDiscovery> {
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return buildDiscovery({});
  }
  const manifest = await readJsonFileOr<MetaprojectManifest>(manifestPath, {});
  return buildDiscovery(manifest);
}
