// Client-supplied MCP servers for an ACP session, below the wire (flow 287).
// The real-process proof is `mcp-servers.process.test.ts`; this pins the
// validation split (AC5), the secret scrub (AC6) and the close contract (AC3)
// with a substituted dial, so each rule fails on its own.

import { describe, expect, test } from "bun:test";
import type { McpServerConnection } from "../mcp-client/client";
import type { ConnectFn } from "../mcp-servers/manager";
import { AcpError } from "./jsonrpc";
import { parseAcpMcpServers, scrub, startAcpSessionMcp } from "./session-mcp";

const SECRET = "ghp_sentinel_0123456789";
const HEADER_SECRET = "sk-header-sentinel-9876";

function stdioEntry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, command: "server-bin", args: ["--flag"], env: [{ name: "GITHUB_TOKEN", value: SECRET }], ...extra };
}

/** A connection that answers `tools/list` with one tool and records `close`. */
function fakeConnection(closed: string[], name: string): McpServerConnection {
  return {
    listTools: async () => [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
    callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
    close: async () => {
      closed.push(name);
    },
  } as unknown as McpServerConnection;
}

describe("parseAcpMcpServers — what is refused per entry, and what fails the call (AC5)", () => {
  test("stdio entries become dial-ready servers with env as a map; the printable copy holds names only", () => {
    const parsed = parseAcpMcpServers("session/new", [stdioEntry("gh", { type: "stdio" })]);
    expect(parsed.refused).toEqual([]);
    expect(parsed.stdio).toHaveLength(1);
    const server = parsed.stdio[0]!;
    expect(server).toMatchObject({ name: "gh", command: "server-bin", args: ["--flag"], env: { GITHUB_TOKEN: SECRET } });
    expect(JSON.stringify(server.raw)).not.toContain(SECRET);
    expect(parsed.secrets).toContain(SECRET);
  });

  test("http and sse entries are refused per entry, by name, with the reason — and their header values are secrets", () => {
    const parsed = parseAcpMcpServers("session/new", [
      { type: "http", name: "remote", url: "https://x.example/mcp", headers: [{ name: "Authorization", value: HEADER_SECRET }] },
      { type: "sse", name: "stream", url: "https://y.example/sse", headers: [] },
      stdioEntry("local"),
    ]);
    expect(parsed.stdio.map((server) => server.name)).toEqual(["local"]);
    expect(parsed.refused.map((problem) => problem.name)).toEqual(["remote", "stream"]);
    for (const problem of parsed.refused) {
      expect(problem.reason).toContain("http: false, sse: false");
    }
    expect(parsed.secrets).toContain(HEADER_SECRET);
  });

  test("a stdio entry with no command, bad args, bad env or a reused name is refused per entry", () => {
    const parsed = parseAcpMcpServers("session/load", [
      { name: "nocmd", args: [], env: [] },
      stdioEntry("badargs", { args: [1, 2] }),
      stdioEntry("badenv", { env: [{ name: "X" }] }),
      stdioEntry("dup"),
      stdioEntry("dup"),
      { type: "carrier-pigeon", name: "odd" },
    ]);
    expect(parsed.stdio.map((server) => server.name)).toEqual(["dup"]);
    expect(parsed.refused.map((problem) => problem.name)).toEqual(["nocmd", "badargs", "badenv", "dup", "odd"]);
  });

  test("a list that is not a list, or an entry with no name, fails the whole call with -32602", () => {
    expect(() => parseAcpMcpServers("session/new", { gh: {} })).toThrow(AcpError);
    let thrown: unknown;
    try {
      parseAcpMcpServers("session/new", [stdioEntry("ok"), { command: "x", env: [{ name: "T", value: SECRET }] }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpError);
    expect((thrown as AcpError).code).toBe(-32602);
    // The refusal does not echo the entry back: it may be carrying a credential.
    expect(JSON.stringify((thrown as AcpError).toErrorObject())).not.toContain(SECRET);
  });

  test("absent or empty is no servers", () => {
    expect(parseAcpMcpServers("session/new", undefined)).toEqual({ stdio: [], refused: [], secrets: [] });
    expect(parseAcpMcpServers("session/new", [])).toEqual({ stdio: [], refused: [], secrets: [] });
  });
});

describe("scrub (AC6)", () => {
  test("every occurrence of every secret is replaced, a longer secret before a shorter one it contains", () => {
    expect(scrub(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe("a <redacted> b <redacted>");
    expect(scrub("token=abcdef", ["abc", "abcdef"])).toBe("token=<redacted>");
  });
});

describe("startAcpSessionMcp", () => {
  test("no stdio server: no tools, nothing to close", async () => {
    const mcp = startAcpSessionMcp(parseAcpMcpServers("session/new", []));
    expect(mcp.tools).toEqual([]);
    await mcp.ready;
    expect(mcp.failed()).toEqual([]);
    await mcp.close();
  });

  test("one server fails, the other connects; the failure names the server and carries no secret (AC5/AC6)", async () => {
    const closed: string[] = [];
    const connect: ConnectFn = async (server) => {
      if (server.name === "broken") {
        // A dial error that echoes the environment it was given — the case the scrub exists for.
        throw new Error(`spawn failed with GITHUB_TOKEN=${server.env?.["GITHUB_TOKEN"] ?? ""}`);
      }
      return fakeConnection(closed, server.name);
    };
    const mcp = startAcpSessionMcp(parseAcpMcpServers("session/new", [stdioEntry("broken"), stdioEntry("good")]), {
      connect,
    });
    expect(mcp.tools.map((tool) => tool.definition.name)).toEqual(["search_tool", "use_tool"]);
    await mcp.ready;
    const failed = mcp.failed();
    expect(failed.map((problem) => problem.name)).toEqual(["broken"]);
    expect(failed[0]!.reason).toContain("<redacted>");
    expect(failed[0]!.reason).not.toContain(SECRET);

    const search = await mcp.tools[0]!.invoke({ query: "ping" });
    expect(search.output).toContain("ping");

    await mcp.close();
    expect(closed).toEqual(["good"]);
    // Idempotent: a second close closes nothing again.
    await mcp.close();
    expect(closed).toEqual(["good"]);
  });

  test("use_tool is destructive, so every call reaches the agent's approval branch (AC4)", () => {
    const mcp = startAcpSessionMcp(parseAcpMcpServers("session/new", [stdioEntry("good")]), {
      connect: async (server) => fakeConnection([], server.name),
    });
    const useTool = mcp.tools.find((tool) => tool.definition.name === "use_tool");
    expect(useTool?.definition.risk).toBe("destructive");
    void mcp.close();
  });
});
