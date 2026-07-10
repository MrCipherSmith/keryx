// MCP server configuration loader (specification.md §5, C0-8).
//
// `loadMcpConfig(cwd)` reads `.metaproject/core/mcp/mcp.config.json` and
// deep-merges it over the built-in defaults. Malformed JSON degrades to defaults
// (mirrors `loadSecurityConfig`); the loader NEVER throws. This module imports
// only shared libs, so `src/mcp/` stays acyclic and thin (M-3).

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

export type McpTransport = "stdio" | "http";

export interface McpConfig {
  transport: McpTransport;
  http: { host: string; port: number; enabled: boolean };
  tools: { include: string[]; exclude: string[] };
  resources: { roots: string[] };
  redactToolOutput: boolean;
}

// Built-in defaults (spec §5). `resources.roots` names the read-only Resource
// classes exposed (spec §7: artifacts | wiki | memory). `redactToolOutput` MUST
// stay true — it routes every tool result through `redactRaw` (M-5).
export const MCP_CONFIG_DEFAULTS: McpConfig = {
  transport: "stdio",
  http: { host: "127.0.0.1", port: 0, enabled: false },
  tools: { include: ["*"], exclude: [] },
  resources: { roots: ["artifacts", "wiki", "memory"] },
  redactToolOutput: true,
};

export function mcpConfigPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "core", "mcp", "mcp.config.json");
}

function cloneDefaults(): McpConfig {
  return {
    transport: MCP_CONFIG_DEFAULTS.transport,
    http: { ...MCP_CONFIG_DEFAULTS.http },
    tools: {
      include: [...MCP_CONFIG_DEFAULTS.tools.include],
      exclude: [...MCP_CONFIG_DEFAULTS.tools.exclude],
    },
    resources: { roots: [...MCP_CONFIG_DEFAULTS.resources.roots] },
    redactToolOutput: MCP_CONFIG_DEFAULTS.redactToolOutput,
  };
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 || value.length === 0 ? strings : fallback;
}

// Deep-merge a parsed override object over the defaults, key by key. Unknown or
// mistyped fields fall back to the default value, so a partial or malformed
// config is always coerced into a well-formed `McpConfig`. Never throws.
export function mergeMcpConfig(overrides: unknown): McpConfig {
  const config = cloneDefaults();
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return config;
  }
  const raw = overrides as Record<string, unknown>;

  if (raw.transport === "stdio" || raw.transport === "http") {
    config.transport = raw.transport;
  }

  if (raw.http && typeof raw.http === "object" && !Array.isArray(raw.http)) {
    const http = raw.http as Record<string, unknown>;
    if (typeof http.host === "string") {
      config.http.host = http.host;
    }
    if (typeof http.port === "number" && Number.isFinite(http.port)) {
      config.http.port = http.port;
    }
    if (typeof http.enabled === "boolean") {
      config.http.enabled = http.enabled;
    }
  }

  if (raw.tools && typeof raw.tools === "object" && !Array.isArray(raw.tools)) {
    const tools = raw.tools as Record<string, unknown>;
    config.tools.include = asStringArray(tools.include, config.tools.include);
    config.tools.exclude = asStringArray(tools.exclude, config.tools.exclude);
  }

  if (raw.resources && typeof raw.resources === "object" && !Array.isArray(raw.resources)) {
    const resources = raw.resources as Record<string, unknown>;
    config.resources.roots = asStringArray(resources.roots, config.resources.roots);
  }

  if (typeof raw.redactToolOutput === "boolean") {
    config.redactToolOutput = raw.redactToolOutput;
  }

  return config;
}

export async function loadMcpConfig(cwd: string): Promise<McpConfig> {
  const file = mcpConfigPath(cwd);
  if (!(await pathExists(file))) {
    return cloneDefaults();
  }
  const parsed = await readJsonFileOr<unknown>(file, {});
  return mergeMcpConfig(parsed);
}
