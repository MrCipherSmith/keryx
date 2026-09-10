import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServerConnection, McpToolDescriptor } from "../mcp-client/client";
import type { ResolvedMcpServer } from "./config";
import { createMcpRuntime, defaultServerCwd } from "./runtime";

function workspace(servers: Record<string, unknown>, scope: "user" | "project" = "user"): {
  configDir: string;
  projectRoot: string;
} {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-runtime-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(projectRoot, ".keryx"), { recursive: true });

  const file =
    scope === "user"
      ? path.join(configDir, "mcp-servers.json")
      : path.join(projectRoot, ".keryx", "mcp-servers.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, servers }, null, 2));
  return { configDir, projectRoot };
}

function connection(tools: McpToolDescriptor[], closed: string[] = [], name = "srv"): McpServerConnection {
  return {
    listTools: async () => tools,
    callTool: async () => ({ kind: "result", result: { content: [], isError: false } }) as never,
    close: async () => {
      closed.push(name);
    },
  };
}

describe("AC8 — one bad server does not take the session down", () => {
  test("the good server connects, the bad one is failed, and neither throws", async () => {
    const { configDir, projectRoot } = workspace({
      good: { command: "good-cmd" },
      bad: { command: "missing-cmd" },
    });

    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async (server) => {
        if (server.name === "bad") throw new Error("spawn missing-cmd ENOENT");
        return connection([{ name: "read" }] as McpToolDescriptor[]);
      },
    });

    await runtime.ready();

    const byName = new Map(runtime.servers().map((s) => [s.name, s]));
    expect(byName.get("good")?.status).toBe("connected");
    expect(byName.get("bad")?.status).toBe("failed");
    expect(byName.get("bad")?.error).toContain("ENOENT");

    // And the good server's tools are searchable despite the other failing.
    expect(runtime.catalog().entries.map((e) => e.fqn)).toEqual(["good__read"]);
  });

  test("creating the runtime does not block on the dials", async () => {
    // The shell must paint its prompt before a slow server answers.
    const { configDir, projectRoot } = workspace({ slow: { command: "x" } });
    let resolveDial: (() => void) | undefined;

    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async () => {
        await new Promise<void>((resolve) => {
          resolveDial = resolve;
        });
        return connection([]);
      },
    });

    // Returned already, with the dial still outstanding.
    expect(runtime.servers().map((s) => s.status)).toEqual(["connecting"]);
    resolveDial?.();
    await runtime.ready();
    expect(runtime.servers().map((s) => s.status)).toEqual(["connected"]);
  });

  test("a malformed config is carried, not thrown, and the shell still gets a runtime", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-runtime-bad-"));
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "mcp-servers.json"), "{ not json");

    const runtime = createMcpRuntime({ cwd: base, gitRoot: base, configDir, connect: async () => connection([]) });
    await runtime.ready();

    expect(runtime.servers()).toEqual([]);
    // Carried, so the shell can print it. Silence here is what sends the
    // operator to debug a server instead of a comma.
    expect(runtime.problems()).toHaveLength(1);
    expect(runtime.problems()[0]?.message).toContain("not valid JSON");
  });
});

describe("AC9 — a disabled server starts no process", () => {
  test("disabled by the file: reported disabled, never dialled", async () => {
    const { configDir, projectRoot } = workspace({ off: { command: "x", enabled: false } });
    let dialled = 0;

    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async () => {
        dialled++;
        return connection([]);
      },
    });
    await runtime.ready();

    expect(runtime.servers()[0]?.status).toBe("disabled");
    // Asserted, not inferred from the status: the absence of the process is
    // the criterion, and a status is only a claim about it.
    expect(dialled).toBe(0);
    expect(runtime.catalog().entries).toEqual([]);
  });

  test("disabled by the personal overlay, with the file untouched", async () => {
    const { configDir, projectRoot } = workspace({ off: { command: "x" } });
    writeFileSync(
      path.join(configDir, "mcp-servers-disabled.json"),
      JSON.stringify({ overrides: { off: false } }),
    );
    let dialled = 0;

    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async () => {
        dialled++;
        return connection([]);
      },
    });
    await runtime.ready();

    expect(runtime.servers()[0]?.status).toBe("disabled");
    expect(dialled).toBe(0);
  });

  test("an enabled server IS dialled — so the two tests above are not vacuous", async () => {
    const { configDir, projectRoot } = workspace({ on: { command: "x" } });
    let dialled = 0;

    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async () => {
        dialled++;
        return connection([]);
      },
    });
    await runtime.ready();
    expect(dialled).toBe(1);
  });
});

describe("lifecycle", () => {
  test("close() closes every open connection", async () => {
    const closed: string[] = [];
    const { configDir, projectRoot } = workspace({ a: { command: "x" }, b: { command: "y" } });

    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async (server) => connection([], closed, server.name),
    });
    await runtime.ready();
    await runtime.close();

    expect(closed.sort()).toEqual(["a", "b"]);
  });

  test("close() waits for an in-flight dial rather than leaking it", async () => {
    // Closing while a server is still connecting must not leave that
    // process behind — the exact leak a fire-and-forget dial invites.
    const closed: string[] = [];
    const { configDir, projectRoot } = workspace({ slow: { command: "x" } });
    let resolveDial: (() => void) | undefined;

    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async () => {
        await new Promise<void>((resolve) => {
          resolveDial = resolve;
        });
        return connection([], closed, "slow");
      },
    });

    const closing = runtime.close();
    resolveDial?.();
    await closing;

    expect(closed).toEqual(["slow"]);
  });

  test("the catalog is read live, so a late server becomes searchable", async () => {
    const { configDir, projectRoot } = workspace({ late: { command: "x" } });
    let resolveDial: (() => void) | undefined;

    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async () => {
        await new Promise<void>((resolve) => {
          resolveDial = resolve;
        });
        return connection([{ name: "thing" }] as McpToolDescriptor[]);
      },
    });

    expect(runtime.catalog().entries).toEqual([]);
    resolveDial?.();
    await runtime.ready();
    expect(runtime.catalog().entries.map((e) => e.fqn)).toEqual(["late__thing"]);
  });
});

describe("per-tool timeouts", () => {
  test("a tool-specific timeout beats the server-wide one", async () => {
    const { configDir, projectRoot } = workspace({
      srv: { command: "x", tool_timeout_sec: 5, tool_timeouts: { slow: 30 } },
    });
    const runtime = createMcpRuntime({
      cwd: projectRoot,
      gitRoot: projectRoot,
      configDir,
      connect: async () => connection([]),
    });

    expect(runtime.toolTimeoutSec("srv", "slow")).toBe(30);
    expect(runtime.toolTimeoutSec("srv", "other")).toBe(5);
    expect(runtime.toolTimeoutSec("nope", "any")).toBeUndefined();
  });
});

describe("where a server runs", () => {
  test("a project server defaults to its project root, not the shell's cwd", () => {
    // Relative paths in a project server's args are written against the
    // repository, not against wherever the operator happened to cd.
    const server = {
      name: "s",
      source: "project",
      file: "/repo/.keryx/mcp-servers.json",
      enabled: true,
      command: "x",
    } as ResolvedMcpServer;
    expect(defaultServerCwd(server, "/somewhere/else")).toBe("/repo");
  });

  test("a user server has no project, so the working directory is the honest answer", () => {
    const server = {
      name: "s",
      source: "user",
      file: "/home/u/.local/share/keryx/mcp-servers.json",
      enabled: true,
      command: "x",
    } as ResolvedMcpServer;
    expect(defaultServerCwd(server, "/somewhere/else")).toBe("/somewhere/else");
  });
});
