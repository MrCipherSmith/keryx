// AC5 and AC2: the transport, actually running.
//
// Every other test in this directory substitutes the connection. That is the
// right default — it keeps the suite fast and it isolates the logic — but it
// means the one piece that has never executed is the piece that talks to a
// process over a pipe. These tests spawn a real MCP server and speak real
// JSON-RPC to it.
//
// `fixtures/mcp-servers/echo-server.ts` is hand-rolled rather than built on
// the SDK's server half: the client under test loads the SDK, and if both
// sides shared it, a framing bug would cancel out and this file would pass
// over a wire no real server speaks.
//
// AC2's own criterion — a REAL third-party package fetched by `npx` — is
// gated behind KERYX_ALLOW_REAL_SUBPROCESS, matching the `keryx-mcp-client`
// precedent, because it needs the network and a registry. The fixture tests
// below are NOT gated: they spawn a process and use no network, so there is
// no reason for CI to skip them.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectStdioMcpServer } from "../mcp-client/client";
import { catalogForServer } from "./catalog";
import { classifyToolRisk, createMcpInteractiveTools, MAX_TOOL_RESULT_BYTES } from "./tools";
import type { ServerState } from "./manager";
import { startServers } from "./manager";
import type { ResolvedMcpServer } from "./config";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "mcp-servers",
  "echo-server.ts",
);

function fixtureServer(name = "fx", over: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return {
    name,
    source: "user",
    file: "/cfg/mcp-servers.json",
    enabled: true,
    command: "bun",
    args: [FIXTURE],
    ...over,
  } as ResolvedMcpServer;
}

