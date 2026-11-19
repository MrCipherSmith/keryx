// PR #1213 review security-code-w6 S10-001: a client MCP server whose name
// keryx also configures is dropped as a whole, so `use_tool` never routes one
// of the client's tools to keryx's connection of the same name.

import { describe, expect, test } from "bun:test";
import type { McpServerConnection } from "../mcp-client/client";
import { buildFqn, mergeCatalogs, type CatalogEntry, type ServerCatalog } from "../mcp-servers/catalog";
import type { ServerState } from "../mcp-servers/manager";
import type { McpRuntime } from "../mcp-servers/runtime";
import { createMcpInteractiveTools } from "../mcp-servers/tools";
import { acpMcpBinds, clientMcpServers, mergeAcpMcp, ownedToolReason, SHADOWED_CLIENT_SERVER_REASON, withoutOwned } from "./merged-mcp";
import type { AcpSessionMcp } from "./session-mcp";

function entry(server: string, rawName: string): CatalogEntry {
  return { fqn: buildFqn(server, rawName), server, rawName };
}

/** A connection that records every tool it was asked to call. */
function recordingConnection(calls: string[], who: string): McpServerConnection {
  return {
    callTool: async (rawName: string) => {
      calls.push(`${who}:${rawName}`);
      return { kind: "result", result: { content: [{ type: "text", text: `${who} ran ${rawName}` }], isError: false } };
    },
  } as unknown as McpServerConnection;
}

function keryxRuntime(servers: readonly ServerState[], catalog: ServerCatalog): McpRuntime {
  return {
    catalog: () => catalog,
    servers: () => servers,
    toolTimeoutSec: () => undefined,
    problems: () => [],
    configured: () => servers.map((state) => ({ name: state.name }) as ReturnType<McpRuntime["configured"]>[number]),
    ready: async () => {},
    connectServer: async () => ({ ok: true }),
    disconnectServer: async () => ({ ok: true }),
    close: async () => {},
  };
}

function clientSet(servers: readonly ServerState[], catalog: ServerCatalog): AcpSessionMcp {
  return {
    ready: Promise.resolve(),
    // Non-empty: the set contributes tools.
    tools: createMcpInteractiveTools({ catalog: () => catalog, servers: () => servers }),
    catalog: () => catalog,
    servers: () => servers,
    redact: (text) => text,
    refused: [],
    failed: () => [],
    revive: () => {},
    close: async () => {},
  };
}

async function useTool(binding: ReturnType<typeof mergeAcpMcp>["binding"], fqn: string) {
  if (binding === undefined) throw new Error("expected a binding");
  const { catalog, servers, toolTimeoutSec, redact } = binding;
  const tool = createMcpInteractiveTools({
    catalog,
    servers,
    ...(toolTimeoutSec !== undefined ? { toolTimeoutSec } : {}),
    ...(redact !== undefined ? { redact } : {}),
  }).find((candidate) => candidate.definition.name === "use_tool");
  if (tool === undefined) throw new Error("no use_tool");
  return tool.invoke({ tool_name: fqn, tool_input: {} }, {} as Parameters<typeof tool.invoke>[1]);
}

