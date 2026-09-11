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
import { connectHttpMcpServer, connectStdioMcpServer } from "../mcp-client/client";
import { describeHollow, remoteTargetProblem, resolveHttpHeaders } from "./http-headers";
import { isExpired, readCredential, usesOAuth, type CredentialRecord } from "./credentials";
import { createOAuthProvider, type ProviderDeps } from "./oauth-provider";
import { transportOf } from "./doctor";
import { buildMcpChildEnv } from "./spawn-env";

/**
 * How long `close()` waits for outstanding dials before closing what it has.
 *
 * Short on purpose: the operator is quitting, and every millisecond past
 * this is a terminal that has stopped responding for a reason they cannot
 * see. Late arrivals are still closed, just not awaited.
 */
export const CLOSE_GRACE_MS = 750;

/**
 * How long `close()` waits for an aborted dial's child to actually die.
 *
 * The SDK escalates `stdin.end()` → 2s → SIGTERM → 2s → SIGKILL, so
 * anything under ~4s can return before the child is gone. Measured: with
 * the parent living 0/500/1000ms past `close()` the child survived; at
 * 1500ms it did not. This is longer than that, because the measurement was
 * on an idle machine.
 */
export const KILL_GRACE_MS = 4_500;

/**
 * Wait for `work`, but no longer than `ms` — and take the timer down either way.
 *
 * This was `Promise.race([work, delay(ms)])`, and the losing timer stayed armed.
 * The CLI exits by setting `exitCode` rather than calling `process.exit`, so an
 * armed timer is a reason to stay alive: every `close()` held the process for its
 * full grace — about 4.5 s after every refused start and every `-p` run, even when
 * the work had finished at once (flow 251, review F-001). Cleared rather than
 * `unref`'d, because an unref'd bound lets the process exit in the middle of the
 * `finally` that awaits it, before the terminal is restored or the exit code set.
 */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  /**
   * The servers as CONFIGURED, joined by name to the states above.
   *
   * Exposed so the `/mcp` view can show a server's source, transport and
   * target without loading the config a second time. A second read is how
   * the shell and `keryx mcp list` came to disagree about which project
   * root to walk — two surfaces, two answers, and the one the operator
   * was looking at was the wrong one.
   */
  readonly configured: () => readonly ResolvedMcpServer[];
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
  // Aborted by `close()`. A dial in flight has no connection to close yet,
  // so the only way to reach its child process is to tell the dial itself
  // to give up — see the abort handling in `connectStdioMcpServer`.
  const dialling = new AbortController();

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

  // Kills started by an abort, so `close()` can WAIT for them.
  //
  // The abort was already wired; the problem was a budget mismatch nobody
  // had measured. The SDK's `StdioClientTransport.close()` is graceful:
  // `stdin.end()`, then a 2s wait, THEN SIGTERM, then another 2s, then
  // SIGKILL. `close()` returned at 750ms and `process.exit` followed, so
  // the first signal never went out and the child was reparented to init —
  // on all four exit paths a verifier tried.
  const kills: Array<Promise<void>> = [];
  // `options.env` is threaded all the way to the dial, not just to
  // `loadMcpServers`. It was read back from `process.env` inside
  // `connectRemote`, which made the runtime's own env option a half-truth:
  // the config was resolved against the injected environment and the
  // CREDENTIALS were resolved against the real one. A test could inject
  // `{}` and watch the refusal happen for the wrong reason — because the
  // developer's shell had no `TOKEN` either — and the same test would go
  // green on a machine where it did, having proved nothing about the code.
  const env = options.env ?? process.env;
  const connect = options.connect ?? ((server) => defaultConnect(server, env, dialling.signal, kills, options.configDir));
  const settled = startServers(launchable, connect)
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

  // Idempotent: the second caller gets the first caller's close, not a second run
  // of the waits. The shell closes the readline runtime in two places — the REPL's
  // own `finally` and the command's outer one, which is what catches a start-up
  // refusal (K-012) — and the second must cost nothing.
  let closing: Promise<void> | undefined;

  return {
    catalog: () => catalog,
    servers: () => states,
    toolTimeoutSec: (server, rawName) => timeoutFor(byName.get(server), rawName),
    problems: () => config.problems,
    configured: () => config.servers,
    ready: async () => {
      await settled;
    },
    close: () => (closing ??= closeNow()),
  };

  async function closeNow(): Promise<void> {
    {
      // Bounded. `close()` used to `await settled` outright, so quitting a
      // session — or the TUI failing to init and falling through to readline
      // — blocked for as long as the outstanding dials took. That is the
      // per-server `startup_timeout_sec`, which has no upper bound in the
      // config, times the concurrency batches: eight unreachable servers at
      // the 15s default is thirty seconds of blank terminal.
      // Abort FIRST. The grace below is for dials that are about to
      // succeed; aborting is what deals with the ones that will not, and
      // without it a `close()` inside the handshake budget left the child
      // running and the parent exited out from under it.
      dialling.abort();
      await within(settled, CLOSE_GRACE_MS);
      await closeOnce(states);
      // AWAIT the kills the abort started, bounded by how long the SDK's
      // graceful close actually takes to reach SIGKILL. Returning before
      // this is what orphaned the child: the caller's very next statement
      // is `process.exit`, and "still closed, just not awaited" is only
      // true while the process survives.
      await within(Promise.all(kills), KILL_GRACE_MS);
      // Whatever lands after all of that is still closed — a dial that has
      // not even reached the abort handler yet.
      void settled.then(() => closeOnce(states)).catch(() => {});
    }
  }
}

