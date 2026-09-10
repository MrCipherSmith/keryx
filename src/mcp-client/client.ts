// stdio MCP client for one `codex mcp-server` child (flow 182, T6; AC1, AC2,
// AC7). Package: docs/requirements/keryx-mcp-client specification.md §1-§5.
//
// THE ONLY place `@modelcontextprotocol/sdk`'s CLIENT side is loaded, and ONLY
// via lazy `await import()` — mirrors `src/mcp/server.ts`'s `loadSdk()` for
// the server side exactly (same local structural types, so no SDK type is
// imported at module top-level, same `*SdkMissingError` hard-fail shape).
// The static import-boundary guard (`src/capability/no-optional-imports.test.ts`)
// enforces this for every file under `src/`, this one included.
//
// WHY THIS FILE BYPASSES `Client.prototype.setRequestHandler` FOR
// `elicitation/create` — read before touching the request-handler wiring
// below, because it looks removable and is not:
//
// The installed SDK's `Client` class (`client/index.js`) OVERRIDES
// `setRequestHandler` for `method === "elicitation/create"` specifically: it
// re-validates the RETURNED value against the standard `ElicitResultSchema`
// (via `safeParse`) and returns `validationResult.data` — i.e. the
// ZOD-PARSED, RE-STRIPPED result. That silently drops the non-standard
// top-level `decision` field this whole package exists to send (T5 live
// probe finding: codex's own `ExecApprovalResponse` deserializer reads
// `{action, decision}`, not `ElicitResult.content`). There is no
// registration-schema choice that avoids this: the override triggers on the
// LITERAL method name, not on which schema object was passed.
//
// The fix, verified by reading the installed SDK's source
// (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js` and
// `shared/protocol.js`) rather than assumed: `Protocol.prototype.setRequestHandler`
// (the BASE class method `Client` overrides) has none of this — it stores
// `(request, extra) => Promise.resolve(handler(parseWithCompat(requestSchema, request), extra))`
// and, on the request-dispatch side (`Protocol.prototype._onrequest`), sends
// the handler's return value AS THE RAW JSON-RPC `result`, unmodified. Calling
// `Protocol.prototype.setRequestHandler.call(client, ElicitRequestSchema, handler)`
// registers through that base path, keeping the SAME `_requestHandlers` map
// `_onrequest` reads (so no double-response / auto `MethodNotFound` — a
// handler genuinely is registered) while skipping the Client subclass's
// re-validation entirely. `ElicitRequestSchema` itself is fine to pass here
// even though it strips vendor fields on ITS parsed output, because this
// module's handler never reads that parsed value — see the raw-wire tap
// below for how `codex_call_id` etc. actually reach it.
//
// The raw-wire tap (T5's other named technique, "transport-level send/onmessage
// tap") is what supplies the untouched vendor fields: it is installed on
// `transport.onmessage` BEFORE `client.connect()` runs, so `Protocol.connect()`
// (which does `const _onmessage = transport.onmessage; transport.onmessage =
// (m, extra) => { _onmessage?.(m, extra); ...its own dispatch... }`) wraps IT,
// calling it first, synchronously, on every inbound message — before Protocol's
// own `_onrequest`/`_onnotification` ever run. The tap stashes the raw
// `elicitation/create` params (by request id) for the registered handler to
// read, and forwards every `codex/event` notification straight to this
// connection's `onCodexEvent` subscribers; it never suppresses or answers a
// message itself, so Protocol's own dispatch continues completely normally
// for the messages this module chooses not to interpret (e.g. tool-call
// responses correlating `client.callTool`'s own promise).
//
// `capabilities: { elicitation: {} }` on the `Client` constructor is NOT
// decorative: `Client.prototype.assertRequestHandlerCapability` — still
// consulted even through the base-class registration path, because `this`
// inside `Protocol.prototype.setRequestHandler` is the `client` instance —
// throws synchronously for `elicitation/create` when `this._capabilities.elicitation`
// is falsy. Omitting it breaks registration entirely, not just the response
// shape.
import { parseCodexEventNotification, parseElicitationCreateRequest } from "./wire";
import type {
  ElicitationResponsePayload,
  McpClientConnection,
  McpClientPort,
  McpSpawnOptions,
  McpToolCallOutcome,
  RawCodexEventNotification,
  RawElicitationRequest,
} from "./types";

