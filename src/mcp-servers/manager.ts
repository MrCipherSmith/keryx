// Starting the configured servers, and surviving the ones that do not start.
//
// P0 item 3. The rule this module exists for is AC8: two servers configured,
// one command missing, the good one connects and the session starts. A
// partial failure that takes the session down is worse than the server that
// failed — the operator loses everything to fix one thing.

import type { McpServerConnection, McpToolDescriptor } from "../mcp-client/client";
import type { ResolvedMcpServer } from "./config";
import { catalogForServer, mergeCatalogs, type ServerCatalog } from "./catalog";

/** Specification §5.2. `needs_auth` belongs to P3 and is not produced here. */
export type ServerStatus = "connected" | "disabled" | "failed" | "needs_auth" | "connecting";

export type ServerState = {
  readonly name: string;
  readonly status: ServerStatus;
  /** Present when `failed`. Never a secret: config values are not echoed. */
  readonly error?: string | undefined;
  readonly toolCount: number;
  readonly connection?: McpServerConnection | undefined;
};

export type StartResult = {
  readonly servers: ServerState[];
  readonly catalog: ServerCatalog;
};

/**
 * How many servers are dialled at once.
 *
 * Grok Build uses 8. This starts at 4 and says so rather than leaving a bare
 * number in the code: each connection is a spawned process holding a pipe,
 * and the cost of guessing high is paid at every shell start by operators who
 * configured more servers than they use. Raising it is a measurement, not an
 * opinion — which is why the number is named and not inlined.
 */
export const DEFAULT_CONNECT_CONCURRENCY = 4;

export type ConnectFn = (server: ResolvedMcpServer) => Promise<McpServerConnection>;

export type StartOptions = {
  readonly concurrency?: number | undefined;
  /** Per-server dial budget. `startup_timeout_sec` on the entry overrides it. */
  readonly defaultStartupTimeoutMs?: number | undefined;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

/**
 * Connect every enabled server, bounded, and never throw.
 *
 * A rejected dial becomes a `failed` state with its message, not an exception:
 * the caller is a shell that has to start regardless. The only way this
 * function fails the session is by being given a `connect` that hangs, which
 * is why the dial is raced against a timeout rather than awaited bare — a
 * server whose process starts and never answers the handshake would otherwise
 * hold the shell open forever, which is the failure mode with no error
 * message at all.
 */
export async function startServers(
  servers: readonly ResolvedMcpServer[],
  connect: ConnectFn,
  options: StartOptions = {},
): Promise<StartResult> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONNECT_CONCURRENCY);
  const states = new Map<string, ServerState>();
  const catalogs: ServerCatalog[] = [];

  const enabled: ResolvedMcpServer[] = [];
  for (const server of servers) {
    if (server.enabled) {
      enabled.push(server);
    } else {
      // Recorded, not omitted. A disabled server absent from the report reads
      // as a server that was never configured.
      states.set(server.name, { name: server.name, status: "disabled", toolCount: 0 });
    }
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const server = enabled[index];
      if (server === undefined) return;

      const timeoutMs =
        server.startup_timeout_sec !== undefined
          ? server.startup_timeout_sec * 1000
          : (options.defaultStartupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);

      try {
        const connection = await withTimeout(connect(server), timeoutMs, server.name);
        const tools = await withTimeout(connection.listTools(), timeoutMs, server.name);
        const catalog = catalogForServer(server.name, tools as McpToolDescriptor[]);
        catalogs.push(catalog);
        states.set(server.name, {
          name: server.name,
          status: "connected",
          toolCount: catalog.entries.length,
          connection,
        });
      } catch (error) {
        states.set(server.name, {
          name: server.name,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          toolCount: 0,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(enabled.length, 1)) }, worker));

  return {
    // Sorted by name so two runs over the same config report in the same
    // order; `doctor` output that reshuffles is output nobody can diff.
    servers: [...states.values()].sort((a, b) => a.name.localeCompare(b.name)),
    catalog: mergeCatalogs(catalogs),
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`server "${name}" did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Close every open connection, and do not let one bad close hide the others. */
export async function closeServers(states: readonly ServerState[]): Promise<void> {
  await Promise.all(
    states.map(async (state) => {
      try {
        await state.connection?.close();
      } catch {
        // A close that throws has already lost the process; surfacing it would
        // replace a clean shutdown with an error about shutting down.
      }
    }),
  );
}