/**
 * The dial budget, clamped.
 *
 * `startup_timeout_sec` has no upper bound in the config and reaches
 * `setTimeout`, where anything past 2^31-1 ms overflows and silently becomes
 * 1 ms — so a config asking for a very long budget got the shortest possible
 * one. Clamped to a day, which is longer than any real handshake and inside
 * the 32-bit range.
 */
export function handshakeBudgetMs(server: ResolvedMcpServer): number {
  const configured = server.startup_timeout_sec;
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_HANDSHAKE_MS;
  }
  return Math.min(configured * 1000, MAX_TIMEOUT_MS);
}

/** One day. Above `setTimeout`'s 32-bit ceiling the value silently becomes 1ms. */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HANDSHAKE_MS = 15_000;

/**
 * Dial a remote server, refusing before the socket if a credential is hollow.
 *
 * The refusal is the whole of AC19 and it happens HERE rather than inside
 * the transport, so the message names the variable the operator has to set
 * instead of reporting a 401 from somebody else's server.
 */
/**
 * How a SESSION builds its OAuth provider, or why it builds none.
 *
 * Exported and pure because it was none of those things: inline in
 * `connectRemote`, which is not exported, three of its decisions could
 * not be reached by any test and all three survived mutation. Two of
 * them fail silently — a dropped `configDir` reads the wrong store, a
 * dropped `clientId` registers a client the operator already has — and
 * the third disables OAuth for every session without a word.
 *
 * OAuth only for a server that has said nothing else. A header or a
 * `bearer_token_env_var` is an explicit instruction about how to
 * authenticate, and starting a flow anyway would be keryx overriding
 * it; `oauth: false` opts out entirely for a server that is public.
 */
/**
 * The redirect a session declares and never serves.
 *
 * Loopback, so it cannot describe a reachable third party even if
 * something did send an operator there.
 */
export const SESSION_REDIRECT_URL = "http://127.0.0.1/keryx-session-never-listens";

