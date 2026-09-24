// Flow 305 (W5-a), R2-F4: regression tests for round-1 fixes (F1/F2/F7) that
// shipped with no test pinning them — a mutation-testing pass found 215/215
// tests still green with those fixes reverted. Each test here is CI-safe:
// mkdtemp + cleanup in `finally`, no git, no network, no dependence on git
// author config.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

import { installRuntimeHook, uninstallRuntimeHook } from "../ctx/hook-install";
import { ANTIGRAVITY_RUNTIME, CLAUDE_RUNTIME, CURSOR_RUNTIME } from "../ctx/runtimes";
import { installOrientRuntime, uninstallOrientRuntime } from "../ctx/orient-runtimes";
import { installRuntimeHooks, uninstallRuntimeHooks } from "../security/agent-hooks";
import { CLAUDE_RUNTIME as SECURITY_CLAUDE_RUNTIME } from "../security/agent-hooks/runtimes";
import { getHarnessAdapter, surfacesOf } from "./registry";
import { createSettingsFileOwner, installSurfaces } from "./settings-file";
import { settingsFileOwnerFor } from "./service";
import type { Settings, SurfaceAdapter } from "./types";

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-integrations-owner-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("R2-F4(a): owner refuses cleanly on a pre-existing array-shaped antigravity container", () => {
  test("installing antigravity into .agents/hooks.json = {\"keryx-ctx-guard\": []} returns errors and leaves the file byte-identical", async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, ".agents", "hooks.json");
      await mkdir(path.dirname(file), { recursive: true });
      const original = JSON.stringify({ "keryx-ctx-guard": [] }, null, 2) + "\n";
      await writeFile(file, original, "utf8");

      const { errors } = await installRuntimeHook(root, ANTIGRAVITY_RUNTIME);
      expect(errors.length).toBeGreaterThan(0);

      const after = await readFile(file, "utf8");
      expect(after).toBe(original);
    });
  });
});

describe("R2-F4(b): an unknown surface id is refused with no write", () => {
  test("installSurfaces with an unknown id errors and creates no file/dir", async () => {
    await withTempDir(async (root) => {
      const relativePath = ".claude/settings.json";
      const owner = settingsFileOwnerFor(relativePath)!;
      const { errors } = await installSurfaces(root, relativePath, ["totally-unknown-surface-id"], owner);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('unknown surface id "totally-unknown-surface-id"');
      // Neither the file nor its parent directory was created.
      expect(existsSync(path.join(root, ".claude"))).toBe(false);
    });
  });
});

describe("R2-F4(c): shuffled install id order yields byte-identical output", () => {
  test("the claude owner applies installs in its own canonical order regardless of the caller's array order", () => {
    const relativePath = ".claude/settings.json";
    const owner = settingsFileOwnerFor(relativePath)!;
    const ids = owner.surfaces().map((s) => s.id);
    expect(ids.length).toBeGreaterThan(1);

    const forward = owner.apply({}, { install: ids });
    const shuffled = owner.apply({}, { install: [...ids].reverse() });

    expect(forward.errors).toEqual([]);
    expect(shuffled.errors).toEqual([]);
    expect(JSON.stringify(shuffled.settings)).toBe(JSON.stringify(forward.settings));
  });
});

