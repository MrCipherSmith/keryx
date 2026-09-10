// A real streamable-HTTP MCP server on a loopback port. Test fixture.
//
// AC3 requires the handshake to be proved against a LOCAL mock, with no live
// third-party network in CI. Two things follow from wanting that proof to be
// worth anything:
//
//   - it speaks real HTTP on a real socket, so the transport under test is
//     the transport that ships. A stubbed `fetch` would prove the code
//     around the transport and skip the transport.
//   - it RECORDS the requests it received, headers included, and exposes
//     them for the test to read. AC3 and AC19 are both about what arrived
//     at the far end, and "keryx believes it sent a header" is not that.
//
// Hand-rolled JSON-RPC rather than the SDK's server half, for the same
// reason `echo-server.ts` is: the client under test loads the SDK, and if
// both sides shared it a framing bug would cancel out.

export type RecordedRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
};

export type MockHttpMcpServer = {
  readonly url: string;
  /** Every request that arrived, in order, headers included. */
  readonly requests: () => readonly RecordedRequest[];
  readonly stop: () => Promise<void>;
};

export type MockOptions = {
  /** Tools the server advertises. Defaults to two. */
  readonly tools?: Array<Record<string, unknown>>;
  /** Answer every request with this status instead of speaking MCP. */
  readonly failWith?: number;
  /** Answer with valid HTTP that is not MCP at all. */
  readonly notMcp?: boolean;
  /** Delay every response by this many ms, to exercise the handshake bound. */
  readonly delayMs?: number;
  /** Require this exact Authorization value; 401 without it. */
  readonly requireAuth?: string;
  /**
   * Answer with `text/event-stream` instead of a JSON body.
   *
   * D-06 says `sse` is not a separate transport: it is what the server
   * chooses when it responds, and streamable HTTP negotiates it. That
   * decision had no test — every fixture reply was `application/json`, so
   * the whole SSE half of the transport was asserted by a sentence in a
   * decision record. A server that streams is the common case for the
   * hosted MCP endpoints this feature exists to reach.
   */
  readonly sse?: boolean;
  /**
   * Answer with a 307 to this URL.
   *
   * `fetch` follows up to 20 hops by default and only strips
   * `Authorization` across origins — a custom credential header, which is
   * the common MCP pattern, follows all the way. keryx sets
   * `redirect: "error"` for that reason, and until this fixture existed
   * the control had no test: a string literal in an options object that
   * nothing exercised.
   */
  readonly redirectTo?: string;
};

const DEFAULT_TOOLS = [
  {
    name: "search",
    description: "Search the remote index",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_ticket",
    description: "Open a ticket",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
];

/**
 * Give a tool the `inputSchema` the protocol requires.
 *
 * The SDK validates `tools/list` against the `Tool` schema, and a tool
 * without one is rejected client-side with a Zod error — which is correct
 * of it. Tests name a tool and nothing else; this keeps the wire valid so
 * a fixture shortcut cannot look like a transport failure.
 */
function withSchema(tool: Record<string, unknown>): Record<string, unknown> {
  return tool.inputSchema === undefined
    ? { ...tool, inputSchema: { type: "object", properties: {} } }
    : tool;
}

function rpc(id: unknown, result: unknown, sse = false): Response {
  const message = JSON.stringify({ jsonrpc: "2.0", id, result });
  if (!sse) {
    // The streamable-HTTP transport accepts a JSON body for a single
    // response; it upgrades to SSE only when the server chooses to stream.
    return new Response(message, { headers: { "content-type": "application/json" } });
  }
  // One SSE event carrying the same JSON-RPC message, then end of stream.
  // The wire format is `data: <json>\n\n`; the transport parses the event
  // and hands the same object to the client, which is the property under
  // test — D-06 claims the two are indistinguishable above the transport.
  return new Response(`event: message\ndata: ${message}\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/** Start the mock and return its URL. Caller must `stop()`. */
export async function startMockHttpMcpServer(options: MockOptions = {}): Promise<MockHttpMcpServer> {
  const recorded: RecordedRequest[] = [];
  const tools = options.tools ?? DEFAULT_TOOLS;

  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(request): Promise<Response> {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      let body: unknown;
      const text = await request.text();
      try {
        body = text === "" ? undefined : (JSON.parse(text) as unknown);
      } catch {
        body = text;
      }
      recorded.push({ method: request.method, path: new URL(request.url).pathname, headers, body });

      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.requireAuth !== undefined && headers.authorization !== options.requireAuth) {
        return new Response("unauthorized", { status: 401 });
      }
      if (options.redirectTo !== undefined) {
        return new Response(null, { status: 307, headers: { location: options.redirectTo } });
      }
      if (options.failWith !== undefined) {
        return new Response("nope", { status: options.failWith });
      }
      if (options.notMcp === true) {
        // A real web page on the URL somebody pasted. The commonest
        // misconfiguration, and it must not read as "MCP server broken".
        return new Response("<!doctype html><title>Not an MCP server</title>", {
          headers: { "content-type": "text/html" },
        });
      }

      // A notification carries no id and expects 202 with no body.
      const message = body as { id?: unknown; method?: string } | undefined;
      if (message?.id === undefined) return new Response(null, { status: 202 });

      const sse = options.sse === true;
      if (message.method === "initialize") {
        return rpc(message.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "keryx-fixture-http", version: "1.0.0" },
        }, sse);
      }
      if (message.method === "tools/list") {
        return rpc(message.id, { tools: tools.map(withSchema) }, sse);
      }
      if (message.method === "tools/call") {
        const params = (message as { params?: { name?: string; arguments?: Record<string, unknown> } }).params;
        const name = params?.name ?? "";
        if (name === "big") {
          return rpc(message.id, { content: [{ type: "text", text: "x".repeat(40_000) }], isError: false }, sse);
        }
        if (name === "boom") {
          return rpc(message.id, { content: [{ type: "text", text: "remote exploded" }], isError: true }, sse);
        }
        return rpc(message.id, {
          content: [{ type: "text", text: `remote:${name}:${JSON.stringify(params?.arguments ?? {})}` }],
          isError: false,
        }, sse);
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no method" } }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests: () => recorded,
    stop: async () => {
      // `true` = do not wait for in-flight requests. A test that exercises
      // the handshake bound leaves one deliberately hanging, and teardown
      // waiting for it would turn a passing test into a timed-out suite.
      server.stop(true);
      await Promise.resolve();
    },
  };
}
