// Client-supplied MCP servers for an ACP session, below the wire (flow 287).
// The real-process proof is `mcp-servers.process.test.ts`; this pins the
// validation split (AC5), the secret scrub (AC6) and the close contract (AC3)
// with a substituted dial, so each rule fails on its own.

import { describe, expect, test } from "bun:test";
import type { McpServerConnection } from "../mcp-client/client";
import type { ConnectFn } from "../mcp-servers/manager";
import { MAX_TOOL_RESULT_BYTES } from "../mcp-servers/tools";
import { AcpError } from "./jsonrpc";
import {
  acpMcpSetKey,
  MIN_SCRUBBED_SECRET_LENGTH,
  parseAcpMcpServers,
  scrub,
  startAcpSessionMcp,
} from "./session-mcp";

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
    expect(scrub("token=abcdefgh-long", ["abcdefgh", "abcdefgh-long"])).toBe("token=<redacted>");
  });

  test("a value shorter than the minimum is not a secret: DEBUG=1 does not mangle '15000ms'", () => {
    expect(MIN_SCRUBBED_SECRET_LENGTH).toBe(8);
    expect(scrub("timed out after 15000ms", ["1", "info", "8080"])).toBe("timed out after 15000ms");
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

describe("T13 — tool output is scrubbed too (AC6)", () => {
  test("a server that echoes its credential in a result or an error reaches the model redacted", async () => {
    const connection = {
      listTools: async () => [
        { name: "leak", description: "Leaks", inputSchema: { type: "object", properties: {} } },
        { name: "fail", description: "Fails", inputSchema: { type: "object", properties: {} } },
      ],
      callTool: async (name: string) =>
        name === "leak"
          ? { kind: "result", result: { content: [{ type: "text", text: `token is ${SECRET}` }], isError: false } }
          : { kind: "error", message: `bad credential ${SECRET}` },
      close: async () => {},
    } as unknown as McpServerConnection;
    const mcp = startAcpSessionMcp(parseAcpMcpServers("session/new", [stdioEntry("gh")]), { connect: async () => connection });
    await mcp.ready;
    const useTool = mcp.tools.find((tool) => tool.definition.name === "use_tool")!;
    for (const raw of ["leak", "fail"]) {
      const result = await useTool.invoke({ tool_name: `gh__${raw}`, tool_input: {} });
      expect(result.output).toContain("<redacted>");
      expect(result.output).not.toContain(SECRET);
      expect(result.untrusted).toBe(true);
    }
    await mcp.close();
  });
});

// T13/flow-296 AC3 — keryx's saved credentials never reach a client server's
// environment.
//
// Flow 287 gave this module its OWN copy of the saved-credential strip
// (`acpMcpParentEnv`, unit-tested right here). Flow 296 found `keryx shell`
// had no equivalent at all — `createMcpRuntime` passed `process.env` straight
// through to `defaultConnect` — and moved the strip into `buildMcpChildEnv`
// (`../mcp-servers/spawn-env.ts`), the one function `defaultConnect` already
// calls for every dial this module makes too (see `startAcpSessionMcp`
// above: `options.connect ?? ((server) => defaultConnect(server, env, …))`,
// with no pre-strip of `env` any more). There is no `acpMcpParentEnv` left to
// unit-test in isolation here; the strip's own coverage now lives in
// `spawn-env.test.ts` (`buildMcpChildEnv`, including the default parameter
// that reaches keryx's real saved-credential record), and the end-to-end
// proof that THIS path benefits — a custom-named provider key saved via
// `auth.json`, an ACP client's own MCP server spawned for real, the child
// never seeing it — is `mcp-servers.process.test.ts`'s
// "flow 296 AC1" describe block.

describe("T13 — the set key", () => {
  test("the same list gives the same key; a different env value, command or root does not", () => {
    const key = (entries: unknown[], cwd = "/r") => {
      const parsed = parseAcpMcpServers("session/new", entries);
      return acpMcpSetKey({ ...parsed, stdio: parsed.stdio.map((server) => ({ ...server, cwd })) });
    };
    const base = key([stdioEntry("gh")]);
    expect(key([stdioEntry("gh")])).toBe(base);
    expect(key([stdioEntry("gh", { env: [{ name: "GITHUB_TOKEN", value: "other-token-value" }] })])).not.toBe(base);
    expect(key([stdioEntry("gh", { command: "other-bin" })])).not.toBe(base);
    expect(key([stdioEntry("gh")], "/elsewhere")).not.toBe(base);
    expect(base).not.toContain(SECRET);
  });
});

describe("T14 — the scrub survives JSON escaping and the truncation cap", () => {
  /** A connection whose one tool answers with `text`. */
  const answering = (text: string): McpServerConnection =>
    ({
      listTools: async () => [{ name: "say", description: "Says", inputSchema: { type: "object", properties: {} } }],
      callTool: async () => ({ kind: "result", result: { content: [{ type: "text", text }], isError: false } }),
      close: async () => {},
    }) as unknown as McpServerConnection;

  async function useToolOutput(secret: string, text: string): Promise<string> {
    const mcp = startAcpSessionMcp(
      parseAcpMcpServers("session/new", [stdioEntry("gh", { env: [{ name: "DB_PASSWORD", value: secret }] })]),
      { connect: async () => answering(text) },
    );
    await mcp.ready;
    const useTool = mcp.tools.find((tool) => tool.definition.name === "use_tool")!;
    const result = await useTool.invoke({ tool_name: "gh__say", tool_input: {} });
    await mcp.close();
    return result.output;
  }

  test('a secret with a quote and a backslash (db"pass\\word42) is redacted in its escaped form', async () => {
    const secret = 'db"pass\\word42';
    const output = await useToolOutput(secret, `pw=${secret}`);
    expect(output).toContain("pw=<redacted>");
    expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(output).not.toContain(secret);
  });

  test("a secret straddling the 20,000-byte cap leaves no prefix behind", async () => {
    const secret = "ghp_straddle0123456789abcdef";
    const base = JSON.stringify([{ type: "text", text: secret }], null, 2).indexOf(secret);
    // Put the secret's first 10 characters inside the cap and the rest past it.
    const pad = "x".repeat(MAX_TOOL_RESULT_BYTES - 10 - base);
    const output = await useToolOutput(secret, `${pad}${secret}`);
    expect(output).toContain("[truncated at");
    expect(output).not.toContain(secret.slice(0, 10));
  });
});

describe("T14 — revive: a shared set recovers a server known to be dead, and only that", () => {
  const descriptor = [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }];

  test("a server that failed its first start is redialled, and its tool becomes reachable", async () => {
    let dials = 0;
    const connect: ConnectFn = async () => {
      dials += 1;
      if (dials === 1) throw new Error("exited before the handshake");
      return { listTools: async () => descriptor, callTool: async () => ({ kind: "result", result: { content: [], isError: false } }), close: async () => {} } as unknown as McpServerConnection;
    };
    const mcp = startAcpSessionMcp(parseAcpMcpServers("session/new", [stdioEntry("flaky")]), { connect });
    await mcp.ready;
    expect(mcp.failed().map((problem) => problem.name)).toEqual(["flaky"]);
    mcp.revive();
    await mcp.ready;
    expect(dials).toBe(2);
    expect(mcp.failed()).toEqual([]);
    expect((await mcp.tools[0]!.invoke({ query: "ping" })).output).toContain("flaky__ping");
    await mcp.close();
  });

  test("a connected server whose transport has closed (process exited) is redialled", async () => {
    let dials = 0;
    const closedConnections: number[] = [];
    let firstExited = false;
    const connect: ConnectFn = async () => {
      dials += 1;
      const id = dials;
      return {
        listTools: async () => descriptor,
        callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
        isClosed: () => id === 1 && firstExited,
        close: async () => {
          closedConnections.push(id);
        },
      } as unknown as McpServerConnection;
    };
    const mcp = startAcpSessionMcp(parseAcpMcpServers("session/new", [stdioEntry("crashy")]), { connect });
    await mcp.ready;
    firstExited = true;
    mcp.revive();
    await mcp.ready;
    expect(dials).toBe(2);
    expect(closedConnections).toEqual([1]);
    await mcp.close();
    expect(closedConnections).toEqual([1, 2]);
  });

  test("a live server that is slow to answer is NOT redialled — slowness is not death", async () => {
    let dials = 0;
    let releaseList: (() => void) | undefined;
    let listCalls = 0;
    const mcp = startAcpSessionMcp(parseAcpMcpServers("session/new", [stdioEntry("busy")]), {
      connect: async () => {
        dials += 1;
        return {
          // The first tools/list (start-up) answers; any later one would hang
          // like a server busy in another thread's long call.
          listTools: async () => {
            listCalls += 1;
            if (listCalls > 1) await new Promise<void>((resolve) => (releaseList = resolve));
            return descriptor;
          },
          callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
          isClosed: () => false,
          close: async () => {},
        } as unknown as McpServerConnection;
      },
    });
    await mcp.ready;
    mcp.revive();
    await mcp.ready;
    expect(dials).toBe(1);
    expect(listCalls).toBe(1);
    releaseList?.();
    await mcp.close();
  });

  test("a healthy set is not redialled", async () => {
    let dials = 0;
    const mcp = startAcpSessionMcp(parseAcpMcpServers("session/new", [stdioEntry("fine")]), {
      connect: async () => {
        dials += 1;
        return { listTools: async () => descriptor, callTool: async () => ({ kind: "result", result: { content: [], isError: false } }), close: async () => {} } as unknown as McpServerConnection;
      },
    });
    await mcp.ready;
    mcp.revive();
    await mcp.ready;
    expect(dials).toBe(1);
    await mcp.close();
  });
});
