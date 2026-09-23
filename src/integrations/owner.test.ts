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

import { installRuntimeHook } from "../ctx/hook-install";
import { ANTIGRAVITY_RUNTIME, CLAUDE_RUNTIME } from "../ctx/runtimes";
import { getHarnessAdapter, surfacesOf } from "./registry";
import { createSettingsFileOwner, installSurfaces, uninstallSurfaces } from "./settings-file";
import { settingsFileOwnerFor } from "./index";
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

describe("R2-F4(d): install/uninstall propagate the owner's refusal exactly as installRuntimeHook/uninstallRuntimeHook/uninstallOrientRuntime promise", () => {
  // `installRuntimeHooks` (security), `uninstallRuntimeHook` (ctx) and
  // `uninstallOrientRuntime` (orient) accept no injectable owner — each
  // resolves `settingsFileOwnerFor(runtime.relativePath)` internally (see
  // `src/ctx/hook-install.ts`, `src/security/agent-hooks.ts`,
  // `src/ctx/orient-runtimes.ts`), so there is no seam in the public API to
  // hand them a deliberately-clobbering surface. The lowest seam that DOES
  // exist is exactly what each of those functions is a thin wrapper over:
  // `installSurfaces`/`uninstallSurfaces` plus a `SettingsFileOwner` built by
  // `createSettingsFileOwner` — the same construction `coexistence.test.ts`
  // already uses for the install-side clobber (F1). This proves the identical
  // contract those three functions document for themselves: install returns
  // the owner's errors ([] = ok), and uninstall throws when the owner
  // refuses (a previously-valid sibling surface would end up invalid).

  function buildCtxGuardWithFakeSibling(): { owner: ReturnType<typeof createSettingsFileOwner>; ctxId: string; siblingId: string } {
    const cursor = getHarnessAdapter("cursor")!;
    const ctxSurface = surfacesOf(cursor, { subsystem: "ctx-guard" })[0]!;
    // A plausible future sibling (W5-b/W8: another surface sharing this
    // file) that is only ever valid while the ctx guard's own `hooks` object
    // is present — modelling a surface that reads/depends on state the ctx
    // guard owns, without touching it itself.
    const fakeSibling: SurfaceAdapter = {
      id: "fake-cursor-sibling",
      flag: "block",
      subsystem: "security",
      sentinel: "fake-sibling-sentinel",
      confidence: "experimental",
      sourceDocs: ["test"],
      relativePath: ".cursor/hooks.json",
      slots: [],
      merge: (s) => s,
      strip: (s) => s,
      validate: (s: Settings) =>
        typeof s.hooks === "object" && s.hooks !== null && !Array.isArray(s.hooks)
          ? []
          : ["fake-cursor-sibling: hooks object missing"],
    };
    const owner = createSettingsFileOwner(".cursor/hooks.json", [ctxSurface, fakeSibling]);
    return { owner, ctxId: ctxSurface.id, siblingId: fakeSibling.id };
  }

  test("installSurfaces (installRuntimeHooks' own seam) returns the owner's errors, empty on a clean install", async () => {
    await withTempDir(async (root) => {
      const { owner, ctxId } = buildCtxGuardWithFakeSibling();
      const { errors } = await installSurfaces(root, ".cursor/hooks.json", [ctxId], owner);
      // The sibling is not installed, and starts absent (not previously
      // valid), so its own invalidity is not a refusal reason here — only a
      // surface that WAS valid and is neither installed nor uninstalled can
      // trigger that. This pins the non-refusal half of the same contract.
      expect(errors).toEqual([]);
    });
  });

  test("uninstallSurfaces refuses (non-empty errors) when uninstalling would leave a previously-valid sibling invalid, and the file is unchanged", async () => {
    await withTempDir(async (root) => {
      const { owner, ctxId, siblingId } = buildCtxGuardWithFakeSibling();
      const file = path.join(root, ".cursor", "hooks.json");

      // Install the ctx guard first — this is what makes the fake sibling
      // (which depends only on `hooks` being an object) become validly true.
      const installed = await installSurfaces(root, ".cursor/hooks.json", [ctxId], owner);
      expect(installed.errors).toEqual([]);
      const beforeUninstall = readFileSync(file, "utf8");

      // Now uninstall ONLY the ctx guard. Its strip removes the `hooks`
      // object entirely once nothing managed remains under it, which would
      // silently take the previously-valid fake sibling down with it — the
      // owner must refuse rather than write that.
      const uninstalled = await uninstallSurfaces(root, ".cursor/hooks.json", [ctxId], owner);
      expect(uninstalled.errors.length).toBeGreaterThan(0);
      expect(uninstalled.errors.some((e) => e.includes(siblingId))).toBe(true);

      // Refused: the file on disk is untouched.
      const afterUninstall = readFileSync(file, "utf8");
      expect(afterUninstall).toBe(beforeUninstall);

      // `uninstallRuntimeHook`/`uninstallOrientRuntime` re-throw exactly this
      // errors array (see their module comments) — reproduced here at the
      // seam that actually exists, since neither accepts this owner directly.
      expect(() => {
        if (uninstalled.errors.length > 0) throw new Error(uninstalled.errors.join("; "));
      }).toThrow();
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
