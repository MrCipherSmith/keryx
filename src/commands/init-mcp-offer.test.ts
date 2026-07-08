import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { initCommand } from "./init";

// Flow 012, AC6: the init MCP offer must not disturb the non-interactive floor.
// Under `--yes` (and `--no-mcp`), `modules.mcp` stays off and no client config
// is written — the manifest is byte-identical to today.

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
  root = await mkdtemp(path.join(tmpdir(), "gd-metapro-init-mcp-"));
  logs = console.log;
  console.log = () => {};
  process.chdir(root);
});

afterEach(async () => {
  console.log = logs;
  process.chdir(previousCwd);
  await rm(root, { recursive: true, force: true });
});

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function modules(): Promise<Record<string, { enabled?: boolean }>> {
  const manifest = JSON.parse(
    await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8"),
  ) as { modules: Record<string, { enabled?: boolean }> };
  return manifest.modules;
}

test("AC6: default `init --yes` leaves modules.mcp absent and writes no client config", async () => {
  await initCommand(MINIMAL_INIT);

  expect((await modules()).mcp).toBeUndefined();
  expect(await exists(".cursor/mcp.json")).toBe(false);
  expect(await exists(".mcp.json")).toBe(false);
});

test("AC6: `--no-mcp` keeps the module off and writes no client config", async () => {
  await initCommand([...MINIMAL_INIT, "--no-mcp"]);
  expect((await modules()).mcp).toBeUndefined();
  expect(await exists(".mcp.json")).toBe(false);
});

test("AC6: `--mcp` enables modules.mcp but writes no client config under --yes", async () => {
  await initCommand([...MINIMAL_INIT, "--mcp"]);
  expect((await modules()).mcp?.enabled).toBe(true);
  // --yes never writes a client config.
  expect(await exists(".cursor/mcp.json")).toBe(false);
  expect(await exists(".mcp.json")).toBe(false);
});
