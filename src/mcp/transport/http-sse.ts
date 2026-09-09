// HTTP/SSE transport — SECOND, opt-in transport (specification.md §9; M-8, M-12,
// NG-A3, AC8).
//
// Fully isolated and removable: it is imported ONLY from the `--http` branch of
// `server.ts`, so deleting this file leaves the stdio path completely
// functional. Localhost only, no auth (NG-A3) — it is a developer-local bridge,
// not a public endpoint. The SDK's Streamable-HTTP transport is loaded lazily so
// there is no top-level SDK import here either.

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { McpHttpConfigError, resolveMcpLoopbackHost } from "./loopback-host";

export { resolveMcpLoopbackHost } from "./loopback-host";

interface ConnectableServer {
  connect(transport: unknown): Promise<void>;
}

export interface HttpTransportOptions {
  host: string;
  port: number;
}

/** Loopback binding alone does not protect against a browser's foreign origin. */
export function isTrustedMcpHttpRequest(
  headers: IncomingHttpHeaders,
  hosts: readonly string[],
  port: number,
): boolean {
  const authority = headers.host?.toLowerCase();
  if (!authority || headers["sec-fetch-site"] === "cross-site") return false;
  const allowed = hosts.some((host) => {
    if (host.toLowerCase() !== "localhost" && isIP(host) === 0) return false;
    const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return authority === `${literal.toLowerCase()}:${port}` || (port === 80 && authority === literal.toLowerCase());
  });
  if (!allowed) return false;
  return headers.origin === undefined || headers.origin.toLowerCase() === `http://${authority}`;
}

// Start a localhost-only HTTP endpoint that bridges to the MCP server via the
// SDK's Streamable-HTTP transport (stateless mode). Binds strictly to the
// configured host (default 127.0.0.1); no authentication is layered on (NG-A3).
export async function startHttpTransport(
  server: ConnectableServer,
  options: HttpTransportOptions,
): Promise<Server> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new McpHttpConfigError("MCP_HTTP_INVALID_PORT", "MCP HTTP port must be an integer from 0 to 65535.");
  }
  const host = await resolveMcpLoopbackHost(options.host);
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
    const bound = httpServer.address();
    if (!bound || typeof bound === "string" ||
      !isTrustedMcpHttpRequest(req.headers, [host, "localhost"], bound.port)) {
      res.writeHead(403).end("MCP HTTP request origin is not allowed.");
      return;
    }
    void transport.handleRequest(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500).end("MCP HTTP request failed.");
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      httpServer.once("error", onError);
      // Bind the verified address. `port: 0` lets the OS pick a free port.
      httpServer.listen(options.port, host, () => {
        httpServer.removeListener("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await transport.close().catch(() => console.error("MCP HTTP transport cleanup failed."));
    throw error;
  }
  return httpServer;
}
