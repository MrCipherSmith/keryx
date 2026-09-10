import { describe, expect, test } from "bun:test";
import type { McpServerConnection, McpToolDescriptor } from "../mcp-client/client";
import type { ResolvedMcpServer } from "./config";
import { closeServers, DEFAULT_CONNECT_CONCURRENCY, startServers } from "./manager";

function server(name: string, over: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return { name, command: "cmd", source: "user", file: "/x", enabled: true, ...over };
}

function connection(tools: string[], hooks: { onClose?: () => void } = {}): McpServerConnection {
  return {
    listTools: async (): Promise<McpToolDescriptor[]> => tools.map((name) => ({ name })),
    callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
    close: async (): Promise<void> => {
      hooks.onClose?.();
    },
  };
}

describe("AC8 — one server failing does not take the session down", () => {
  test("the good server connects, the bad one is failed, and both are reported", async () => {
    const result = await startServers(
      [server("good"), server("bad", { command: "missing" })],
      async (s) => {
        if (s.name === "bad") throw new Error("spawn missing: ENOENT");
        return connection(["read"]);
      },
    );

    const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));
    expect(byName.good?.status).toBe("connected");
    expect(byName.bad?.status).toBe("failed");
    // The message survives, because "failed" without a reason sends the
    // operator to guess.
    expect(byName.bad?.error).toContain("ENOENT");
    // And the good server's tools are still in the catalog.
    expect(result.catalog.entries.map((e) => e.fqn)).toEqual(["good__read"]);
  });

  test("startServers does not reject, whatever connect does", async () => {
    // The caller is a shell that has to start. An exception here is the
    // session failing to open because one configured server was wrong.
    const result = await startServers([server("a"), server("b")], async () => {
      throw new Error("everything is broken");
    });
    expect(result.servers.every((s) => s.status === "failed")).toBe(true);
  });

  test("a server that never answers is failed on a timeout, not awaited forever", async () => {
    // The failure mode with no error message: a process that starts and never
    // completes the handshake would otherwise hold the shell open.
    const result = await startServers(
      [server("hangs", { startup_timeout_sec: 0.01 })],
      () => new Promise<McpServerConnection>(() => {}),
    );

    expect(result.servers[0]?.status).toBe("failed");
    expect(result.servers[0]?.error).toContain("did not answer");
  });

  test("a listTools that hangs is also bounded, not only the dial", async () => {
    // Connecting is not the only place a server can go quiet.
    const result = await startServers([server("quiet", { startup_timeout_sec: 0.01 })], async () => ({
      listTools: () => new Promise<McpToolDescriptor[]>(() => {}),
      callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
      close: async () => {},
    }));

    expect(result.servers[0]?.status).toBe("failed");
  });
});

describe("a dial that succeeded is closed even when the server is reported failed", () => {
  test("listTools failing after connect does NOT leak the child process", async () => {
    // The connection exists — a process is spawned and holding pipes — but
    // the state recorded is `failed`, which carries no `connection` field,
    // so `closeServers` can never reach it. Nothing else holds a reference.
    // This test existed one assertion short: it checked the status and not
    // the process.
    let closed = 0;
    const result = await startServers([server("half")], async () => ({
      listTools: async (): Promise<McpToolDescriptor[]> => {
        throw new Error("protocol error");
      },
      callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
      close: async (): Promise<void> => {
        closed++;
      },
    }));

    expect(result.servers[0]?.status).toBe("failed");
    expect(closed).toBe(1);
  });

  test("a close that throws does not stop the failure being reported", async () => {
    const result = await startServers([server("half")], async () => ({
      listTools: async (): Promise<McpToolDescriptor[]> => {
        throw new Error("protocol error");
      },
      callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
      close: async (): Promise<void> => {
        throw new Error("close also failed");
      },
    }));

    expect(result.servers[0]?.status).toBe("failed");
    expect(result.servers[0]?.error).toContain("protocol error");
  });

  test("a dial abandoned by the timeout is closed when it finally lands", async () => {
    // `Promise.race` cancels nothing. A slow server — a cold `npx` fetch, a
    // container starting — completes its handshake after the timeout has
    // already given up on it, and the resolved connection is dropped on the
    // floor. One orphan per slow dial, and the operator is told `failed`
    // about a server that is actually running.
    let closed = 0;
    const result = await startServers([server("slow", { startup_timeout_sec: 0.01 })], async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        listTools: async (): Promise<McpToolDescriptor[]> => [],
        callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
        close: async (): Promise<void> => {
          closed++;
        },
      };
    });

    expect(result.servers[0]?.status).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(closed).toBe(1);
  });

  test("a dial that wins the race is NOT closed behind the caller's back", async () => {
    // Anti-vacuity for the three above: the abandonment path must not fire
    // on the happy path, or every connected server would be closed the
    // moment it connected.
    let closed = 0;
    const result = await startServers([server("fine")], async () => connection(["read"], {
      onClose: () => {
        closed++;
      },
    }));

    expect(result.servers[0]?.status).toBe("connected");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(0);
  });
});

describe("disabled servers", () => {
  test("a disabled server is reported as disabled and never dialled", async () => {
    let dialled = 0;
    const result = await startServers([server("off", { enabled: false })], async () => {
      dialled += 1;
      return connection([]);
    });

    expect(dialled).toBe(0);
    // Reported, not omitted: a disabled server missing from the report reads
    // as one that was never configured.
    expect(result.servers[0]?.status).toBe("disabled");
  });
});

describe("bounded concurrency", () => {
  test("never more than the cap are in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const servers = Array.from({ length: 10 }, (_v, i) => server(`s${i}`));

    await startServers(
      servers,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return connection([]);
      },
      { concurrency: 3 },
    );

    expect(peak).toBeLessThanOrEqual(3);
    // And it genuinely ran concurrently, or the cap is meaningless.
    expect(peak).toBeGreaterThan(1);
  });

  test("every server is still started, cap notwithstanding", async () => {
    const servers = Array.from({ length: 7 }, (_v, i) => server(`s${i}`));
    const result = await startServers(servers, async () => connection(["t"]), { concurrency: 2 });

    expect(result.servers).toHaveLength(7);
    expect(result.servers.every((s) => s.status === "connected")).toBe(true);
    expect(result.catalog.entries).toHaveLength(7);
  });

  test("the default cap is a named constant, not an inline number", () => {
    expect(DEFAULT_CONNECT_CONCURRENCY).toBeGreaterThan(0);
  });
});

describe("reporting", () => {
  test("servers come back sorted, so two runs over one config are diffable", async () => {
    const result = await startServers(
      [server("zeta"), server("alpha"), server("mid")],
      async () => connection([]),
    );
    expect(result.servers.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("closing is attempted for every connection even when one throws", async () => {
    let closed = 0;
    const states = [
      { name: "a", status: "connected" as const, toolCount: 0, connection: connection([], { onClose: () => { closed += 1; } }) },
      {
        name: "b",
        status: "connected" as const,
        toolCount: 0,
        connection: { ...connection([]), close: async () => { throw new Error("no"); } },
      },
      { name: "c", status: "connected" as const, toolCount: 0, connection: connection([], { onClose: () => { closed += 1; } }) },
    ];

    await closeServers(states);
    // The thrower must not have prevented the others.
    expect(closed).toBe(2);
  });
});