export class McpClientSdkMissingError extends Error {
  constructor(cause?: unknown) {
    super(
      [
        "The Model Context Protocol SDK is not installed, but connecting to `codex mcp-server` requires it.",
        "",
        "Install it (it is an optional dependency):",
        "  bun add @modelcontextprotocol/sdk",
        "",
        "keryx's own MCP server (`keryx serve-mcp`) and every other command run without it.",
      ].join("\n"),
    );
    this.name = "McpClientSdkMissingError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal structural types for the SDK pieces this module depends on. Kept
// local, exactly like `src/mcp/server.ts`'s `SdkServer`, so no SDK type is
// imported at module top-level.
// ---------------------------------------------------------------------------

interface SdkTransport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: unknown, extra?: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  /**
   * The child's stderr, present only when the transport was constructed with
   * `stderr: "pipe"` — which `connectStdioMcpServer` does, so the stream has
   * to be drained. `readonly` and optional: the Codex path leaves it
   * inherited and has no such stream.
   */
  readonly stderr?: { resume(): void } | undefined;
}

interface SdkRequestHandlerExtra {
  readonly requestId: string | number;
}

interface SdkClient {
  connect(transport: SdkTransport): Promise<void>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema: unknown,
    options?: { timeout?: number },
  ): Promise<{ content?: unknown; isError?: boolean }>;
  listTools(
    params?: Record<string, unknown>,
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<{ tools?: unknown }>;
  close(): Promise<void>;
}

/** The base `Protocol.prototype.setRequestHandler` this module deliberately calls unbound — see the header. */
interface SdkProtocolRequestHandlerRegistrar {
  setRequestHandler(
    schema: unknown,
    handler: (request: unknown, extra: SdkRequestHandlerExtra) => Promise<unknown>,
  ): void;
}

/**
 * What ANY MCP stdio client needs: a client, a transport, and the result
 * schema for a tool call.
 *
 * Split from {@link SdkModules} so the generic path does not depend on the
 * elicitation-only internals below it. `loadSdk` reaches into
 * `Protocol.prototype`, which the SDK is not obliged to keep stable across the
 * minor bumps its `^1.0.0` range permits — and a user's filesystem server
 * failing to connect because an elicitation internal moved would be a failure
 * with no relationship to its cause.
 */
interface SdkCoreModules {
  Client: new (info: unknown, options: unknown) => SdkClient;
  StdioClientTransport: new (options: unknown) => SdkTransport;
  CallToolResultSchema: unknown;
}

interface SdkModules extends SdkCoreModules {
  ProtocolPrototype: SdkProtocolRequestHandlerRegistrar;
  ElicitRequestSchema: unknown;
}

/**
 * Lazily load the SDK client module + the base `Protocol` class + the two
 * schemas this module needs. Throws {@link McpClientSdkMissingError}
 * (actionable) when the optional dependency is absent.
 */
/**
 * The client, the stdio transport, and the tool-call result schema.
 *
 * Deliberately does NOT touch `shared/protocol.js`. See {@link SdkCoreModules}.
 */
async function loadCoreSdk(): Promise<SdkCoreModules> {
  try {
    const clientModule = await import("@modelcontextprotocol/sdk/client/index.js");
    const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const typesModule = await import("@modelcontextprotocol/sdk/types.js");
    return {
      Client: clientModule.Client as unknown as new (info: unknown, options: unknown) => SdkClient,
      StdioClientTransport: stdioModule.StdioClientTransport as unknown as new (options: unknown) => SdkTransport,
      CallToolResultSchema: typesModule.CallToolResultSchema,
    };
  } catch (error) {
    throw new McpClientSdkMissingError(error);
  }
}

async function loadSdk(): Promise<SdkModules> {
  const core = await loadCoreSdk();
  try {
    const protocolModule = await import("@modelcontextprotocol/sdk/shared/protocol.js");
    const typesModule = await import("@modelcontextprotocol/sdk/types.js");
    return {
      ...core,
      ProtocolPrototype: (protocolModule.Protocol as unknown as { prototype: SdkProtocolRequestHandlerRegistrar })
        .prototype,
      ElicitRequestSchema: typesModule.ElicitRequestSchema,
    };
  } catch (error) {
    throw new McpClientSdkMissingError(error);
  }
}

/**
 * JSON-RPC error code the SDK uses for BOTH a genuine `-32001` from the wire
 * and its own client-side request timeout (confirmed against the installed
 * SDK's `shared/protocol.js`: `ErrorCode.RequestTimeout = -32001`, thrown by
 * `_setupTimeout`'s handler as `'Request timed out'`). Named here rather than
 * imported from the SDK's `ErrorCode` enum, which would be a second static
 * surface to keep lazy — the numeric value is the stable part of the contract.
 */
const MCP_REQUEST_TIMEOUT_CODE = -32001;

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === MCP_REQUEST_TIMEOUT_CODE;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "unknown error";
  }
}

