import { describe, expect, test } from "bun:test";
import type { McpServerConnection, McpToolDescriptor } from "../mcp-client/client";
import type { ResolvedMcpConfig, ResolvedMcpServer } from "./config";
import { formatDoctorReport, redactValues, runDoctor } from "./doctor";

function server(over: Partial<Record<keyof ResolvedMcpServer, unknown>> = {}): ResolvedMcpServer {
  return {
    name: "srv",
    source: "user",
    file: "/cfg/mcp-servers.json",
    enabled: true,
    command: "npx",
    ...over,
    raw: { command: (over.command as string | undefined) ?? "npx", ...(over.url === undefined ? {} : { url: over.url as string }) },
  } as ResolvedMcpServer;
}

function config(servers: ResolvedMcpServer[], problems: ResolvedMcpConfig["problems"] = []): ResolvedMcpConfig {
  return { servers, problems };
}

function connection(tools: McpToolDescriptor[], closed: string[] = []): McpServerConnection {
  return {
    listTools: async () => tools,
    callTool: async () => ({ kind: "result", result: { content: [], isError: false } }) as never,
    close: async () => {
      closed.push("closed");
    },
  };
}

describe("what doctor reports", () => {
  test("a connected server reports its tool count", async () => {
    const report = await runDoctor(config([server()]), {
      connect: async () => connection([{ name: "read" }, { name: "write" }] as McpToolDescriptor[]),
    });

    expect(report.servers[0]?.status).toBe("connected");
    expect(report.servers[0]?.toolCount).toBe(2);
    expect(report.healthy).toBe(true);
  });

  test("a tool dropped for an unusable qualified name is reported, not swallowed", async () => {
    // The whole reason `skipped` is carried. A tool absent from the catalog
    // AND absent from every report is indistinguishable from a tool the
    // server never had, and the operator debugs the server instead of the
    // name.
    const long = "x".repeat(70);
    const report = await runDoctor(config([server()]), {
      connect: async () => connection([{ name: "ok" }, { name: long }] as McpToolDescriptor[]),
    });

    expect(report.servers[0]?.toolCount).toBe(1);
    expect(report.servers[0]?.skipped).toHaveLength(1);
    expect(report.servers[0]?.skipped[0]?.reason).toContain("64");
    expect(formatDoctorReport(report)).toContain(`skipped "${long}"`);
  });

  test("a server that will not start is failed, with the reason", async () => {
    const report = await runDoctor(config([server()]), {
      connect: async () => {
        throw new Error("spawn npx ENOENT");
      },
    });

    expect(report.servers[0]?.status).toBe("failed");
    expect(report.servers[0]?.detail).toContain("ENOENT");
    expect(report.healthy).toBe(false);
  });

  test("a server that dials but cannot list is failed too, and the connection is still closed", async () => {
    const closed: string[] = [];
    const report = await runDoctor(config([server()]), {
      connect: async () => ({
        listTools: async () => {
          throw new Error("protocol error");
        },
        callTool: async () => ({}) as never,
        close: async () => {
          closed.push("closed");
        },
      }),
    });

    expect(report.servers[0]?.status).toBe("failed");
    // A diagnostic that leaks a process per invocation is a diagnostic
    // nobody can run twice.
    expect(closed).toEqual(["closed"]);
  });

  test("a connected server's process is closed as well", async () => {
    const closed: string[] = [];
    await runDoctor(config([server()]), { connect: async () => connection([], closed) });
    expect(closed).toEqual(["closed"]);
  });

  test("a disabled server is reported as disabled and never dialled", async () => {
    let dialled = 0;
    const report = await runDoctor(config([server({ enabled: false })]), {
      connect: async () => {
        dialled++;
        return connection([]);
      },
    });

    expect(report.servers[0]?.status).toBe("disabled");
    expect(dialled).toBe(0);
  });

  test("a remote server IS dialled now — P1 changed this", async () => {
    // P0 reported `not-attempted` because it connected stdio only. Leaving
    // that in place after the transport shipped would be a report that is
    // wrong in the reassuring direction.
    let dialled = 0;
    const report = await runDoctor(
      config([server({ command: undefined, url: "https://mcp.example/mcp" })]),
      {
        connect: async () => {
          dialled++;
          return connection([{ name: "read" }] as McpToolDescriptor[]);
        },
        env: {},
      },
    );

    expect(dialled).toBe(1);
    expect(report.servers[0]?.status).toBe("connected");
    expect(report.servers[0]?.transport).toBe("http");
  });

  test("a server with NEITHER command nor url is still not-attempted", async () => {
    // The case that genuinely cannot be dialled, kept distinct from the
    // one that now can.
    const report = await runDoctor(config([server({ command: undefined })]), {
      connect: async () => connection([]),
      env: {},
    });

    expect(report.servers[0]?.status).toBe("not-attempted");
    expect(report.servers[0]?.detail).toContain("neither command nor url");
  });

  test("config problems come through and make the report unhealthy", async () => {
    const report = await runDoctor(config([], [{ file: "/cfg/x.json", message: "is not valid JSON" }]), {
      connect: async () => connection([]),
    });

    expect(report.healthy).toBe(false);
    expect(formatDoctorReport(report)).toContain("is not valid JSON");
  });

  test("a timeout is reported rather than hanging the command", async () => {
    const report = await runDoctor(config([server()]), {
      connect: () => new Promise(() => {}),
      connectTimeoutMs: 10,
    });

    expect(report.servers[0]?.status).toBe("failed");
    expect(report.servers[0]?.detail).toContain("did not answer");
  });
});

describe("selecting one server", () => {
  test("only the named server is dialled", async () => {
    const dialled: string[] = [];
    const report = await runDoctor(config([server({ name: "a" }), server({ name: "b" })]), {
      only: "b",
      connect: async (s) => {
        dialled.push(s.name);
        return connection([]);
      },
    });

    expect(dialled).toEqual(["b"]);
    expect(report.servers.map((s) => s.name)).toEqual(["b"]);
  });

  test("a name nothing defines is an error naming what IS defined", async () => {
    // Silence here reads as "that server is fine".
    const report = await runDoctor(config([server({ name: "a" })]), {
      only: "typo",
      connect: async () => connection([]),
    });

    expect(report.healthy).toBe(false);
    expect(report.problems[0]?.message).toContain("a");
    expect(report.problems[0]?.message).toContain("typo");
  });
});

describe("secrets do not reach the report", () => {
  test("env and header VALUES never appear, only set/unset", async () => {
    // Specification §2. `doctor` output is what operators paste into issues.
    const report = await runDoctor(
      config([
        server({
          env: { TOKEN: "sk-live-super-secret", EMPTY: "" },
          headers: { Authorization: "Bearer sk-live-super-secret" },
        }),
      ]),
      { connect: async () => connection([]) },
    );

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain("sk-live-super-secret");
    expect(report.servers[0]?.env).toEqual({ TOKEN: "set", EMPTY: "unset" });
    expect(report.servers[0]?.headers).toEqual({ Authorization: "set" });
    expect(formatDoctorReport(report)).not.toContain("sk-live-super-secret");
  });

  test("an unset variable is named in the text output", async () => {
    // The most common cause of a server that starts and then refuses
    // everything.
    const report = await runDoctor(config([server({ env: { TOKEN: "" } })]), {
      connect: async () => connection([]),
    });
    expect(formatDoctorReport(report)).toContain("unset: TOKEN");
  });

  test("an expanded-to-empty value counts as unset, not as set-to-empty", () => {
    expect(redactValues({ A: "", B: "x" })).toEqual({ A: "unset", B: "set" });
  });
});
