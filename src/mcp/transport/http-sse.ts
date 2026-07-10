// HTTP/SSE transport — SECOND, opt-in transport (specification.md §9; M-8, M-12,
// NG-A3, AC8).
//
// Fully isolated and removable: it is imported ONLY from the `--http` branch of
// `server.ts`, so deleting this file leaves the stdio path completely
// functional. Localhost only, no auth (NG-A3) — it is a developer-local bridge,
// not a public endpoint. The SDK's Streamable-HTTP transport is loaded lazily so
// there is no top-level SDK import here either.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface ConnectableServer {
  connect(transport: unknown): Promise<void>;
}

export interface HttpTransportOptions {
  host: string;
  port: number;
}

// Start a localhost-only HTTP endpoint that bridges to the MCP server via the
// SDK's Streamable-HTTP transport (stateless mode). Binds strictly to the
// configured host (default 127.0.0.1); no authentication is layered on (NG-A3).
export async function startHttpTransport(
  server: ConnectableServer,
  options: HttpTransportOptions,
): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  // Stateless mode (a single local process): `sessionIdGenerator: undefined`.
  // Cast around exactOptionalPropertyTypes without a top-level SDK type import.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  await server.connect(transport);

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    // Bind to localhost only. `port: 0` lets the OS pick a free port.
    httpServer.listen(options.port, options.host, () => resolve());
  });
}
