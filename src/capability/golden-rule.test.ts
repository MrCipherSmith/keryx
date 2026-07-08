import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { initCommand } from "../commands/init";
import { standardCommand } from "../commands/standard";
import { statusCommand } from "../commands/status";
import { modulesCommand } from "../commands/modules";
import { resolveCapability } from "./seam";
import { REFERENCE_CAPABILITY_SPEC } from "./reference";
import { resetWarnOnce } from "./warn-once";

// Package-wide golden-rule gate (AC0-22, AC0-24, C0-7, XP1/XP2): with zero
// opt-in flags and no assets present, default commands run with NO optional
// dependency loaded and NO socket opened. We block the network (fetch + raw
// sockets) and assert every default command still succeeds, and that the
// generated manifest carries no enabled capability entry.

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
  resetWarnOnce();
  previousCwd = process.cwd();
  root = await mkdtemp(path.join(tmpdir(), "keryx-golden-"));
  // Silence command chatter for a clean test run.
  logs = console.log;
  console.log = () => {};
});

afterEach(async () => {
  console.log = logs;
  process.chdir(previousCwd);
  await rm(root, { recursive: true, force: true });
});

test("default commands run under a no-network sandbox with no socket opened", async () => {
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  let networkAttempts = 0;

  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("network blocked by golden-rule sandbox");
  }) as unknown as typeof fetch;
  net.Socket.prototype.connect = function connect(this: net.Socket): net.Socket {
    networkAttempts += 1;
    throw new Error("socket blocked by golden-rule sandbox");
  } as typeof net.Socket.prototype.connect;

  try {
    process.chdir(root);
    await initCommand(MINIMAL_INIT);

    // Every default read command must succeed offline.
    await standardCommand(["validate"]);
    await standardCommand(["capabilities"]);
    await statusCommand();
    await modulesCommand(["status"]);

    // A disabled reference capability resolves to null with no import/fetch.
    const adapter = await resolveCapability(root, REFERENCE_CAPABILITY_SPEC);
    expect(adapter).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
  }

  expect(networkAttempts).toBe(0);
});

test("default init writes no enabled capability entry (byte-stable floor)", async () => {
  process.chdir(root);
  await initCommand(MINIMAL_INIT);

  const manifest = JSON.parse(
    await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8"),
  ) as { modules: Record<string, { capabilities?: unknown[] }> };

  for (const moduleEntry of Object.values(manifest.modules)) {
    const capabilities = Array.isArray(moduleEntry.capabilities)
      ? moduleEntry.capabilities
      : [];
    for (const capability of capabilities) {
      if (capability && typeof capability === "object") {
        expect((capability as { enabled?: unknown }).enabled).not.toBe(true);
      }
    }
  }
});