describe("R3-F2: installRuntimeHooks/uninstallRuntimeHooks/installRuntimeHook/uninstallRuntimeHook/installOrientRuntime/uninstallOrientRuntime propagate a refusing owner", () => {
  // Each of the six wrappers now takes an OPTIONAL trailing `owner` (default:
  // the registry's own `settingsFileOwnerFor(runtime.relativePath)`, exactly
  // as before) — see `src/security/agent-hooks.ts`, `src/ctx/hook-install.ts`,
  // `src/ctx/orient-runtimes.ts`. That seam is what lets this test drive the
  // REAL wrapper functions directly with a deliberately-clobbering fake
  // sibling, rather than reproducing their install/uninstall-then-throw
  // contract a second time at the lower `installSurfaces`/`uninstallSurfaces`
  // seam (the R2-F4(d) version of this test, which never actually called any
  // of the six functions it was named after).

  // A fake sibling that is valid ONLY while `hooks` is absent — so a real
  // surface's merge (which always introduces a `hooks` object) breaks it,
  // making an INSTALL refuse.
  function siblingRequiringHooksAbsent(relativePath: string, id: string): SurfaceAdapter {
    return {
      id,
      flag: "block",
      subsystem: "security",
      sentinel: `fake-sentinel-${id}`,
      confidence: "experimental",
      sourceDocs: ["test"],
      relativePath,
      slots: [],
      merge: (s) => s,
      strip: (s) => s,
      validate: (s: Settings) => (s.hooks === undefined ? [] : [`${id}: hooks must stay absent`]),
    };
  }

  // A fake sibling that is valid ONLY while `hooks` is a (non-array) object —
  // so a real surface's strip, which removes `hooks` entirely once nothing
  // managed remains under it, breaks it, making an UNINSTALL refuse. This is
  // the same shape `buildCtxGuardWithFakeSibling` used above (R2-F4(d)).
  function siblingRequiringHooksObject(relativePath: string, id: string): SurfaceAdapter {
    return {
      id,
      flag: "block",
      subsystem: "security",
      sentinel: `fake-sentinel-${id}`,
      confidence: "experimental",
      sourceDocs: ["test"],
      relativePath,
      slots: [],
      merge: (s) => s,
      strip: (s) => s,
      validate: (s: Settings) =>
        typeof s.hooks === "object" && s.hooks !== null && !Array.isArray(s.hooks) ? [] : [`${id}: hooks object missing`],
    };
  }

  test("installRuntimeHooks (security) returns {ok:false, errors:[...]} and leaves the file unchanged", async () => {
    await withTempDir(async (root) => {
      const claude = getHarnessAdapter("claude")!;
      const securitySurfaces = surfacesOf(claude, { subsystem: "security" });
      const sibling = siblingRequiringHooksAbsent(".claude/settings.json", "fake-sibling-install-security");
      const owner = createSettingsFileOwner(".claude/settings.json", [...securitySurfaces, sibling]);

      const result = await installRuntimeHooks(root, SECURITY_CLAUDE_RUNTIME, owner);

      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Refused before any write: no file, not even the parent directory.
      expect(existsSync(path.join(root, ".claude"))).toBe(false);
    });
  });

  test("uninstallRuntimeHooks (security) returns {ok:false, errors:[...]} and leaves the file unchanged", async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, ".claude", "settings.json");
      // Install for real first (no override — the registry's own owner), so
      // there is real, previously-valid content on disk.
      const installed = await installRuntimeHooks(root, SECURITY_CLAUDE_RUNTIME);
      expect(installed.ok).toBe(true);
      const before = readFileSync(file, "utf8");

      const claude = getHarnessAdapter("claude")!;
      const securitySurfaces = surfacesOf(claude, { subsystem: "security" });
      const sibling = siblingRequiringHooksObject(".claude/settings.json", "fake-sibling-uninstall-security");
      const owner = createSettingsFileOwner(".claude/settings.json", [...securitySurfaces, sibling]);

      const result = await uninstallRuntimeHooks(root, SECURITY_CLAUDE_RUNTIME, owner);

      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  });

  test("installRuntimeHook (ctx) returns non-empty errors and leaves the file unchanged", async () => {
    await withTempDir(async (root) => {
      const cursor = getHarnessAdapter("cursor")!;
      const ctxSurface = surfacesOf(cursor, { subsystem: "ctx-guard" })[0]!;
      const sibling = siblingRequiringHooksAbsent(".cursor/hooks.json", "fake-sibling-install-ctx");
      const owner = createSettingsFileOwner(".cursor/hooks.json", [ctxSurface, sibling]);

      const { errors } = await installRuntimeHook(root, CURSOR_RUNTIME, owner);

      expect(errors.length).toBeGreaterThan(0);
      expect(existsSync(path.join(root, ".cursor"))).toBe(false);
    });
  });

  test("uninstallRuntimeHook (ctx) throws with the owner's message and leaves the file unchanged", async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, ".cursor", "hooks.json");
      const installed = await installRuntimeHook(root, CURSOR_RUNTIME);
      expect(installed.errors).toEqual([]);
      const before = readFileSync(file, "utf8");

      const cursor = getHarnessAdapter("cursor")!;
      const ctxSurface = surfacesOf(cursor, { subsystem: "ctx-guard" })[0]!;
      const sibling = siblingRequiringHooksObject(".cursor/hooks.json", "fake-sibling-uninstall-ctx");
      const owner = createSettingsFileOwner(".cursor/hooks.json", [ctxSurface, sibling]);

      let thrown: unknown;
      try {
        await uninstallRuntimeHook(root, CURSOR_RUNTIME, owner);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("fake-sibling-uninstall-ctx");
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  });

  test("installOrientRuntime returns non-empty errors and leaves the file unchanged", async () => {
    await withTempDir(async (root) => {
      const claude = getHarnessAdapter("claude")!;
      const orientSurface = surfacesOf(claude, { subsystem: "orient" })[0]!;
      const sibling = siblingRequiringHooksAbsent(".claude/settings.json", "fake-sibling-install-orient");
      const owner = createSettingsFileOwner(".claude/settings.json", [orientSurface, sibling]);

      const errors = await installOrientRuntime(root, "claude", owner);

      expect(errors.length).toBeGreaterThan(0);
      expect(existsSync(path.join(root, ".claude"))).toBe(false);
    });
  });

  test("uninstallOrientRuntime throws with the owner's message and leaves the file unchanged", async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, ".claude", "settings.json");
      const installErrors = await installOrientRuntime(root, "claude");
      expect(installErrors).toEqual([]);
      const before = readFileSync(file, "utf8");

      const claude = getHarnessAdapter("claude")!;
      const orientSurface = surfacesOf(claude, { subsystem: "orient" })[0]!;
      const sibling = siblingRequiringHooksObject(".claude/settings.json", "fake-sibling-uninstall-orient");
      const owner = createSettingsFileOwner(".claude/settings.json", [orientSurface, sibling]);

      let thrown: unknown;
      try {
        await uninstallOrientRuntime(root, "claude", owner);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("fake-sibling-uninstall-orient");
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  });
});

describe("R2-F4(e): CLI smoke test — ctx install-hook --runtime antigravity refuses on a pre-existing array container", () => {
  test("exit code 1, error on stderr, file unchanged", async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, ".agents", "hooks.json");
      await mkdir(path.dirname(file), { recursive: true });
      const original = JSON.stringify({ "keryx-ctx-guard": [] }, null, 2) + "\n";
      await writeFile(file, original, "utf8");

      const cliPath = path.join(import.meta.dir, "..", "cli.ts");
      const result = spawnSync("bun", [cliPath, "ctx", "install-hook", "--runtime", "antigravity"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toBeTruthy();

      const after = await readFile(file, "utf8");
      expect(after).toBe(original);
    });
  });
});

// Regression pin: CLAUDE_RUNTIME still resolves the real claude ctx-guard
// runtime rather than a stale re-export left behind by the codec/registry move.
describe("sanity", () => {
  test("CLAUDE_RUNTIME is the claude ctx-guard runtime", () => {
    expect(CLAUDE_RUNTIME.id).toBe("claude");
  });
});
