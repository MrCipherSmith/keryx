import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { initCommand } from "./init";
import { mcpCommand } from "./mcp";
import { validateWorkspace } from "../standard/validate";

// Flow 012: `mcp install|uninstall` command surface. Runs against a real
// `init --yes` workspace so `standard validate` stays green after enabling MCP.

const MINIMAL_INIT = [
  "--yes",
  "--no-gdgraph",
  "--no-gdctx",
  "--no-gdwiki",
  "--no-gdskills",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
  "--no-security",
];

let root: string;
let previousCwd: string;
let logs: typeof console.log;

beforeEach(async () => {
  previousCwd = process.cwd();
  root = await mkdtemp(path.join(tmpdir(), "gd-metapro-mcp-cmd-"));
  logs = console.log;
  console.log = () => {};
  process.chdir(root);
  await initCommand(MINIMAL_INIT);
});

afterEach(async () => {
  console.log = logs;
  process.chdir(previousCwd);
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

async function manifestModules(): Promise<Record<string, { enabled?: boolean }>> {
  const manifest = JSON.parse(
    await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8"),
  ) as { modules: Record<string, { enabled?: boolean }> };
  return manifest.modules;
}

test("mcp install --runtime cursor writes the config, enables the module, validates", async () => {
  await mcpCommand(["install", "--runtime", "cursor"], root);

  const config = JSON.parse(
    await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
  ) as { mcpServers: Record<string, { command: string }> };
  expect(config.mcpServers["gd-metapro"]?.command).toBe("gd-metapro");
  expect((await manifestModules()).mcp?.enabled).toBe(true);

  // Standard validation stays green with the enabled mcp module scaffolded.
  const result = await validateWorkspace(root);
  expect(result.ok).toBe(true);
});

test("mcp install is idempotent (second run leaves the config unchanged)", async () => {
  await mcpCommand(["install", "--runtime", "cursor"], root);
  const first = await readFile(path.join(root, ".cursor", "mcp.json"), "utf8");
  await mcpCommand(["install", "--runtime", "cursor"], root);
  const second = await readFile(path.join(root, ".cursor", "mcp.json"), "utf8");
  expect(second).toBe(first);
});

test("mcp uninstall removes the managed server", async () => {
  await mcpCommand(["install", "--runtime", "cursor"], root);
  await mcpCommand(["uninstall", "--runtime", "cursor"], root);
  const config = JSON.parse(
    await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
  ) as { mcpServers?: Record<string, unknown> };
  expect(config.mcpServers?.["gd-metapro"]).toBeUndefined();
});

test("mcp install --dry-run writes nothing", async () => {
  await mcpCommand(["install", "--runtime", "cursor", "--dry-run"], root);
  await expect(
    readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
  ).rejects.toThrow();
  expect((await manifestModules()).mcp).toBeUndefined();
});

test("mcp install --runtime generic writes no file", async () => {
  await mcpCommand(["install", "--runtime", "generic"], root);
  await expect(
    readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
  ).rejects.toThrow();
  await expect(readFile(path.join(root, ".mcp.json"), "utf8")).rejects.toThrow();
});

test("mcp install --runtime bogus errors non-zero", async () => {
  await mcpCommand(["install", "--runtime", "bogus"], root);
  expect(process.exitCode).toBe(1);
});

test("mcp install opens no socket (no-network)", async () => {
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  let networkAttempts = 0;

  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("network blocked");
  }) as unknown as typeof fetch;
  net.Socket.prototype.connect = function connect(this: net.Socket): net.Socket {
    networkAttempts += 1;
    throw new Error("socket blocked");
  } as typeof net.Socket.prototype.connect;

  try {
    await mcpCommand(["install", "--runtime", "all"], root);
  } finally {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
  }
  expect(networkAttempts).toBe(0);
});