export function sessionAuthProviderOptions(
  server: ResolvedMcpServer,
  runtimeConfigDir?: string,
  stored?: CredentialRecord | undefined,
  now: number = Date.now(),
): ProviderDeps | undefined {
  // The RAW entry: a declared credential is an instruction even when
  // its variable is unset, and the resolved headers are empty in
  // exactly that case.
  if (!usesOAuth(server.raw)) return undefined;

  // NO USABLE CREDENTIAL: NO PROVIDER.
  //
  // Not an optimisation. Handing the SDK a provider it cannot satisfy
  // makes it start a new authorisation, and the FIRST thing that does
  // is POST a dynamic client registration to the operator's
  // authorisation server — unattended, from a shell starting up,
  // against a third party nobody asked keryx to touch. Refusing
  // inside `saveClientInformation` is too late: the request has
  // already been sent and the client already exists.
  //
  // Dialling bare instead is both safer and more accurate. A server
  // that needs authorisation answers 401, which `needsAuthorisation`
  // already classifies as `needs_auth`; a PUBLIC server answers
  // normally, which is exactly the behaviour the doctor regression
  // taught us to preserve.
  const tokens = stored?.tokens;
  if (tokens === undefined) return undefined;
  if (isExpired(tokens, now) && tokens.refresh_token === undefined) return undefined;
  return {
    serverName: server.name,
    serverUrl: server.url as string,
    ...(runtimeConfigDir === undefined ? {} : { configDir: runtimeConfigDir }),
    // PRESENT, AND NEVER LISTENED ON.
    //
    // This looks wrong — a session has nowhere to be redirected to,
    // so `undefined` is the honest value — and it cost this release a
    // blocker. The SDK computes `nonInteractiveFlow = !provider.redirectUrl`
    // and, finding none, short-circuits into a client-credentials
    // grant BEFORE the refresh branch: no refresh was ever attempted,
    // the stored token stayed stale, and the resulting error carried
    // no status, so `needsAuthorisation` said false and doctor
    // reported "failed" instead of "needs_auth".
    //
    // Its value is never used. A refresh grant does not send a
    // redirect_uri, and every path that would use one — registration,
    // `state()`, `redirectToAuthorization` — refuses first, because
    // `interactive` is false below.
    redirectUrl: SESSION_REDIRECT_URL,
    // NEVER interactive from the runtime. A session opening must not
    // launch a browser: the operator did not ask for one, and on a
    // headless box it would block the shell from starting. `keryx mcp
    // auth` is the interactive entry point.
    interactive: false,
    ...(server.oauth === false || server.oauth?.clientId === undefined
      ? {}
      : { clientId: server.oauth.clientId }),
    ...(server.oauth === false || server.oauth?.scopes === undefined
      ? {}
      : { scopes: server.oauth.scopes }),
  };
}

async function connectRemote(
  server: ResolvedMcpServer,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  runtimeConfigDir?: string,
): ReturnType<ConnectFn> {
  // The TARGET first, then the credential. Both refusals happen before a
  // socket, and both are shared with `doctor` rather than reimplemented:
  // the url checks lived only in `doctor` until a reviewer noticed the
  // session dial called neither, so a config `doctor` refused would
  // connect to the wrong path in the shell it was pre-flighting.
  const target = remoteTargetProblem(server.raw, env);
  if (target !== undefined) {
    throw new Error(`server "${server.name}": ${target}`);
  }
  const resolved = resolveHttpHeaders(server, server.raw, env);
  if (!resolved.ok) {
    throw new Error(`server "${server.name}": ${describeHollow(resolved.hollow)}`);
  }

  const options = sessionAuthProviderOptions(
    server,
    runtimeConfigDir,
    server.url === undefined ? undefined : readCredential(server.name, server.url, runtimeConfigDir).record,
  );
  const authProvider = options === undefined ? undefined : createOAuthProvider(options);
  return connectHttpMcpServer(server.url as string, {
    headers: resolved.headers,
    ...(authProvider === undefined ? {} : { authProvider }),
    handshakeTimeoutMs: handshakeBudgetMs(server),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Per-tool override first, then the server-wide one. Seconds, as configured. */
function timeoutFor(server: ResolvedMcpServer | undefined, rawName: string): number | undefined {
  if (server === undefined) return undefined;
  return server.tool_timeouts?.[rawName] ?? server.tool_timeout_sec;
}

/**
 * Dial a configured server the way the session dials it.
 *
 * Exported because `keryx mcp doctor` had its OWN copy of this function,
 * hand-duplicated down to the comments — and the copies had already
 * drifted: the doctor's resolved credentials from `process.env` while its
 * caller passed `options.env` everywhere else, so the command whose entire
 * job is to tell you whether a server will work could dial with a
 * different environment than the session would.
 *
 * A pre-flight that does not run the real procedure is not a pre-flight.
 * There is one procedure now, and both callers pass their `env` into it.
 */
export async function defaultConnect(
  server: ResolvedMcpServer,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  kills?: Array<Promise<void>>,
  configDir?: string,
): ReturnType<ConnectFn> {
  if (transportOf(server) === "http") return connectRemote(server, env, signal, configDir);

  const command = server.command;
  if (command === undefined || command === "") {
    throw new Error(`server "${server.name}" sets neither command nor url`);
  }
  return connectStdioMcpServer(
    [command, ...(server.args ?? [])],
    {
      cwd: server.cwd ?? defaultServerCwd(server),
      env: buildMcpChildEnv({ parent: env, serverEnv: server.env }),
    },
    // Bounded at the transport, so a server that never handshakes has its
    // child KILLED rather than merely abandoned by the caller's race. See
    // the comment in `connectStdioMcpServer`.
    handshakeBudgetMs(server),
    signal,
    kills,
  );
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
