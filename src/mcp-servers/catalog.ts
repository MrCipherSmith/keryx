// The tool catalog: qualified names, and what could not be qualified.
//
// P0 item 4. Pure — given a server name and what it reported for `tools/list`,
// produce the entries the model can reach and the ones it cannot, each with a
// reason. No I/O, so the decision is testable without a subprocess.

import type { McpToolDescriptor } from "../mcp-client/client";

/**
 * `server__tool`, with `__` as the delimiter.
 *
 * Grok's `MCP_TOOL_NAME_DELIMITER`, not OpenCode's single `_`. The choice
 * matters beyond parity: a single underscore cannot be split back into server
 * and tool when either half contains one, and `use_tool` has to route an FQN
 * to the connection that owns it.
 */
export const FQN_DELIMITER = "__";

/**
 * The name an MCP tool must be callable by.
 *
 * 64 characters total, starting with a letter or underscore. The bound is the
 * specification's; it exists because provider tool-name limits are real and a
 * name that exceeds them fails at call time, on the provider's terms, in a
 * message that says nothing about MCP.
 */
export const FQN_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export type CatalogEntry = {
  /** `server__tool`. The name the model sees and `use_tool` resolves. */
  readonly fqn: string;
  readonly server: string;
  /** The name the server itself uses, which is what `tools/call` must send. */
  readonly rawName: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  /** `ToolAnnotations`, beside the schema — where the protocol puts it. */
  readonly annotations?: Record<string, unknown> | undefined;
};

/**
 * A tool that exists on the server and cannot be offered.
 *
 * Carried with its reason rather than dropped. A tool absent from the catalog
 * and absent from every report is indistinguishable from a tool the server
 * never had — and the operator, looking for it, debugs the server instead of
 * the name. `doctor` prints these.
 */
export type SkippedTool = {
  readonly server: string;
  readonly rawName: string;
  readonly fqn: string;
  readonly reason: string;
};

export type ServerCatalog = {
  readonly entries: CatalogEntry[];
  readonly skipped: SkippedTool[];
};

export function buildFqn(server: string, rawName: string): string {
  return `${server}${FQN_DELIMITER}${rawName}`;
}

/**
 * Qualify one server's tools.
 *
 * Duplicate raw names from the same server collapse to one entry — the first
 * wins — and the loser is recorded as skipped rather than silently
 * overwriting: two tools answering to one FQN means one of them is
 * unreachable, and which one is not something the operator should have to
 * discover by calling it.
 */
export function catalogForServer(server: string, tools: readonly McpToolDescriptor[]): ServerCatalog {
  const entries: CatalogEntry[] = [];
  const skipped: SkippedTool[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const fqn = buildFqn(server, tool.name);

    if (!FQN_PATTERN.test(fqn)) {
      skipped.push({
        server,
        rawName: tool.name,
        fqn,
        reason:
          fqn.length > 64
            ? `qualified name is ${fqn.length} characters; the limit is 64`
            : "qualified name does not match ^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$",
      });
      continue;
    }

    if (seen.has(fqn)) {
      skipped.push({ server, rawName: tool.name, fqn, reason: "duplicate qualified name on this server" });
      continue;
    }

    seen.add(fqn);
    entries.push({
      fqn,
      server,
      rawName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    });
  }

  return { entries, skipped };
}

/**
 * Merge per-server catalogs into the one the model searches.
 *
 * A collision here is between SERVERS, which the `server__` prefix already
 * prevents unless two servers share a name — and two servers cannot, because
 * the config is keyed by name. Asserted rather than assumed: a collision that
 * did occur would silently shadow one server's whole toolset.
 */
export function mergeCatalogs(catalogs: readonly ServerCatalog[]): ServerCatalog {
  const entries: CatalogEntry[] = [];
  const skipped: SkippedTool[] = [];
  const seen = new Map<string, string>();

  for (const catalog of catalogs) {
    skipped.push(...catalog.skipped);
    for (const entry of catalog.entries) {
      const owner = seen.get(entry.fqn);
      if (owner !== undefined) {
        skipped.push({
          server: entry.server,
          rawName: entry.rawName,
          fqn: entry.fqn,
          reason: `qualified name already provided by server "${owner}"`,
        });
        continue;
      }
      seen.set(entry.fqn, entry.server);
      entries.push(entry);
    }
  }

  return { entries, skipped };
}

/** Resolve an FQN back to the server and raw name `tools/call` needs. */
export function resolveFqn(catalog: ServerCatalog, fqn: string): CatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.fqn === fqn);
}