describe("mergeAcpMcp — server-name collisions", () => {
  test("a client server named like a keryx server is dropped; its client-only tool never reaches keryx's connection", async () => {
    const calls: string[] = [];
    const keryx = keryxRuntime(
      [{ name: "dup", status: "connected", toolCount: 1, connection: recordingConnection(calls, "keryx") }],
      mergeCatalogs([{ entries: [entry("dup", "k_tool")], skipped: [] }]),
    );
    const client = clientSet(
      [
        { name: "dup", status: "connected", toolCount: 1, connection: recordingConnection(calls, "client") },
        { name: "own", status: "connected", toolCount: 1, connection: recordingConnection(calls, "client-own") },
      ],
      mergeCatalogs([{ entries: [entry("dup", "c_tool"), entry("own", "o_tool")], skipped: [] }]),
    );

    const merged = mergeAcpMcp(keryx, client);
    expect(merged.shadowed).toEqual([{ name: "dup", reason: SHADOWED_CLIENT_SERVER_REASON }]);
    const binding = merged.binding;
    expect(binding?.catalog().entries.map((e) => e.fqn)).toEqual([buildFqn("dup", "k_tool"), buildFqn("own", "o_tool")]);
    expect(binding?.catalog().skipped.map((s) => s.fqn)).toContain(buildFqn("dup", "c_tool"));
    expect(binding?.servers().map((s) => s.name)).toEqual(["dup", "own"]);

    const shadowedCall = await useTool(binding, buildFqn("dup", "c_tool"));
    expect(shadowedCall.isError).toBe(true);
    // The client-only tool reached nobody — least of all keryx's same-named server.
    expect(calls).toEqual([]);

    await useTool(binding, buildFqn("own", "o_tool"));
    await useTool(binding, buildFqn("dup", "k_tool"));
    expect(calls).toEqual(["client-own:o_tool", "keryx:k_tool"]);
  });

  test("no collision: both sides are merged and nothing is reported", () => {
    const keryx = keryxRuntime([{ name: "k", status: "connected", toolCount: 1 }], mergeCatalogs([{ entries: [entry("k", "a")], skipped: [] }]));
    const client = clientSet([{ name: "c", status: "connected", toolCount: 1 }], mergeCatalogs([{ entries: [entry("c", "b")], skipped: [] }]));
    const merged = mergeAcpMcp(keryx, client);
    expect(merged.shadowed).toEqual([]);
    expect(merged.binding?.servers().map((s) => s.name)).toEqual(["k", "c"]);
  });

  test("the client condition has one owner: a set with no tools binds nothing", () => {
    const empty: AcpSessionMcp = { ...clientSet([], mergeCatalogs([])), tools: [] };
    expect(clientMcpServers(empty)).toBeUndefined();
    expect(acpMcpBinds(false, empty)).toBe(false);
    expect(acpMcpBinds(true, empty)).toBe(true);
    expect(mergeAcpMcp(undefined, empty).binding).toBeUndefined();
  });
});

// A client's first-party server owning a tool-name prefix (the desktop app's browser panel).
describe("owned prefixes", () => {
  const keryxCatalog: ServerCatalog = {
    entries: [entry("other-browser", "browser_navigate"), entry("other-browser", "browser_take_screenshot"), entry("github", "search_code")],
    skipped: [],
  };
  const panelCatalog: ServerCatalog = { entries: [entry("keryx-panels", "browser_navigate"), entry("keryx-panels", "terminal_run")], skipped: [] };

  test("keryx tools under a prefix the client's first-party server owns are not offered, with a reason", () => {
    const owned = new Map([["keryx-panels", ["browser_"]]]);
    const out = withoutOwned(keryxCatalog, owned);
    expect(out.entries.map((e) => e.fqn)).toEqual([buildFqn("github", "search_code")]);
    expect(out.skipped.map((s) => s.rawName)).toEqual(["browser_navigate", "browser_take_screenshot"]);
    expect(out.skipped[0]!.reason).toBe(ownedToolReason("keryx-panels", "browser_"));
    // The owner's own tools are never dropped, and no owner means no change.
    expect(withoutOwned(panelCatalog, owned).entries).toHaveLength(2);
    expect(withoutOwned(keryxCatalog, undefined)).toBe(keryxCatalog);
  });

  test("the merged catalog keeps only the client's browser tools and every other keryx tool", () => {
    const keryx = keryxRuntime([{ name: "other-browser" } as ServerState, { name: "github" } as ServerState], keryxCatalog);
    const client: AcpSessionMcp = { ...clientSet([{ name: "keryx-panels", status: "connected" } as ServerState], panelCatalog), owned: new Map([["keryx-panels", ["browser_"]]]) };
    const fqns = mergeAcpMcp(keryx, client).binding!.catalog().entries.map((e) => e.fqn);
    expect(fqns).toContain(buildFqn("keryx-panels", "browser_navigate"));
    expect(fqns).toContain(buildFqn("github", "search_code"));
    expect(fqns.some((f) => f.startsWith("other-browser"))).toBe(false);
  });

  test("an owner that is not connected owns nothing, so keryx's tools stay usable", () => {
    const keryx = keryxRuntime([{ name: "other-browser" } as ServerState], keryxCatalog);
    const client: AcpSessionMcp = { ...clientSet([{ name: "keryx-panels", status: "failed" } as ServerState], panelCatalog), owned: new Map([["keryx-panels", ["browser_"]]]) };
    expect(mergeAcpMcp(keryx, client).binding!.catalog().entries.some((e) => e.server === "other-browser")).toBe(true);
  });

  test("without an owned prefix nothing of keryx's is dropped", () => {
    const keryx = keryxRuntime([{ name: "other-browser" } as ServerState], keryxCatalog);
    const merged = mergeAcpMcp(keryx, clientSet([{ name: "keryx-panels" } as ServerState], panelCatalog)).binding!.catalog();
    expect(merged.entries.some((e) => e.server === "other-browser")).toBe(true);
  });
});
