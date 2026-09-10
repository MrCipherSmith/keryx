// One MCP runtime per shell session.
//
// The missing half of P0 item 5: the plan says "wire into the shell tool list
// next to existing builtins", and a `search_tool` nothing constructs is a
// feature that exists only in its own tests.
//
// SESSION-SCOPED, exactly like `JobRegistry` and for the same measured
// reason. `buildInteractiveAgentTools` is called again every time the tool
// list is rebuilt; a runtime created inside it would spawn a fresh set of
// server processes on each rebuild and orphan the previous ones, with no
// sweep able to reach them. It is created once, by the surface that owns the
// session, and closed when that session ends.
//
// Nothing here blocks the shell. `start()` returns as soon as the config is
// read; the dials run in the background and the catalog fills in as they
// land, which is why `tools.ts` reads the catalog through a function rather
// than taking a snapshot.

import path from "node:path";
import { loadMcpServers, type McpConfigProblem, type ResolvedMcpServer } from "./config";
import { mergeCatalogs, type ServerCatalog } from "./catalog";
import { closeServers, startServers, type ConnectFn, type ServerState } from "./manager";
import { loadTrustStore, requiresApproval } from "./trust";
import { connectStdioMcpServer } from "../mcp-client/client";
import { buildMcpChildEnv } from "./spawn-env";

/**
 * How long `close()` waits for outstanding dials before closing what it has.
 *
 * Short on purpose: the operator is quitting, and every millisecond past
 * this is a terminal that has stopped responding for a reason they cannot
 * see. Late arrivals are still closed, just not awaited.
 */
export const CLOSE_GRACE_MS = 750;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type McpRuntimeOptions = {
  readonly cwd: string;
  readonly gitRoot?: string | undefined;
  readonly configDir?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  /** Overridden in tests; otherwise spawns the server. */
  readonly connect?: ConnectFn | undefined;
};

/**
 * The handle the shell holds and the tool pair reads through.
 *
 * `catalog` and `servers` are FUNCTIONS, not values. A server that finishes
 * its handshake two seconds after the shell painted its prompt must become
 * searchable without anything being rebuilt.
 */
export type McpRuntime = {
  readonly catalog: () => ServerCatalog;
  readonly servers: () => readonly ServerState[];
  /** Per-tool timeout from config, for `use_tool`. */
  readonly toolTimeoutSec: (server: string, rawName: string) => number | undefined;
  /** Problems from reading the config files. Surfaced by the shell, not thrown. */
  readonly problems: () => readonly McpConfigProblem[];
  /** Resolves when every dial has settled. For tests and for `doctor`-like callers. */
  readonly ready: () => Promise<void>;
  readonly close: () => Promise<void>;
};

/**
 * Read the config and begin connecting. Never throws, never blocks.
 *
 * A malformed config or a server that will not start must not stop a shell
 * from opening — the same rule AC8 states for the connection itself. Both are
 * carried: `problems()` for the files, a `failed` state for the servers.
 */
