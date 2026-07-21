import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { proxyWorkerUrl } from "./network-run";

describe("proxy worker resolution", () => {
  test("resolves to the real source worker when running from src", () => {
    const resolved = fileURLToPath(proxyWorkerUrl());
    expect(resolved.endsWith("proxy-worker.ts")).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  // Regression guard for the bundled build: `bun build` does NOT follow the
  // dynamic `new Worker(new URL(...))` reference, so the worker is a SEPARATE
  // build entry emitted next to cli.js. If that entry is dropped, every
  // restricted-network run fails with `ModuleNotFound .../proxy-worker.ts`.
  test("a built dist ships proxy-worker.js next to cli.js", () => {
    const dist = path.join(process.cwd(), "dist");
    const cli = path.join(dist, "cli.js");
    if (!existsSync(cli)) {
      return; // nothing built in this environment — nothing to assert
    }
    expect(existsSync(path.join(dist, "proxy-worker.js"))).toBe(true);
  });
});
