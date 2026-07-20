import { afterEach, beforeEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHealth } from "../health/run";
import { runTesting, analyzeTestingProject } from "./service";

// Block D · AC15/AC16 (T-4, XP1): with all defaults (hotspotWeight 0, no
// coverage-map, empty smoke), `health run` and `testing run --changed` open no
// socket and load no new dependency.

let root: string;

async function git(cwd: string, argv: string[]): Promise<void> {
  await Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-blockd-nonet-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await writeFile(
    path.join(root, "src", "a.ts"),
    "export function a(n: number) { if (n > 0) { return 1; } return 0; }\n",
  );
  await writeFile(
    path.join(root, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "t@t.t"]);
  await git(root, ["config", "user.name", "t"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "init"]);
  await analyzeTestingProject(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("AC16: health run + testing run --changed open no socket (T-4)", async () => {
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  let networkAttempts = 0;

  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("network blocked by Block D no-network sandbox");
  }) as unknown as typeof fetch;
  net.Socket.prototype.connect = function connect(this: net.Socket): net.Socket {
    networkAttempts += 1;
    throw new Error("socket blocked by Block D no-network sandbox");
  } as typeof net.Socket.prototype.connect;

  try {
    await runHealth({ cwd: root });
    await runTesting({ cwd: root, changed: true });
  } finally {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
  }

  expect(networkAttempts).toBe(0);
});

test("AC15: Block D adds no new runtime dependency", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(import.meta.dir, "..", "..", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };

  // The deterministic core has zero runtime dependencies.
  expect(pkg.dependencies ?? {}).toEqual({});
  // optionalDependencies are the lean set: the MCP SDK, web-tree-sitter (the
  // 288KB symbol-layer parser), and `@opentui/core` (the interactive-shell TUI
  // renderer — ADR-0005, loaded ONLY via dynamic import with a readline fallback).
  // `@xenova/transformers` (the ~230MB ONNX runtime) was removed — model-backed
  // features run on deterministic fallbacks.
  expect(Object.keys(pkg.optionalDependencies ?? {}).sort()).toEqual([
    "@modelcontextprotocol/sdk",
    "@opentui/core",
    "web-tree-sitter",
  ]);
});
