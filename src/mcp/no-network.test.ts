import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  buildMcpContext,
  dispatchCallTool,
  dispatchListResources,
  dispatchListTools,
} from "./dispatch";

// No-network sandbox (T-4, AC8/AC9): the MCP surface opens no socket and makes
// no network call on the default path. Mirrors capability/golden-rule.test.ts.
// With mcp disabled it also exposes nothing (AC3) and loads no SDK.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-mcp-net-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeManifest(mcpEnabled: boolean): Promise<void> {
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      schemaVersion: 1,
      standardVersion: "0.1.0",
      name: "fixture",
      createdBy: "keryx",
      paths: {},
      modules: { gdgraph: { enabled: true }, mcp: { enabled: mcpEnabled } },
    }),
    "utf8",
  );
}

test("mcp dispatch opens no socket / makes no network call (T-4)", async () => {
  await writeManifest(true);
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  let networkAttempts = 0;

  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("network blocked by mcp no-network sandbox");
  }) as unknown as typeof fetch;
  net.Socket.prototype.connect = function connect(this: net.Socket): net.Socket {
    networkAttempts += 1;
    throw new Error("socket blocked by mcp no-network sandbox");
  } as typeof net.Socket.prototype.connect;

  try {
    const ctx = await buildMcpContext(root);
    dispatchListTools(ctx);
    await dispatchListResources(ctx);
    await dispatchCallTool(ctx, "gdgraph.orphans", {});
  } finally {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
  }

  expect(networkAttempts).toBe(0);
});

test("AC3/AC9: mcp-disabled workspace exposes nothing", async () => {
  await writeManifest(false);
  const ctx = await buildMcpContext(root);
  expect(dispatchListTools(ctx)).toEqual([]);
  expect(await dispatchListResources(ctx)).toEqual([]);
  const call = await dispatchCallTool(ctx, "gdgraph.orphans", {});
  expect(call.isError).toBe(true);
});
