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
        "keryx's own MCP server (`keryx mcp serve`) and every other command run without it.",
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
  close(): Promise<void>;
}

/** The base `Protocol.prototype.setRequestHandler` this module deliberately calls unbound — see the header. */
interface SdkProtocolRequestHandlerRegistrar {
  setRequestHandler(
    schema: unknown,
    handler: (request: unknown, extra: SdkRequestHandlerExtra) => Promise<unknown>,
  ): void;
}

interface SdkModules {
  Client: new (info: unknown, options: unknown) => SdkClient;
  StdioClientTransport: new (options: unknown) => SdkTransport;
  ProtocolPrototype: SdkProtocolRequestHandlerRegistrar;
  ElicitRequestSchema: unknown;
  CallToolResultSchema: unknown;
}

/**
 * Lazily load the SDK client module + the base `Protocol` class + the two
 * schemas this module needs. Throws {@link McpClientSdkMissingError}
 * (actionable) when the optional dependency is absent.
 */
async function loadSdk(): Promise<SdkModules> {
  try {
    const clientModule = await import("@modelcontextprotocol/sdk/client/index.js");
    const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const protocolModule = await import("@modelcontextprotocol/sdk/shared/protocol.js");
    const typesModule = await import("@modelcontextprotocol/sdk/types.js");
    return {
      Client: clientModule.Client as unknown as new (info: unknown, options: unknown) => SdkClient,
      StdioClientTransport: stdioModule.StdioClientTransport as unknown as new (options: unknown) => SdkTransport,
      ProtocolPrototype: (protocolModule.Protocol as unknown as { prototype: SdkProtocolRequestHandlerRegistrar })
        .prototype,
      ElicitRequestSchema: typesModule.ElicitRequestSchema,
      CallToolResultSchema: typesModule.CallToolResultSchema,
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
      try {
        const result = await client.callTool(
          { name, arguments: callArgs },
          sdk.CallToolResultSchema,
          opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined,
        );
        return {
          kind: "result",
          result: { content: result.content, isError: result.isError === true },
        };
      } catch (error) {
        if (isTimeoutError(error)) return { kind: "timeout" };
        return { kind: "error", message: describeError(error) };
      }
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

/** The real port. Production wiring for `superviseCodexMcpRun`'s `client` dependency. */
export const codexMcpClientPort: McpClientPort = { connect: connectCodexMcpClient };

/** Argv for spawning the codex MCP server child. Pure; specification.md §3. */
export function buildCodexMcpServerArgv(): readonly string[] {
  return ["codex", "mcp-server"];
}
