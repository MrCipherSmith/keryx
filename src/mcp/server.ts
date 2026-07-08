// stdio-first MCP server loop (specification.md §3, §9; T5, AC1, AC2, AC8, AC10).
//
// THE ONLY place the MCP SDK is loaded, and ONLY via lazy `await import()`
// (M-6, C0-2). There is NO top-level import of `@modelcontextprotocol/sdk`
// anywhere in `src/` — the static import-boundary guard enforces this. On any
// non-`serve` path the SDK is never touched, so the deterministic core stays
// byte-identical (M-7, C0-7).
//
// Sanctioned XP2 exception (AC10): when `mcp serve` is invoked and the SDK is
// not installed, we HARD-FAIL with an actionable message rather than degrade —
// the single opt-in command allowed to hard-require its dependency.

import {
  buildMcpContext,
  dispatchCallTool,
  dispatchListResources,
  dispatchListTools,
  dispatchReadResource,
  type McpContext,
} from "./dispatch";

export class McpSdkMissingError extends Error {
  constructor(cause?: unknown) {
    super(
      [
        "The Model Context Protocol SDK is not installed, but `mcp serve` requires it.",
        "",
        "Install it (it is an optional dependency):",
        "  bun add @modelcontextprotocol/sdk",
        "",
        "Then re-run `keryx mcp serve`. All other commands run without the SDK.",
      ].join("\n"),
    );
    this.name = "McpSdkMissingError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

const SERVER_INFO = { name: "keryx-mcp", version: "0.1.0" } as const;

// Lazily load the SDK server module + request schemas. Throws
// `McpSdkMissingError` (actionable) when the optional dependency is absent.
async function loadSdk(): Promise<{
  Server: new (info: unknown, options: unknown) => SdkServer;
  schemas: {
    ListToolsRequestSchema: unknown;
    CallToolRequestSchema: unknown;
    ListResourcesRequestSchema: unknown;
    ReadResourceRequestSchema: unknown;
  };
}> {
  try {
    const serverModule = await import("@modelcontextprotocol/sdk/server/index.js");
    const typesModule = await import("@modelcontextprotocol/sdk/types.js");
    return {
      Server: serverModule.Server as unknown as new (
        info: unknown,
        options: unknown,
      ) => SdkServer,
      schemas: {
        ListToolsRequestSchema: typesModule.ListToolsRequestSchema,
        CallToolRequestSchema: typesModule.CallToolRequestSchema,
        ListResourcesRequestSchema: typesModule.ListResourcesRequestSchema,
        ReadResourceRequestSchema: typesModule.ReadResourceRequestSchema,
      },
    };
  } catch (error) {
    throw new McpSdkMissingError(error);
  }
}

// Minimal structural type for the SDK `Server` we depend on. Kept local so no
// SDK type is imported at module top-level.
interface SdkServer {
  setRequestHandler(
    schema: unknown,
    handler: (request: {
      params?: Record<string, unknown>;
    }) => Promise<unknown>,
  ): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

// Build a configured (but not-yet-connected) SDK Server whose handlers delegate
// to the pure dispatch core. Exported so the round-trip test can connect it over
// an in-memory transport without spawning a subprocess.
export async function createMcpServer(ctx: McpContext): Promise<SdkServer> {
  const { Server, schemas } = await loadSdk();
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
  });

  server.setRequestHandler(schemas.ListToolsRequestSchema, async () => ({
    tools: dispatchListTools(ctx),
  }));

  server.setRequestHandler(schemas.CallToolRequestSchema, async (request) => {
    const params = request.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
    const result = await dispatchCallTool(ctx, name, args);
    return {
      content: [{ type: "text", text: result.text }],
      isError: result.isError,
    };
  });

  server.setRequestHandler(schemas.ListResourcesRequestSchema, async () => ({
    resources: await dispatchListResources(ctx),
  }));

  server.setRequestHandler(schemas.ReadResourceRequestSchema, async (request) => {
    const uri = typeof request.params?.uri === "string" ? request.params.uri : "";
    const contents = await dispatchReadResource(ctx, uri);
    return {
      contents: [
        { uri: contents.uri, mimeType: contents.mimeType, text: contents.text },
      ],
    };
  });

  return server;
}

export interface ServeOptions {
  cwd: string;
  http?: boolean;
}

// Entry point for `keryx mcp serve`. Loads the SDK (hard-fail if missing),
// builds the server, and connects the default stdio transport — or the isolated
// HTTP/SSE opt-in when `--http` is passed and the capability is enabled.
export async function serveMcp(options: ServeOptions): Promise<void> {
  const ctx = await buildMcpContext(options.cwd);
  const server = await createMcpServer(ctx);

  if (options.http) {
    if (!ctx.discovery.httpCapabilityEnabled) {
      throw new Error(
        "HTTP/SSE transport requires capabilities.http.enabled=true in modules.mcp. " +
          "It is a separate opt-in; the default transport is stdio.",
      );
    }
    // The HTTP transport is fully isolated in ./transport/http-sse. It is
    // imported ONLY here, so deleting that file leaves the stdio path working.
    const { startHttpTransport } = await import("./transport/http-sse");
    await startHttpTransport(server, {
      host: ctx.config.http.host,
      port: ctx.config.http.port,
    });
    return;
  }

  const { startStdioTransport } = await import("./transport/stdio");
  await startStdioTransport(server);
}
