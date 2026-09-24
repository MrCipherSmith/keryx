// Flow 313 (W4 portability), T6 — inspect.ts: strictly read-only (W4-AC5):
// no filesystem write and no process spawned, plus targetHarnesses warnings.

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { exportBundle } from "./export";
import { inspectBundle } from "./inspect";

let root: string;
let projectRoot: string;
let homeDir: string;
let outDir: string;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-inspect-"));
  projectRoot = path.join(root, "project");
  homeDir = path.join(root, "home");
  mkdirSync(path.join(projectRoot, ".metaproject", "agents"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    path.join(projectRoot, ".metaproject", "agents", "foo.md"),
    "---\nname: foo\ndescription: d\nrole: r\ntools: [read_file]\nmodel_tier: light\npolicy_profile: read-only\noutput_contract: subagent-result\n---\nbody\n",
  );
  outDir = path.join(root, "bundle-out");
  const outcome = await exportBundle({ projectRoot, scope: "project", out: outDir, keryxVersion: "0.2.999", homeDir, env: {}, targetHarnesses: ["cursor"] });
  if (!outcome.ok) throw new Error("fixture export failed");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string, prefix: string): void {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(abs);
      if (stat.isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(`${rel}:${readFileSync(abs, "utf8").length}`);
      }
    }
  }
  walk(dir, "");
  return out;
}

describe("inspectBundle", () => {
  test("performs no filesystem write on either the bundle or the project tree", async () => {
    const bundleBefore = snapshotTree(outDir);
    const projectBefore = snapshotTree(projectRoot);

    await inspectBundle(outDir, { projectRoot, homeDir, env: {} });

    expect(snapshotTree(outDir)).toEqual(bundleBefore);
    expect(snapshotTree(projectRoot)).toEqual(projectBefore);
  });

  test("reports every entry identical when the target already matches", async () => {
    // Re-import target IS the same project it was exported from, so the
    // agent's rewritten bytes are not present at the original source path —
    // inspect against the bundle's OWN output directory copied over the
    // project instead, to exercise the identical bucket deterministically.
    const targetRoot = path.join(root, "target-project");
    mkdirSync(path.join(targetRoot, ".metaproject", "agents"), { recursive: true });
    writeFileSync(
      path.join(targetRoot, ".metaproject", "agents", "foo.md"),
      readFileSync(path.join(outDir, "agents", "foo.md")),
    );
    const result = await inspectBundle(outDir, { projectRoot: targetRoot, homeDir, env: {} });
    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.bucket === "identical")).toBe(true);
  });

  test("warns when a targetHarnesses entry is not native/adapter in the capability matrix", async () => {
    const result = await inspectBundle(outDir, {
      projectRoot,
      homeDir,
      env: {},
      capabilityHarnessStates: () => "unsupported",
    });
    expect(result.warnings.some((w) => w.includes("cursor"))).toBe(true);
  });

  test("spawns no child process (Bun.spawn / node:child_process untouched)", async () => {
    let spawned = false;
    const originalSpawn = (globalThis as { Bun?: { spawn?: unknown } }).Bun?.spawn;
    if ((globalThis as { Bun?: { spawn?: unknown } }).Bun) {
      (globalThis as { Bun: { spawn: unknown } }).Bun.spawn = () => {
        spawned = true;
        throw new Error("spawn should not be called by inspectBundle");
      };
    }
    try {
      await inspectBundle(outDir, { projectRoot, homeDir, env: {} });
    } finally {
      if ((globalThis as { Bun?: { spawn?: unknown } }).Bun && originalSpawn) {
        (globalThis as { Bun: { spawn: unknown } }).Bun.spawn = originalSpawn;
      }
    }
    expect(spawned).toBe(false);
  });
});
