// The shell profile's ONE `search_tool`/`use_tool` pair over keryx's configured
// MCP servers and the client's `mcpServers` (Keryx Desktop Client M1,
// specification §3.3).
//
// Collisions are decided per SERVER, not per tool (PR #1213 review
// security-code-w6 S10-001). `use_tool` routes a catalog entry to the
// connection whose name matches `entry.server`, and keryx's states are listed
// first, so a client server named like a keryx one would have its own tools
// called on keryx's process. A client server whose name keryx also configures
// is therefore dropped as a whole — its catalog entries and its state — and
// returned in `shadowed` for the caller to report.

import type { McpToolBinding } from "../commands/interactive-agent-tools";
import { mergeCatalogs, type CatalogEntry, type ServerCatalog } from "../mcp-servers/catalog";
import type { McpRuntime } from "../mcp-servers/runtime";
import type { AcpMcpServerProblem, AcpSessionMcp } from "./session-mcp";

/** The client's set when it contributes tools, else `undefined`. The one place that rule lives. */
export function clientMcpServers(client: AcpSessionMcp | undefined): AcpSessionMcp | undefined {
  return client !== undefined && client.tools.length > 0 ? client : undefined;
}

/** Whether a roster binds MCP at all, given whether keryx's runtime would. */
export function acpMcpBinds(keryxBinds: boolean, client: AcpSessionMcp | undefined): boolean {
  return keryxBinds || clientMcpServers(client) !== undefined;
}

export interface AcpMergedMcp {
  readonly binding: McpToolBinding | undefined;
  /** Client servers dropped because keryx configures a server of the same name. */
  readonly shadowed: readonly AcpMcpServerProblem[];
}

/** The reason a shadowed client server is reported with (after `MCP server "<name>" `). */
export const SHADOWED_CLIENT_SERVER_REASON =
  "is not used: keryx configures a server with the same name, and keryx's own is kept";

function keryxServerNames(keryx: McpRuntime): Set<string> {
  return new Set([...keryx.configured().map((server) => server.name), ...keryx.servers().map((state) => state.name)]);
}

/** Drops every entry of a shadowed server, recording each as skipped. */
function withoutServers(catalog: ServerCatalog, names: ReadonlySet<string>): ServerCatalog {
  if (names.size === 0) return catalog;
  return {
    entries: catalog.entries.filter((entry) => !names.has(entry.server)),
    skipped: [
      ...catalog.skipped.filter((skip) => !names.has(skip.server)),
      ...catalog.entries
        .filter((entry) => names.has(entry.server))
        .map((entry) => ({
          server: entry.server,
          rawName: entry.rawName,
          fqn: entry.fqn,
          reason: `server "${entry.server}" ${SHADOWED_CLIENT_SERVER_REASON}`,
        })),
    ],
  };
}

/** The reason a keryx tool left out for a client's owned prefix is reported with. */
export function ownedToolReason(owner: string, prefix: string): string {
  return `not offered: the client's own server "${owner}" provides the ${prefix}* tools in this session`;
}

/**
 * Drops keryx's tools whose raw names start with a prefix a client first-party
 * server owns (`_meta.keryx.owns`), recording each as skipped. The client's own
 * tools are never touched.
 */
export function withoutOwned(catalog: ServerCatalog, owned: ReadonlyMap<string, readonly string[]> | undefined): ServerCatalog {
  if (owned === undefined || owned.size === 0) return catalog;
  const ownerOf = (rawName: string): [string, string] | undefined => {
    for (const [server, prefixes] of owned) {
      const p = prefixes.find((x) => rawName.startsWith(x));
      if (p !== undefined) return [server, p];
    }
    return undefined;
  };
  const kept: CatalogEntry[] = [];
  const skipped = [...catalog.skipped];
  for (const entry of catalog.entries) {
    const hit = owned.has(entry.server) ? undefined : ownerOf(entry.rawName);
    if (hit === undefined) kept.push(entry);
    else skipped.push({ server: entry.server, rawName: entry.rawName, fqn: entry.fqn, reason: ownedToolReason(hit[0], hit[1]) });
  }
  return { entries: kept, skipped };
}

/** One binding over both sides; `undefined` when neither has servers. */
export function mergeAcpMcp(keryx: McpRuntime | undefined, clientSet: AcpSessionMcp | undefined): AcpMergedMcp {
  const client = clientMcpServers(clientSet);
  if (keryx === undefined && client === undefined) return { binding: undefined, shadowed: [] };
  // Read live, like the catalogs: a client server's state is named from the
  // start (`connecting`), and keryx's configured list is fixed for the runtime.
  const shadowedNames = (): Set<string> => {
    if (keryx === undefined || client === undefined) return new Set();
    const taken = keryxServerNames(keryx);
    return new Set(client.servers().map((state) => state.name).filter((name) => taken.has(name)));
  };
  const shadowed = [...shadowedNames()].map((name) => ({ name, reason: SHADOWED_CLIENT_SERVER_REASON }));
  // A client server owns its prefixes only while it is connected (its tools can then be offered in
  // place of keryx's) and is not shadowed (keryx's own server of that name is then the one in use).
  const ownedLive = (dropped: ReadonlySet<string>): ReadonlyMap<string, readonly string[]> | undefined => {
    const owned = client?.owned;
    if (owned === undefined) return undefined;
    const connected = new Set((client?.servers() ?? []).filter((state) => state.status === "connected").map((state) => state.name));
    return new Map([...owned].filter(([server]) => !dropped.has(server) && connected.has(server)));
  };
  return {
    binding: {
      catalog: () => {
        const dropped = shadowedNames();
        return mergeCatalogs([
          // A client's first-party server may own a tool-name prefix: keryx's tools under it give way.
          ...(keryx !== undefined ? [withoutOwned(keryx.catalog(), ownedLive(dropped))] : []),
          ...(client !== undefined ? [withoutServers(client.catalog(), dropped)] : []),
        ]);
      },
      servers: () => {
        const dropped = shadowedNames();
        return [...(keryx?.servers() ?? []), ...(client?.servers().filter((state) => !dropped.has(state.name)) ?? [])];
      },
      ...(keryx !== undefined ? { toolTimeoutSec: keryx.toolTimeoutSec } : {}),
      ...(client !== undefined ? { redact: client.redact } : {}),
    },
    shadowed,
  };
}
