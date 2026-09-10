// AC1/AC2/AC3: the HTTP transport, against a real listener.
//
// Every assertion here goes over a loopback socket to
// `fixtures/mcp-servers/http-server.ts`, which records what it received.
// That second half is the point: AC3 and AC19 are claims about what
// ARRIVED at the far end, and a test that reads what keryx believes it sent
// is a test of keryx's beliefs.

import { afterEach, describe, expect, test } from "bun:test";
import { connectHttpMcpServer, type McpServerConnection } from "../mcp-client/client";
import { startMockHttpMcpServer, type MockHttpMcpServer } from "../../fixtures/mcp-servers/http-server";
import { catalogForServer } from "./catalog";
import { createMcpInteractiveTools, MAX_TOOL_RESULT_BYTES } from "./tools";
import { startServers } from "./manager";
import type { ResolvedMcpServer } from "./config";

const open: Array<{ close: () => Promise<void> }> = [];
const servers: MockHttpMcpServer[] = [];

afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) await s.stop().catch(() => {});
});

async function mock(options?: Parameters<typeof startMockHttpMcpServer>[0]): Promise<MockHttpMcpServer> {
  const server = await startMockHttpMcpServer(options);
  servers.push(server);
  return server;
}

async function connect(url: string, headers?: Record<string, string>): Promise<McpServerConnection> {
  const c = await connectHttpMcpServer(url, {
    ...(headers === undefined ? {} : { headers }),
    handshakeTimeoutMs: 10_000,
  });
  open.push(c);
  return c;
}

function remote(url: string, over: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return {
    name: "remote",
    source: "user",
    file: "/cfg/mcp-servers.json",
    enabled: true,
    url,
    raw: { url },
    ...over,
  } as ResolvedMcpServer;
}