export function createMcpRuntime(options: McpRuntimeOptions): McpRuntime {
  const config = loadMcpServers({
    cwd: options.cwd,
    gitRoot: options.gitRoot,
    configDir: options.configDir,
    env: options.env,
  });

  const byName = new Map(config.servers.map((server) => [server.name, server]));

  // Project-scoped servers the operator has not approved are held back
  // BEFORE anything is dialled. This is the gate between `git clone` and
  // arbitrary code execution; see `trust.ts`.
  const approvals = loadTrustStore(options.configDir);
  const held = config.servers.filter((server) => server.enabled && requiresApproval(server, approvals));
  const heldNames = new Set(held.map((server) => server.name));
  const launchable = config.servers.filter((server) => !heldNames.has(server.name));

  let catalog: ServerCatalog = mergeCatalogs([]);
  const heldStates: readonly ServerState[] = held.map((server) => ({
    name: server.name,
    status: "needs-approval" as const,
    toolCount: 0,
    error: `not started: run \`keryx mcp trust ${server.name}\` after reading what it launches`,
  }));

  let states: readonly ServerState[] = [
    ...heldStates,
    ...launchable.map((server) => ({
      name: server.name,
      // Reported as `connecting` from the outset rather than omitted: a server
      // the operator configured and cannot see anywhere reads as one keryx
      // never noticed.
      status: server.enabled ? ("connecting" as const) : ("disabled" as const),
      toolCount: 0,
    })),
  ];

  const settled = startServers(launchable, options.connect ?? defaultConnect)
    .then((result) => {
      catalog = result.catalog;
      // Held servers stay in the report. One that vanished would read as a
      // server keryx never saw, which is the state the operator would then
      // go looking for in the wrong file.
      states = [...heldStates, ...result.servers].sort((a, b) => a.name.localeCompare(b.name));
    })
    .catch(() => {
      // `startServers` is documented never to reject. If that ever stops
      // being true, the shell still opens — with every server stuck on
      // `connecting`, which is visible, rather than an unhandled rejection.
    });

  /**
   * Close each connection at most once.
   *
   * `close()` sweeps twice — immediately, and again when a dial that
   * outlived the grace lands. Without this the first sweep's connections
   * are closed a second time by the second, which is harmless for a real
   * SDK client and still wrong: a "closed" count that double-counts cannot
   * be used to prove anything about leaks, which is exactly what the tests
   * here do.
   */
  const closedAlready = new WeakSet<object>();
  const closeOnce = async (list: readonly ServerState[]): Promise<void> => {
    const fresh = list.filter(
      (state) => state.connection !== undefined && !closedAlready.has(state.connection),
    );
    for (const state of fresh) {
      if (state.connection !== undefined) closedAlready.add(state.connection);
    }
    await closeServers(fresh);
  };

  return {
    catalog: () => catalog,
    servers: () => states,
    toolTimeoutSec: (server, rawName) => timeoutFor(byName.get(server), rawName),
    problems: () => config.problems,
    ready: async () => {
      await settled;
    },
    close: async () => {
      // Bounded. `close()` used to `await settled` outright, so quitting a
      // session — or the TUI failing to init and falling through to readline
      // — blocked for as long as the outstanding dials took. That is the
      // per-server `startup_timeout_sec`, which has no upper bound in the
      // config, times the concurrency batches: eight unreachable servers at
      // the 15s default is thirty seconds of blank terminal.
      await Promise.race([settled, delay(CLOSE_GRACE_MS)]);
      await closeOnce(states);
      // Whatever lands after the grace is still closed — just not waited
      // for. Dropping it would trade the hang for a leak.
      void settled.then(() => closeOnce(states)).catch(() => {});
    },
  };
}

/** Per-tool override first, then the server-wide one. Seconds, as configured. */
function timeoutFor(server: ResolvedMcpServer | undefined, rawName: string): number | undefined {
  if (server === undefined) return undefined;
  return server.tool_timeouts?.[rawName] ?? server.tool_timeout_sec;
}

async function defaultConnect(server: ResolvedMcpServer): ReturnType<ConnectFn> {
  const command = server.command;
  if (command === undefined || command === "") {
    // Reached only for a `url` server, which P0 does not dial. Thrown rather
    // than silently skipped so it lands as a `failed` state with a reason.
    throw new Error(`server "${server.name}" is not stdio; remote servers arrive in a later release`);
  }
  return connectStdioMcpServer([command, ...(server.args ?? [])], {
    cwd: server.cwd ?? defaultServerCwd(server),
    env: buildMcpChildEnv({ parent: process.env, serverEnv: server.env }),
  });
}

/**
 * Where a server with no `cwd` of its own runs.
 *
 * For a PROJECT server: the project root its config file sits in, not
 * `process.cwd()`. A server configured in `<root>/.keryx/mcp-servers.json`
 * and launched from whatever directory the operator happened to `cd` into
 * would resolve its relative paths somewhere nobody chose.
 *
 * For a user-global server there is no such root, so the working directory
 * is the honest answer — it is genuinely not tied to any project.
 */
export function defaultServerCwd(server: ResolvedMcpServer, fallbackCwd = process.cwd()): string {
  if (server.source !== "project") return fallbackCwd;
  // `<root>/.keryx/mcp-servers.json` → `<root>`.
  return path.dirname(path.dirname(server.file));
}
