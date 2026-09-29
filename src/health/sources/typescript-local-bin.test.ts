import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { typescriptAdapter } from "./typescript";
import { resolveBin } from "./helpers";
import { toolVersion } from "../util";
import type { HealthContext } from "../types";

function root(): string {
  return path.join(tmpdir(), `keryx-tsc-local-${process.pid}-${Date.now()}`);
}

test("a local tsc is available even when PATH has no tsc", async () => {
  const cwd = root();
  const bin = path.join(cwd, "node_modules", ".bin", "tsc");
  const script = ["#!/bin/sh", "echo Version 7.0.2", "exit 0", ""].join("\n");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(cwd, "tsconfig.json"), "{}\n");
    await writeFile(bin, script);
    await chmod(bin, 0o755);
    const ctx = { cwd } as HealthContext;
    expect(resolveBin(cwd, "tsc")).toBe(bin);
    expect(await typescriptAdapter.detect(ctx)).toBe("available");
    const version = await toolVersion([bin, "--version"], cwd);
    expect(version).toBe("Version 7.0.2");

    // AC4: `available` is only half the claim -- the run has to invoke THAT
    // binary (not a PATH `tsc` that may not exist here at all) with the
    // type-check-only flags, so a project whose compiler lives in
    // node_modules is checked by its own compiler.
    const raw = await typescriptAdapter.run(ctx);
    expect(raw.source).toBe("typescript");
    expect((raw.command ?? "").split(" ")[0]).toBe(bin);
    expect(raw.command).toContain("--noEmit");
    expect(raw.command).toContain("--pretty false");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