/**
 * Spawn `argv[0] argv.slice(1)`, complete the MCP handshake, and return a live
 * {@link McpClientConnection}. Allowed to throw — a connection that cannot be
 * established at all is genuinely broken, mirroring `ExternalSpawnPort.spawn`'s
 * same allowance in `src/harness/external/supervise.ts`.
 */
export async function connectCodexMcpClient(
  argv: readonly string[],
  options: McpSpawnOptions,
): Promise<McpClientConnection> {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error("mcp-client: connectCodexMcpClient called with empty argv");
  }

  const sdk = await loadSdk();

  const transport = new sdk.StdioClientTransport({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
  });

  // Installed BEFORE connect() — see the module header for why this matters.
  const pendingRawElicitations = new Map<string | number, RawElicitationRequest>();
  const codexEventHandlers: Array<(event: RawCodexEventNotification) => void> = [];
  let elicitationHandler: ((request: RawElicitationRequest) => Promise<ElicitationResponsePayload>) | undefined;

  transport.onmessage = (message: unknown): void => {
    const elicitation = parseElicitationCreateRequest(message);
    if (elicitation !== undefined) {
      pendingRawElicitations.set(elicitation.requestId, elicitation);
      return;
    }
    const codexEvent = parseCodexEventNotification(message);
    if (codexEvent !== undefined) {
      for (const handler of codexEventHandlers) handler(codexEvent);
    }
    // Everything else (tool-call responses, other protocol traffic) is left
    // for Protocol's own dispatch, which runs unconditionally after this tap
    // regardless of what this function does — see the module header.
  };

  const client = new sdk.Client(
    { name: "keryx-mcp-client", version: "0.1.0" },
    // Required for registration to succeed at all — see the module header.
    { capabilities: { elicitation: {} } },
  );

  // Registered through the BASE Protocol method, not `client.setRequestHandler`
  // — see the module header for exactly why.
  //
  // Wrapped in try/catch (flow 182 fix round): this is a deliberate reach
  // into an SDK internal (`Protocol.prototype`, not the public `Client` API),
  // and the SDK is pinned `"^1.0.0"` — permitting automatic minor/patch
  // bumps. If a future release restructures `Protocol.prototype` this call
  // would otherwise throw a raw, unguarded `TypeError` instead of the
  // existing, actionable {@link McpClientSdkMissingError} this file already
  // defines for the "SDK not installed" case. The operator-facing remediation
  // ("install/update the SDK to a version this reach still works against") is
  // the same class of problem either way, so this reuses that error type
  // rather than inventing a second one.
  try {
    sdk.ProtocolPrototype.setRequestHandler.call(
      client as unknown as SdkProtocolRequestHandlerRegistrar,
      sdk.ElicitRequestSchema,
      async (_parsedRequest: unknown, extra: SdkRequestHandlerExtra): Promise<ElicitationResponsePayload> => {
        const raw = pendingRawElicitations.get(extra.requestId);
        pendingRawElicitations.delete(extra.requestId);
        const request: RawElicitationRequest = raw ?? {
          requestId: extra.requestId,
          message: undefined,
          requestedSchema: undefined,
          vendor: {},
        };
        if (elicitationHandler === undefined) {
          // No consumer ever registered — deny safely, never hang the child
          // waiting on a response nobody will produce.
          return { action: "decline" };
        }
        return elicitationHandler(request);
      },
    );
  } catch (error) {
    throw new McpClientSdkMissingError(error);
  }

  await client.connect(transport);

  return {
    async callTool(name, callArgs, opts) {
      return callToolWithOutcome(client, sdk.CallToolResultSchema, name, callArgs, opts?.timeoutMs);
    },
    onElicitation(handler): void {
      elicitationHandler = handler;
    },
    onCodexEvent(handler): void {
      codexEventHandlers.push(handler);
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

/**
 * One tool call, with the three outcomes this module distinguishes.
 *
 * Shared by the Codex specialist and the generic server connection rather
 * than written twice. The distinction that matters is `timeout` versus
 * `error`: the SDK raises the same JSON-RPC code for a wire `-32001` and for
 * its own client-side deadline, and collapsing the two would report a server
 * that answered slowly the same way as one that refused.
 */
async function callToolWithOutcome(
  client: SdkClient,
  resultSchema: unknown,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number | undefined,
): Promise<McpToolCallOutcome> {
  try {
    const result = await client.callTool(
      { name, arguments: args },
      resultSchema,
      timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
    );
    return { kind: "result", result: { content: result.content, isError: result.isError === true } };
  } catch (error) {
    if (isTimeoutError(error)) return { kind: "timeout" };
    return { kind: "error", message: describeError(error) };
  }
}

/** The real port. Production wiring for `superviseCodexMcpRun`'s `client` dependency. */
export const codexMcpClientPort: McpClientPort = { connect: connectCodexMcpClient };

/** Argv for spawning the codex MCP server child. Pure; specification.md §3. */
export function buildCodexMcpServerArgv(): readonly string[] {
  return ["codex", "mcp-server"];
}

/** One tool as an MCP server describes it. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  /**
   * `ToolAnnotations` — `readOnlyHint`, `destructiveHint`, and friends.
   *
   * A SIBLING of `inputSchema` in the protocol, not a member of it. Carried
   * because a consumer that wants the hint has nowhere else to read it, and
   * dropping it here is indistinguishable from a server that sent none.
   */
  readonly annotations?: Record<string, unknown> | undefined;
}

/**
 * A connection to an operator-configured MCP server.
 *
 * Separate from {@link McpClientConnection}, which is the Codex specialist:
 * that one carries `onElicitation` and `onCodexEvent`, neither of which a
 * user's server sends and neither of which it should be offered. Sharing the
 * transport is right; sharing the specialist is how the specialist stops being
 * verifiable.
 */
export interface McpServerConnection {
  listTools(opts?: { readonly timeoutMs?: number }): Promise<McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<McpToolCallOutcome>;
  close(): Promise<void>;
}

/**
 * Normalize whatever a server returned for `tools/list`.
 *
 * Exported because it is the only part of `listTools` with a decision in it,
 * and a decision inside a closure that needs a subprocess to reach is a
 * decision nothing tests.
 *
 * Entries without a usable string name are DROPPED, not carried with an
 * `undefined` name. A catalog key that is not a string cannot be called, so a
 * nameless entry is a tool nobody can invoke — keeping it would put a row in
 * `doctor` and in the catalog that fails at the moment of use instead of at
 * the moment of listing.
 */
export function toToolDescriptors(raw: unknown): McpToolDescriptor[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((tool): McpToolDescriptor[] => {
    if (typeof tool !== "object" || tool === null) return [];
    const record = tool as {
      name?: unknown;
      description?: unknown;
      inputSchema?: unknown;
      annotations?: unknown;
    };
    if (typeof record.name !== "string" || record.name === "") return [];
    return [
      {
        name: record.name,
        description: typeof record.description === "string" ? record.description : undefined,
        inputSchema:
          typeof record.inputSchema === "object" &&
          record.inputSchema !== null &&
          !Array.isArray(record.inputSchema)
            ? (record.inputSchema as Record<string, unknown>)
            : undefined,
        // `annotations` is a SIBLING of `inputSchema` on `Tool`, never nested
        // inside it. Dropping it here meant `classifyToolRisk` — which was
        // reading it from inside `inputSchema`, a place the protocol never
        // puts it — could never see a real server's `readOnlyHint`. Every
        // honest read-only tool was advertised to the model as destructive,
        // and the only way to be classified `read` was to nest the field
        // where the spec says it does not go.
        annotations:
          typeof record.annotations === "object" &&
          record.annotations !== null &&
          !Array.isArray(record.annotations)
            ? (record.annotations as Record<string, unknown>)
            : undefined,
      },
    ];
  });
}

/**
 * Bound a handshake, and CLEAN UP the transport when the bound is hit.
 *
 * The distinction from a bare `Promise.race` is the cleanup callback: the
 * race decides what the caller sees, and this decides what happens to the
 * process the caller can no longer reach.
 */
async function withHandshakeTimeout(
  work: Promise<void>,
  ms: number | undefined,
  onTimeout: () => Promise<void>,
): Promise<void> {
  if (ms === undefined) {
    await work;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`MCP server did not complete the handshake within ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      await onTimeout();
      // The abandoned `connect` may still reject once the transport dies;
      // it is already subscribed by the race, so this only stops a late
      // rejection from surfacing as unhandled.
      void work.catch(() => {});
    }
  }
}

/**
 * Connect to a third-party stdio MCP server.
 *
 * No elicitation handler and no `codex/event` tap: this installs no
 * `transport.onmessage` at all, so every message reaches the SDK's own
 * dispatch. The Codex path taps that hook because it must correlate an
 * elicitation request before the SDK consumes it; a user server has no such
 * requirement, and installing the tap anyway would put keryx between a server
 * and its own protocol for no reason.
 *
 * `connectCodexMcpClient` above is untouched by this and stays the only thing
 * that reaches into `Protocol.prototype`.
 */
export async function connectStdioMcpServer(
  argv: readonly string[],
  options: McpSpawnOptions,
  handshakeTimeoutMs?: number,
  signal?: AbortSignal,
  /**
   * Collector for the close this function starts on abort or timeout.
   *
   * The caller needs it because `transport.close()` is GRACEFUL — the SDK
   * waits 2s before SIGTERM and another 2s before SIGKILL — so a caller
   * that aborts and immediately exits kills itself before the child gets a
   * signal, and the child is reparented to init.
   */
  kills?: Array<Promise<void>>,
): Promise<McpServerConnection> {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error("mcp-client: connectStdioMcpServer called with empty argv");
  }

  const sdk = await loadCoreSdk();
  const transport = new sdk.StdioClientTransport({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    // PIPED, not inherited. The SDK defaults this to `inherit`, which hands
    // a third-party server a direct writer to the operator's terminal: it
    // can emit cursor-positioning and colour escapes and paint a convincing
    // `✓ auto-approved shell: git status` line into the running TUI
    // transcript, or simply flood the screen. Neither needs the model's
    // cooperation and neither is attributable to the server that did it.
    stderr: "pipe",
  });

  // Drained and discarded. A piped stream nobody reads fills its buffer and
  // then blocks the child mid-write, which would turn "the server is noisy"
  // into "the server hangs" — a worse failure than the one being fixed.
  // `resume()` puts it in flowing mode with no consumer, so the bytes are
  // read and dropped.
  transport.stderr?.resume();

  // No `capabilities.elicitation`: this client does not implement it, and
  // advertising a capability it cannot serve invites requests it will fail.
  const client = new sdk.Client({ name: "keryx-mcp-servers", version: "0.1.0" }, { capabilities: {} });

  // The handshake is bounded HERE, where the transport is in scope, rather
  // than only by a `Promise.race` in the caller.
  //
  // A race abandons; it does not cancel. A server that spawns and never
  // answers `initialize` left the caller with no reference to the child it
  // had started, so: the process lived until the SDK's own 60s request
  // timeout (measured: `keryx` took 62.3s to exit with one such server
  // configured, against 0.9s with none), and a SIGINT inside that window
  // exited the parent and ORPHANED the child (measured: a live PID
  // reparented to init).
  //
  // Closing the transport on timeout kills the child, so there is nothing
  // left to abandon and nothing to defer.
  const kill = (): Promise<void> => {
    const done = (async (): Promise<void> => {
      try {
        await transport.close();
      } catch {
        // Already gone; whatever is thrown below is the error worth having.
      }
    })();
    kills?.push(done);
    return done;
  };

  // A caller that gives up BEFORE the budget elapses — the session quitting,
  // Ctrl-C — aborts. Without this the child outlives the parent: measured
  // with a 30s budget and a `close()` at 750ms, the spawned process was
  // still alive after the parent exited, reparented to init. A timeout that
  // has not fired yet cleans up nothing.
  // Tracked in a local rather than re-reading `signal.aborted`, because the
  // check before the await narrows the type and the check after it is
  // exactly the one that must see a CHANGED value.
  let aborted = signal?.aborted ?? false;
  if (aborted) {
    await kill();
    throw new Error("mcp-client: connect aborted before it began");
  }
  const onAbort = (): void => {
    aborted = true;
    void kill();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await withHandshakeTimeout(client.connect(transport), handshakeTimeoutMs, kill);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (aborted) {
    // The handshake won the race with the abort. The caller is gone, so
    // hand back nothing and leave no process behind.
    await kill();
    throw new Error("mcp-client: connect aborted");
  }

  return {
    async listTools(opts): Promise<McpToolDescriptor[]> {
      const result = await client.listTools(
        {},
        undefined,
        opts?.timeoutMs === undefined ? undefined : { timeout: opts.timeoutMs },
      );
      return toToolDescriptors(result.tools);
    },

    async callTool(name, callArgs, opts): Promise<McpToolCallOutcome> {
      return callToolWithOutcome(client, sdk.CallToolResultSchema, name, callArgs, opts?.timeoutMs);
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