describe("AC1 — the handshake, over a real socket", () => {
  test("initialize and tools/list complete against the mock", async () => {
    const server = await mock();
    const connection = await connect(server.url);

    const tools = await connection.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_ticket", "search"]);

    // The far end really was spoken to, in the order MCP requires.
    const methods = server.requests().map((r) => (r.body as { method?: string } | undefined)?.method);
    expect(methods[0]).toBe("initialize");
    expect(methods).toContain("tools/list");
  }, 30_000);

  test("tools/call reaches the server and its result comes back", async () => {
    const server = await mock();
    const connection = await connect(server.url);

    const outcome = await connection.callTool("search", { q: "widgets" });
    expect(outcome.kind).toBe("result");
    expect(JSON.stringify(outcome)).toContain("remote:search");
    expect(JSON.stringify(outcome)).toContain("widgets");
  }, 30_000);

  test("annotations survive the round trip, so classification has real input", async () => {
    const server = await mock();
    const connection = await connect(server.url);
    const catalog = catalogForServer("remote", await connection.listTools());

    const search = catalog.entries.find((e) => e.rawName === "search");
    expect((search?.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint).toBe(true);
  }, 30_000);
});

describe("AC2 — above the transport, HTTP is indistinguishable from stdio", () => {
  test("a url server reaches the catalog and use_tool by the same path", async () => {
    const server = await mock();
    const { servers: states, catalog } = await startServers([remote(server.url)], async (s) =>
      connect(s.url as string),
    );

    expect(states[0]?.status).toBe("connected");
    expect(catalog.entries.map((e) => e.fqn).sort()).toEqual(["remote__create_ticket", "remote__search"]);

    const [search, use] = createMcpInteractiveTools({ catalog: () => catalog, servers: () => states });
    expect((await search?.invoke({ query: "ticket" }))?.output).toContain("remote__create_ticket");

    const called = await use?.invoke({ tool_name: "remote__search", tool_input: { q: "x" } });
    expect(called?.isError).toBe(false);
    // Every control a stdio server's output gets (AC9).
    expect(called?.untrusted).toBe(true);
  }, 30_000);

  test("the result cap applies to a remote server too", async () => {
    const server = await mock({ tools: [{ name: "big" }] });
    const { servers: states, catalog } = await startServers([remote(server.url)], async (s) =>
      connect(s.url as string),
    );
    const [, use] = createMcpInteractiveTools({ catalog: () => catalog, servers: () => states });

    const result = await use?.invoke({ tool_name: "remote__big", tool_input: {} });
    expect(result?.output).toContain(`truncated at ${MAX_TOOL_RESULT_BYTES} bytes`);
  }, 30_000);

  test("a remote tool reporting an error surfaces as an error", async () => {
    const server = await mock({ tools: [{ name: "boom" }] });
    const { servers: states, catalog } = await startServers([remote(server.url)], async (s) =>
      connect(s.url as string),
    );
    const [, use] = createMcpInteractiveTools({ catalog: () => catalog, servers: () => states });

    const result = await use?.invoke({ tool_name: "remote__boom", tool_input: {} });
    expect(result?.isError).toBe(true);
    // And still untrusted — an error is not a reason to trust the text.
    expect(result?.untrusted).toBe(true);
  }, 30_000);

  test("AC9: one remote server failing does not stop another connecting", async () => {
    const good = await mock();
    const bad = await mock({ failWith: 500 });

    const { servers: states } = await startServers(
      [remote(good.url, { name: "good" }), remote(bad.url, { name: "bad" })],
      async (s) => connect(s.url as string),
      { defaultStartupTimeoutMs: 15_000 },
    );

    const byName = new Map(states.map((s) => [s.name, s]));
    expect(byName.get("good")?.status).toBe("connected");
    expect(byName.get("bad")?.status).toBe("failed");
  }, 40_000);
});

describe("AC3 — headers arrive at the far end", () => {
  test("an Authorization header is received by the server, verbatim", async () => {
    // Read from what the SERVER got, not from what keryx passed in.
    const server = await mock();
    const connection = await connect(server.url, { Authorization: "Bearer sk-live-abc" });
    await connection.listTools();

    const seen = server.requests().map((r) => r.headers.authorization);
    expect(seen.every((v) => v === "Bearer sk-live-abc")).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  }, 30_000);

  test("a server that requires the header accepts us with it and rejects us without", async () => {
    // Anti-vacuity for the test above: proves the header is load-bearing
    // rather than merely present.
    const guarded = await mock({ requireAuth: "Bearer right" });
    const connection = await connect(guarded.url, { Authorization: "Bearer right" });
    expect((await connection.listTools()).length).toBeGreaterThan(0);

    const other = await mock({ requireAuth: "Bearer right" });
    await expect(connect(other.url, { Authorization: "Bearer wrong" })).rejects.toThrow();
  }, 30_000);

  test("arbitrary headers arrive too, not just Authorization", async () => {
    const server = await mock();
    const connection = await connect(server.url, { "X-Api-Version": "2026-01", "X-Tenant": "acme" });
    await connection.listTools();

    const first = server.requests()[0]?.headers ?? {};
    expect(first["x-api-version"]).toBe("2026-01");
    expect(first["x-tenant"]).toBe("acme");
  }, 30_000);
});

describe("AC4 — a hollow credential never reaches the wire", () => {
  test("an empty header value is refused before the socket opens", async () => {
    // The criterion is that no request ARRIVES, not that one arrives and is
    // rejected. A request sent with `Bearer ` may even succeed against a
    // server that treats it as anonymous.
    const server = await mock();

    await expect(connectHttpMcpServer(server.url, { headers: { Authorization: "" } })).rejects.toThrow(
      /empty "Authorization" header/,
    );
    expect(server.requests()).toEqual([]);
  }, 30_000);

  test("a non-URL and a non-http scheme are refused before any I/O", async () => {
    await expect(connectHttpMcpServer("not a url")).rejects.toThrow(/is not a URL/);
    await expect(connectHttpMcpServer("file:///etc/passwd")).rejects.toThrow(/not an MCP transport/);
  }, 30_000);
});

describe("AC7 — failures are told apart", () => {
  test("an HTTP error status is not the same message as a non-MCP page", async () => {
    const failing = await mock({ failWith: 503 });
    const html = await mock({ notMcp: true });

    const a = await connect(failing.url).catch((e: Error) => e.message);
    const b = await connect(html.url).catch((e: Error) => e.message);

    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
    // Both fail, and an operator can tell which is which.
    expect(a).not.toBe(b);
  }, 30_000);

  test("an unreachable port fails without hanging", async () => {
    const started = Date.now();
    await expect(
      connectHttpMcpServer("http://127.0.0.1:1/mcp", { handshakeTimeoutMs: 8_000 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 30_000);

  test("a server that never answers is bounded by the handshake budget", async () => {
    const slow = await mock({ delayMs: 5_000 });
    const started = Date.now();

    await expect(connectHttpMcpServer(slow.url, { handshakeTimeoutMs: 1_000 })).rejects.toThrow(
      /did not complete the handshake/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);
});