async function connectFixture(server: ResolvedMcpServer): ReturnType<typeof connectStdioMcpServer> {
  return connectStdioMcpServer([server.command as string, ...(server.args ?? [])], {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
}

describe("a real stdio MCP server, over a real pipe", () => {
  test("handshake and tools/list return the fixture's four tools", async () => {
    const connection = await connectFixture(fixtureServer());
    try {
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["big", "boom", "echo", "write_note"]);
    } finally {
      await connection.close();
    }
  }, 30_000);

  test("AC5: search_tool finds it and use_tool calls it, end to end", async () => {
    const { servers, catalog } = await startServers([fixtureServer("fx")], connectFixture);
    try {
      expect(servers[0]?.status).toBe("connected");

      const [search, use] = createMcpInteractiveTools({
        catalog: () => catalog,
        servers: () => servers,
      });

      const found = await search?.invoke({ query: "echo" });
      expect(found?.output).toContain("fx__echo");

      const called = await use?.invoke({
        tool_name: "fx__echo",
        tool_input: { text: "over the wire" },
      });

      // The value came back from another process, through the transport.
      expect(called?.isError).toBe(false);
      expect(called?.output).toContain("over the wire");
      expect(called?.untrusted).toBe(true);
    } finally {
      await closeAll(servers);
    }
  }, 30_000);

  test("AC6: a real over-cap result is truncated on the way to the model", async () => {
    // The truncation unit test feeds `truncateResult` a string it built. This
    // one makes a server produce 40 000 bytes and checks what the model would
    // actually receive.
    const { servers, catalog } = await startServers([fixtureServer("fx")], connectFixture);
    try {
      const [, use] = createMcpInteractiveTools({ catalog: () => catalog, servers: () => servers });
      const result = await use?.invoke({ tool_name: "fx__big", tool_input: {} });

      expect(result?.output).toContain(`truncated at ${MAX_TOOL_RESULT_BYTES} bytes`);
      expect(Buffer.byteLength(result?.output ?? "", "utf8")).toBeLessThan(MAX_TOOL_RESULT_BYTES + 200);
    } finally {
      await closeAll(servers);
    }
  }, 30_000);

  test("a tool that reports an error surfaces as an error, not as content", async () => {
    const { servers, catalog } = await startServers([fixtureServer("fx")], connectFixture);
    try {
      const [, use] = createMcpInteractiveTools({ catalog: () => catalog, servers: () => servers });
      const result = await use?.invoke({ tool_name: "fx__boom", tool_input: {} });
      expect(result?.isError).toBe(true);
    } finally {
      await closeAll(servers);
    }
  }, 30_000);

  test("the fixture's annotations reach the catalog, so classification has real input", async () => {
    const connection = await connectFixture(fixtureServer());
    try {
      const catalog = catalogForServer("fx", await connection.listTools());
      const echo = catalog.entries.find((entry) => entry.rawName === "echo");
      // `readOnlyHint` survived the round trip FROM WHERE THE PROTOCOL PUTS
      // IT — beside `inputSchema`, not inside it. Without this the
      // classifier judges every real tool on its name alone.
      expect((echo?.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint).toBe(true);
      // And the classification a real server earns is `read`, which was
      // unreachable before: nothing on the wire could produce it.
      expect(classifyToolRisk({ rawName: echo?.rawName ?? "", ...echo })).toBe("read");
    } finally {
      await connection.close();
    }
  }, 30_000);
});

describe("AC8, against real processes", () => {
  test("one server that cannot start does not stop the one that can", async () => {
    // The unit version of this uses a throwing `connect`. This one uses a
    // command that genuinely does not exist, so the failure comes from the
    // operating system rather than from the test.
    const { servers, catalog } = await startServers(
      [
        fixtureServer("good"),
        fixtureServer("bad", { command: "keryx-no-such-binary-a1b2c3", args: [] }),
      ],
      connectFixture,
      { defaultStartupTimeoutMs: 20_000 },
    );

    try {
      const byName = new Map(servers.map((server) => [server.name, server]));
      expect(byName.get("good")?.status).toBe("connected");
      expect(byName.get("bad")?.status).toBe("failed");
      // The comment above claims the failure comes from the operating
      // system. Without this the same assertions pass if `bad` merely hit
      // the 20s startup timeout, which is a different failure entirely.
      expect(byName.get("bad")?.error).toMatch(/ENOENT|spawn|not found|No such file/i);
      expect((byName.get("good")?.toolCount ?? 0) > 0).toBe(true);
      expect(catalog.entries.some((entry) => entry.server === "good")).toBe(true);
    } finally {
      await closeAll(servers);
    }
  }, 40_000);
});

// AC2's own wording: `keryx mcp add filesystem -- npx -y
// @modelcontextprotocol/server-filesystem <dir>` then `keryx mcp doctor
// filesystem` reports `connected` and a non-zero tool count. That needs the
// network and the npm registry, so it is gated the way `keryx-mcp-client`
// gates its own live tests — and the gating is RECORDED here rather than the
// criterion quietly dropped. Everything above this line runs unconditionally.
const REAL_SUBPROCESS_FLAG = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";

describe.skipIf(!REAL_SUBPROCESS_FLAG)(
  "AC2 — a real third-party server via npx (flag-gated: KERYX_ALLOW_REAL_SUBPROCESS=1, excluded from CI)",
  () => {
    test("keryx mcp doctor reports connected and a non-zero tool count", async () => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const shared = mkdtempSync(path.join(tmpdir(), "keryx-mcp-ac2-"));

      const server = fixtureServer("filesystem", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", shared],
      });

      const { runDoctor } = await import("./doctor");
      const report = await runDoctor(
        { servers: [server], problems: [] },
        { connect: connectFixture, connectTimeoutMs: 120_000 },
      );

      expect(report.servers[0]?.status).toBe("connected");
      expect((report.servers[0]?.toolCount ?? 0) > 0).toBe(true);
    }, 180_000);
  },
);

async function closeAll(servers: readonly ServerState[]): Promise<void> {
  for (const server of servers) {
    try {
      await server.connection?.close();
    } catch {
      // Teardown only.
    }
  }
}
