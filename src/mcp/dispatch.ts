// Pure JSON-RPC dispatch core (specification.md §6, §7; AC1, AC2, AC3, AC4).
//
// This module contains the tool/resource dispatch logic with NO SDK dependency,
// so it can be driven directly in-process by unit tests (the AC1 parity gate)
// AND by the real stdio server in `server.ts`. Every tool result is routed
// through the redaction seam (M-5) before it leaves this layer.

import { loadMcpConfig, type McpConfig } from "./config";
import { loadDiscovery, type McpDiscovery } from "./discovery";
import { buildToolRegistry, type JsonSchema, type ToolEntry } from "./tools";
import {
  listResources,
  readResource,
  type ResourceContents,
  type ResourceListing,
} from "./resources";
import { redactToolOutput } from "./redact-seam";

export interface McpContext {
  cwd: string;
  config: McpConfig;
  discovery: McpDiscovery;
  tools: ToolEntry[];
}

export async function buildMcpContext(cwd: string): Promise<McpContext> {
  const [config, discovery] = await Promise.all([
    loadMcpConfig(cwd),
    loadDiscovery(cwd),
  ]);
  return { cwd, config, discovery, tools: buildToolRegistry() };
}

// A tool name passes the config filter when the include list contains "*" or the
// name, and the exclude list does not contain it.
function passesConfigFilter(name: string, config: McpConfig): boolean {
  const { include, exclude } = config.tools;
  if (exclude.includes(name)) {
    return false;
  }
  return include.includes("*") || include.includes(name);
}

// The tools visible over the wire: manifest-exposed module (M-11), config
// filter, and the master `expose.tools` switch.
export function visibleTools(ctx: McpContext): ToolEntry[] {
  // AC3: with `modules.mcp.enabled=false`, no Tool is exposed at all.
  if (!ctx.discovery.mcpEnabled || !ctx.discovery.exposeTools) {
    return [];
  }
  return ctx.tools.filter(
    (tool) =>
      ctx.discovery.isModuleExposed(tool.module) &&
      passesConfigFilter(tool.name, ctx.config),
  );
}

export interface ToolListing {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export function dispatchListTools(ctx: McpContext): ToolListing[] {
  return visibleTools(ctx).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

// Invoke a tool and return its redaction-routed, JSON-serialized result. A
// disabled/unknown tool or an invocation error yields a leak-safe error result
// (isError=true) rather than throwing across the transport.
export async function dispatchCallTool(
  ctx: McpContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const tool = visibleTools(ctx).find((entry) => entry.name === name);
  if (!tool) {
    return { text: `Unknown or unavailable tool: ${name}`, isError: true };
  }
  try {
    const result = await tool.invoke(ctx.cwd, args ?? {});
    const json = JSON.stringify(result ?? null, null, 2);
    // M-5 / AC4: EVERY tool result passes through redactRaw before transport.
    const redacted = await redactToolOutput(ctx.cwd, json, ctx.config.redactToolOutput);
    return { text: redacted, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Tool ${name} failed: ${message}`, isError: true };
  }
}

export async function dispatchListResources(ctx: McpContext): Promise<ResourceListing[]> {
  if (!ctx.discovery.mcpEnabled || !ctx.discovery.exposeResources) {
    return [];
  }
  return listResources(ctx.cwd, ctx.config.resources.roots);
}

export async function dispatchReadResource(
  ctx: McpContext,
  uri: string,
): Promise<ResourceContents> {
  if (!ctx.discovery.mcpEnabled || !ctx.discovery.exposeResources) {
    throw new Error("Resources are not exposed for this workspace.");
  }
  return readResource(ctx.cwd, ctx.config.resources.roots, uri);
}
