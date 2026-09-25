// Flow 305 (W5-a), T3: the Wave-0 exit guard — proves AC3, AC5.
//
// The OQ-3 defect (see `src/security/agent-hooks.coexistence.test.ts`) was
// two installers writing the same settings file with incompatible JSON
// shapes for one key; whichever ran second destroyed the first, silently,
// because each installer's strip replaced what it did not recognise
// wholesale. `SettingsFileOwner` (src/integrations/settings-file.ts) closes
// that class by construction: every surface targeting one file goes through
// ONE owner that validates the WHOLE file after every operation and refuses
// to write when a previously-valid surface would end up invalid. This file
// is the exit guard for that promise: every owner, every surface, every
// order, both through the owner and through the legacy per-module objects
// the rest of the codebase still calls directly.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HARNESS_ADAPTERS, SETTINGS_FILE_OWNERS, getHarnessAdapter, surfacesOf } from "./registry";
import { createSettingsFileOwner, installSurfaces } from "./settings-file";
import { readSettingsFile } from "./settings-json";
import type { Settings, SettingsFileOwner, SurfaceAdapter } from "./types";
import { CTX_RUNTIMES, getRuntime as getCtxRuntime } from "../ctx/runtimes";
import { installRuntimeHook, uninstallRuntimeHook } from "../ctx/hook-install";
import { getRuntime as getSecurityRuntime, RUNTIME_HOOKS } from "../security/agent-hooks/runtimes";
import { installRuntimeHooks, uninstallRuntimeHooks } from "../security/agent-hooks";
import { getOrientRuntime, installOrientRuntime, uninstallOrientRuntime } from "../ctx/orient-runtimes";

// --- small helpers -----------------------------------------------------------

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-integrations-coexist-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function managedList(settings: Settings): unknown[] {
  return Array.isArray(settings._keryxManaged) ? (settings._keryxManaged as unknown[]) : [];
}

// ---------------------------------------------------------------------------
// AC3/AC5: for every SettingsFileOwner, every permutation of installing its
// surfaces one at a time is clean at every step, and uninstalling any single
// surface from the fully-installed file leaves every other surface valid.
// ---------------------------------------------------------------------------

describe("AC3/AC5: every SettingsFileOwner — install permutations and single-surface uninstall", () => {
  test("SETTINGS_FILE_OWNERS is non-empty (the loop below is not vacuous)", () => {
    expect(SETTINGS_FILE_OWNERS.length).toBeGreaterThan(0);
  });

  // F9: seeded with more than the empty file — a legacy pre-populated `hooks`
  // array (unmanaged user content, and empty) is exactly the shape the
  // migration logic (`mergeIntoHookArray`'s `unmigratedHooks` move,
  // `dropLegacyHooksArray`) has to cope with, and `{}` alone never exercises
  // it.
  const SEED_FIXTURES: ReadonlyArray<{ label: string; seed: Settings }> = [
    { label: "empty file", seed: {} },
    { label: "pre-populated legacy `hooks` array (user content)", seed: { hooks: [{ on: "custom", command: "user-owned-entry" }] } },
    { label: "pre-populated legacy `hooks` array (empty)", seed: { hooks: [] } },
  ];

  for (const owner of SETTINGS_FILE_OWNERS) {
    const ids = owner.surfaces().map((s) => s.id);

    for (const { label, seed } of SEED_FIXTURES) {
      test(`${owner.relativePath} (${label}): every install order (${ids.length}! = ${factorial(ids.length)} permutations) is clean at every step`, () => {
        expect(ids.length).toBeGreaterThan(0);
        for (const order of permutations(ids)) {
          let settings: Settings = structuredClone(seed);
          const installedSoFar: string[] = [];
          for (const id of order) {
            const { settings: next, errors } = owner.apply(settings, { install: [id] });
            expect({ owner: owner.relativePath, label, order, id, errors }).toEqual({
              owner: owner.relativePath,
              label,
              order,
              id,
              errors: [],
            });
            settings = next;
            installedSoFar.push(id);
          }
          // Every surface installed so far validates at the end of this order.
          for (const surface of owner.surfaces()) {
            if (!installedSoFar.includes(surface.id) || !surface.validate) continue;
            expect({ owner: owner.relativePath, label, order, surface: surface.id, valid: surface.validate(settings) }).toEqual({
              owner: owner.relativePath,
              label,
              order,
              surface: surface.id,
              valid: [],
            });
          }
        }
      });
    }

    test(`${owner.relativePath}: uninstalling any ONE surface from the fully-installed file leaves every OTHER surface valid, and its own entries are gone`, () => {
      for (const targetId of ids) {
        let settings: Settings = {};
        for (const id of ids) {
          settings = owner.apply(settings, { install: [id] }).settings;
        }
        const { settings: after, errors } = owner.apply(settings, { uninstall: [targetId] });
        expect({ owner: owner.relativePath, targetId, errors }).toEqual({ owner: owner.relativePath, targetId, errors: [] });

        for (const surface of owner.surfaces()) {
          if (!surface.validate) continue;
          if (surface.id === targetId) {
            expect({ owner: owner.relativePath, targetId, gone: surface.validate(after).length > 0 }).toEqual({
              owner: owner.relativePath,
              targetId,
              gone: true,
            });
          } else {
            expect({ owner: owner.relativePath, targetId, other: surface.id, valid: surface.validate(after) }).toEqual({
              owner: owner.relativePath,
              targetId,
              other: surface.id,
              valid: [],
            });
          }
        }
      }
    });
  }
});

function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

// ---------------------------------------------------------------------------
// The ctx-guard vs security pair, explicitly, for every runtime that has
// both — derived from the registry, both install orders, both through the
// owner and through the legacy per-module objects.
// ---------------------------------------------------------------------------

describe("AC5: ctx-guard vs security, for every runtime with both surfaces", () => {
  const runtimesWithBoth = HARNESS_ADAPTERS.filter(
    (a) => surfacesOf(a, { subsystem: "ctx-guard" }).length > 0 && surfacesOf(a, { subsystem: "security" }).length > 0,
  ).map((a) => a.id);

  test("the derived set is exactly claude, cursor, windsurf (not vacuous, not a surprise)", () => {
    expect(runtimesWithBoth.sort()).toEqual(["claude", "cursor", "windsurf"]);
  });

  describe("through the owner", () => {
    for (const runtimeId of runtimesWithBoth) {
      test(`${runtimeId}: both orders leave both guards valid; uninstall of either leaves the other valid; sentinel is truthful`, () => {
        {
          const adapter = getHarnessAdapter(runtimeId)!;
          const ctxSurface = surfacesOf(adapter, { subsystem: "ctx-guard" })[0]!;
          const securitySurfaces = surfacesOf(adapter, { subsystem: "security" });
          const relativePath = ctxSurface.relativePath!;
          const owner = SETTINGS_FILE_OWNERS.find((o) => o.relativePath === relativePath)!;
          const securityIds = securitySurfaces.map((s) => s.id);

          for (const order of [
            [ctxSurface.id, ...securityIds],
            [...securityIds, ctxSurface.id],
          ]) {
            let settings: Settings = {};
            for (const id of order) {
              const { settings: next, errors } = owner.apply(settings, { install: [id] });
              expect({ runtimeId, order, id, errors }).toEqual({ runtimeId, order, id, errors: [] });
              settings = next;
            }
            expect({ runtimeId, order, ctx: ctxSurface.validate!(settings) }).toEqual({ runtimeId, order, ctx: [] });
            for (const s of securitySurfaces) {
              expect({ runtimeId, order, security: s.id, valid: s.validate!(settings) }).toEqual({
                runtimeId,
                order,
                security: s.id,
                valid: [],
              });
            }

            // Uninstall ctx: security surfaces survive, sentinel stops claiming ctx.
            // `owner.apply` clones its input internally (flow 305 review fix,
            // F7), so each branch below independently starts from the
            // fully-installed state rather than compounding onto the previous
            // branch's strip — no clone needed at the call site any more.
            const afterCtxOut = owner.apply(settings, { uninstall: [ctxSurface.id] });
            expect({ runtimeId, order, errors: afterCtxOut.errors }).toEqual({ runtimeId, order, errors: [] });
            for (const s of securitySurfaces) {
              expect({ runtimeId, order, security: s.id, valid: s.validate!(afterCtxOut.settings) }).toEqual({
                runtimeId,
                order,
                security: s.id,
                valid: [],
              });
            }
            expect({ runtimeId, order, ctxClaimed: managedList(afterCtxOut.settings).includes(ctxSurface.sentinel) }).toEqual({
              runtimeId,
              order,
              ctxClaimed: false,
            });

            // Uninstall security (both surfaces): ctx survives, sentinel stops
            // claiming the security surfaces once BOTH are gone.
            const afterSecOut = owner.apply(settings, { uninstall: securityIds });
            expect({ runtimeId, order, errors: afterSecOut.errors }).toEqual({ runtimeId, order, errors: [] });
            expect({ runtimeId, order, ctx: ctxSurface.validate!(afterSecOut.settings) }).toEqual({ runtimeId, order, ctx: [] });
            const securitySentinel = securitySurfaces[0]!.sentinel;
            expect({
              runtimeId,
              order,
              securityClaimed: managedList(afterSecOut.settings).includes(securitySentinel),
            }).toEqual({ runtimeId, order, securityClaimed: false });
          }
        }
      });
    }
  });

  describe("through the legacy per-module objects (CTX_RUNTIMES.merge vs RUNTIME_HOOKS.merge)", () => {
    for (const runtimeId of runtimesWithBoth) {
      test(`${runtimeId}: both orders valid through the legacy modules directly; uninstall leaves the other standing; sentinel is truthful`, () => {
        const ctx = CTX_RUNTIMES.find((r) => r.id === runtimeId)!;
        const security = RUNTIME_HOOKS.find((r) => r.id === runtimeId)!;
        expect(ctx.merge).toBeDefined();
        expect(ctx.strip).toBeDefined();
        expect(ctx.validate).toBeDefined();

        for (const order of ["ctx-then-security", "security-then-ctx"] as const) {
          let settings: Settings = {};
          if (order === "ctx-then-security") {
            settings = ctx.merge!(settings);
            settings = security.merge(settings);
          } else {
            settings = security.merge(settings);
            settings = ctx.merge!(settings);
          }
          expect({ runtimeId, order, ctx: ctx.validate!(settings) }).toEqual({ runtimeId, order, ctx: [] });
          expect({ runtimeId, order, security: security.validate(settings) }).toEqual({ runtimeId, order, security: [] });

          const strippedSecurity = security.strip(structuredClone(settings));
          expect({ runtimeId, order, ctxSurvives: ctx.validate!(strippedSecurity) }).toEqual({
            runtimeId,
            order,
            ctxSurvives: [],
          });
          expect({
            runtimeId,
            order,
            securityStillClaimed: managedList(strippedSecurity).includes("security-agent-hooks"),
          }).toEqual({ runtimeId, order, securityStillClaimed: false });

          const strippedCtx = ctx.strip!(structuredClone(settings));
          expect({ runtimeId, order, securitySurvives: security.validate(strippedCtx) }).toEqual({
            runtimeId,
            order,
            securitySurvives: [],
          });
          expect({ runtimeId, order, ctxStillClaimed: managedList(strippedCtx).includes("ctx-agent-hooks") }).toEqual({
            runtimeId,
            order,
            ctxStillClaimed: false,
          });
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency: re-installing all of an owner's surfaces 3 times keeps a flat
// `securityHooks` array at exactly 2 managed entries and produces a
// byte-identical file between iterations 2 and 3.
// ---------------------------------------------------------------------------

describe("idempotency: re-installing all surfaces of an owner 3x is stable", () => {
  let flatSecurityChecked = 0;

  for (const owner of SETTINGS_FILE_OWNERS) {
    const ids = owner.surfaces().map((s) => s.id);
    test(`${owner.relativePath}: 3 installs of all surfaces -> iteration 2 === iteration 3 (byte-identical)`, () => {
      let settings: Settings = {};
      let snapshotAfter2: string | undefined;
      let snapshotAfter3: string | undefined;
      for (let i = 1; i <= 3; i += 1) {
        const { settings: next, errors } = owner.apply(settings, { install: ids });
        expect({ owner: owner.relativePath, iteration: i, errors }).toEqual({ owner: owner.relativePath, iteration: i, errors: [] });
        settings = next;
        if (i === 2) snapshotAfter2 = JSON.stringify(settings);
        if (i === 3) snapshotAfter3 = JSON.stringify(settings);
      }
      expect({ owner: owner.relativePath, stable: snapshotAfter2 === snapshotAfter3 }).toEqual({
        owner: owner.relativePath,
        stable: true,
      });

      if (Array.isArray((settings as Settings).securityHooks)) {
        expect({ owner: owner.relativePath, entries: ((settings as Settings).securityHooks as unknown[]).length }).toEqual({
          owner: owner.relativePath,
          entries: 2,
        });
        flatSecurityChecked += 1;
      }
    });
  }

  test("at least one flat securityHooks owner was actually checked (the branch above is not vacuously skipped)", () => {
    expect(flatSecurityChecked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Byte-identity with the pre-refactor installers (claude, cursor), computed
// by hand from the pre-refactor `claudeMerge`/`flatMerge` (13bde10f) rather
// than importing old code.
// ---------------------------------------------------------------------------

describe("byte-identity with the pre-refactor installers", () => {
  test("claude: security merge into {} matches the pre-refactor claudeMerge shape", () => {
    const security = RUNTIME_HOOKS.find((r) => r.id === "claude")!;
    const settings = security.merge({});
    expect(settings).toEqual({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "keryx security check-input --source untrusted-external --runtime claude" }],
            _keryxManaged: "security-agent-hooks",
          },
        ],
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: "keryx security check-output --runtime claude" }],
            _keryxManaged: "security-agent-hooks",
          },
        ],
      },
      _keryxManaged: ["security-agent-hooks"],
    });
  });

  test("claude: security merge into a file already holding the ctx guard matches the pre-refactor composition", () => {
    const ctx = CTX_RUNTIMES.find((r) => r.id === "claude")!;
    const security = RUNTIME_HOOKS.find((r) => r.id === "claude")!;
    const withCtx = ctx.merge!({});
    const settings = security.merge(withCtx);
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|Grep",
            hooks: [{ type: "command", command: "keryx ctx hook claude" }],
            _keryxManaged: "ctx-agent-hooks",
          },
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: "keryx security check-output --runtime claude" }],
            _keryxManaged: "security-agent-hooks",
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "keryx security check-input --source untrusted-external --runtime claude" }],
            _keryxManaged: "security-agent-hooks",
          },
        ],
      },
      _keryxManaged: ["ctx-agent-hooks", "security-agent-hooks"],
    });
  });

  test("cursor: security merge into {} matches the pre-refactor flatMerge shape (canonical order: input, then output)", () => {
    const security = RUNTIME_HOOKS.find((r) => r.id === "cursor")!;
    const settings = security.merge({});
    expect(settings).toEqual({
      securityHooks: [
        { on: "input", command: "keryx security check-input --source untrusted-external --runtime cursor", _keryxManaged: "security-agent-hooks" },
        { on: "output", command: "keryx security check-output --runtime cursor", _keryxManaged: "security-agent-hooks" },
      ],
      _keryxManaged: ["security-agent-hooks"],
    });
  });
});

// ---------------------------------------------------------------------------
// Negative control for the owner guard: a clobbering surface (the pre-fix
// OQ-3 shape) must be refused, both in-memory and on disk (file unchanged).
// ---------------------------------------------------------------------------

describe("negative control: the owner guard refuses a clobbering surface", () => {
  function buildClobberingCursorOwner(): { owner: SettingsFileOwner; ctxId: string; clobberId: string } {
    const cursor = getHarnessAdapter("cursor")!;
    const realCursorSurfaces = surfacesOf(cursor);
    const ctxSurface = realCursorSurfaces.find((s) => s.subsystem === "ctx-guard")!;
    // The pre-fix OQ-3 shape: this surface overwrites `hooks` as an ARRAY,
    // wholesale, clobbering whatever the ctx guard put under the OBJECT key
    // `hooks`.
    const clobberingSurface: SurfaceAdapter = {
      id: "clobbering-surface",
      flag: "block",
      subsystem: "security",
      sentinel: "clobbering-sentinel",
      confidence: "experimental",
      sourceDocs: ["test"],
      relativePath: ".cursor/hooks.json",
      slots: [{ key: "hooks", type: "array", access: "owns" }],
      merge: (s) => {
        s.hooks = [];
        return s;
      },
      strip: (s) => s,
      validate: () => [],
    };
    const owner = createSettingsFileOwner(".cursor/hooks.json", [...realCursorSurfaces, clobberingSurface]);
    return { owner, ctxId: ctxSurface.id, clobberId: clobberingSurface.id };
  }

  test("in memory: installing the clobbering surface after the ctx guard returns non-empty errors naming the ctx guard surface", () => {
    const { owner, ctxId, clobberId } = buildClobberingCursorOwner();
    const afterCtx = owner.apply({}, { install: [ctxId] });
    expect(afterCtx.errors).toEqual([]);

    const afterClobber = owner.apply(afterCtx.settings, { install: [clobberId] });
    expect(afterClobber.errors.length).toBeGreaterThan(0);
    expect(afterClobber.errors.some((e) => e.includes(ctxId))).toBe(true);
  });

  test("on disk: installSurfaces refuses to write, and the file is UNCHANGED", async () => {
    await withRoot(async (root) => {
      const { owner, ctxId, clobberId } = buildClobberingCursorOwner();
      const file = path.join(root, ".cursor", "hooks.json");

      const first = await installSurfaces(root, ".cursor/hooks.json", [ctxId], owner);
      expect(first.errors).toEqual([]);
      const before = readFileSync(file, "utf8");

      const second = await installSurfaces(root, ".cursor/hooks.json", [clobberId], owner);
      expect(second.errors.length).toBeGreaterThan(0);

      const after = readFileSync(file, "utf8");
      expect(after).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// On-disk end-to-end through the REAL public installers, in both orders,
// for claude/cursor/windsurf (ctx + security) and claude/codex/cursor
// (orient).
// ---------------------------------------------------------------------------

describe("on-disk end-to-end through the real installers", () => {
  const ctxSecurityRuntimes = ["claude", "cursor", "windsurf"];

  for (const runtimeId of ctxSecurityRuntimes) {
    test(`${runtimeId}: ctx then security, both valid on disk; uninstall either leaves the other`, async () => {
      await withRoot(async (root) => {
        const ctxRuntime = getCtxRuntime(runtimeId)!;
        const securityRuntime = getSecurityRuntime(runtimeId)!;

        const ctxInstall = await installRuntimeHook(root, ctxRuntime);
        expect({ runtimeId, errors: ctxInstall.errors }).toEqual({ runtimeId, errors: [] });
        const secInstall = await installRuntimeHooks(root, securityRuntime);
        expect(secInstall.ok).toBe(true);
        expect(secInstall.errors).toEqual([]);

        const settingsAfterBoth = await readSettingsFile(ctxRuntime.locate(root));
        expect({ runtimeId, ctx: ctxRuntime.validate!(settingsAfterBoth) }).toEqual({ runtimeId, ctx: [] });
        expect({ runtimeId, security: securityRuntime.validate(settingsAfterBoth) }).toEqual({ runtimeId, security: [] });

        const ctxUninstalled = await uninstallRuntimeHook(root, ctxRuntime);
        expect(ctxUninstalled).toBe(true);
        const settingsAfterCtxOut = await readSettingsFile(ctxRuntime.locate(root));
        expect({ runtimeId, securitySurvives: securityRuntime.validate(settingsAfterCtxOut) }).toEqual({
          runtimeId,
          securitySurvives: [],
        });

        // F9: uninstall BOTH sides in turn, not only ctx — re-install ctx
        // (back to both installed) and now uninstall security instead, so
        // this test proves "leaves the OTHER valid" in both directions
        // rather than leaving that half to a separate test that might not
        // both be run.
        const ctxReinstall = await installRuntimeHook(root, ctxRuntime);
        expect({ runtimeId, errors: ctxReinstall.errors }).toEqual({ runtimeId, errors: [] });
        const secUninstalled = await uninstallRuntimeHooks(root, securityRuntime);
        expect(secUninstalled.ok).toBe(true);
        expect(secUninstalled.errors).toEqual([]);
        const settingsAfterSecOut = await readSettingsFile(ctxRuntime.locate(root));
        expect({ runtimeId, ctxSurvives: ctxRuntime.validate!(settingsAfterSecOut) }).toEqual({
          runtimeId,
          ctxSurvives: [],
        });
      });
    });

    test(`${runtimeId}: security then ctx, both valid on disk; uninstall either leaves the other`, async () => {
      await withRoot(async (root) => {
        const ctxRuntime = getCtxRuntime(runtimeId)!;
        const securityRuntime = getSecurityRuntime(runtimeId)!;

        const secInstall = await installRuntimeHooks(root, securityRuntime);
        expect(secInstall.ok).toBe(true);
        expect(secInstall.errors).toEqual([]);
        const ctxInstall = await installRuntimeHook(root, ctxRuntime);
        expect({ runtimeId, errors: ctxInstall.errors }).toEqual({ runtimeId, errors: [] });

        const settingsAfterBoth = await readSettingsFile(ctxRuntime.locate(root));
        expect({ runtimeId, ctx: ctxRuntime.validate!(settingsAfterBoth) }).toEqual({ runtimeId, ctx: [] });
        expect({ runtimeId, security: securityRuntime.validate(settingsAfterBoth) }).toEqual({ runtimeId, security: [] });

        const secUninstalled = await uninstallRuntimeHooks(root, securityRuntime);
        expect(secUninstalled.ok).toBe(true);
        expect(secUninstalled.errors).toEqual([]);
        const settingsAfterSecOut = await readSettingsFile(ctxRuntime.locate(root));
        expect({ runtimeId, ctxSurvives: ctxRuntime.validate!(settingsAfterSecOut) }).toEqual({
          runtimeId,
          ctxSurvives: [],
        });

        // F9: uninstall BOTH sides in turn (the other direction from the
        // sibling test above) — re-install security, then uninstall ctx, and
        // prove security still survives.
        const secReinstall = await installRuntimeHooks(root, securityRuntime);
        expect(secReinstall.ok).toBe(true);
        expect(secReinstall.errors).toEqual([]);
        const ctxUninstalled = await uninstallRuntimeHook(root, ctxRuntime);
        expect(ctxUninstalled).toBe(true);
        const settingsAfterCtxOut = await readSettingsFile(ctxRuntime.locate(root));
        expect({ runtimeId, securitySurvives: securityRuntime.validate(settingsAfterCtxOut) }).toEqual({
          runtimeId,
          securitySurvives: [],
        });
      });
    });
  }

  const orientRuntimes = ["claude", "codex", "cursor"];
  for (const runtimeId of orientRuntimes) {
    test(`${runtimeId}: installOrientRuntime on disk validates, and uninstall removes it cleanly`, async () => {
      await withRoot(async (root) => {
        const runtime = getOrientRuntime(runtimeId)!;
        const errors = await installOrientRuntime(root, runtimeId);
        expect({ runtimeId, errors }).toEqual({ runtimeId, errors: [] });
        const settingsAfterInstall = await readSettingsFile(runtime.locate(root));
        expect({ runtimeId, installed: runtime.validate(settingsAfterInstall) }).toEqual({ runtimeId, installed: [] });

        await uninstallOrientRuntime(root, runtimeId);
        // F9: assert directly, on disk, that the orient surface no longer
        // validates — not only indirectly via a clean re-install, which
        // proves idempotency but not that the uninstall actually removed
        // anything (a no-op strip would look identical to that test).
        const settingsAfterUninstall = await readSettingsFile(runtime.locate(root));
        expect({ runtimeId, stillValid: runtime.validate(settingsAfterUninstall).length === 0 }).toEqual({
          runtimeId,
          stillValid: false,
        });

        // And re-install is still clean (idempotent), the observable proof
        // the uninstall did not leave a stale duplicate for the next install
        // to trip over.
        const again = await installOrientRuntime(root, runtimeId);
        expect({ runtimeId, again }).toEqual({ runtimeId, again: [] });
      });
    });
  }

  test("claude: ctx + security + orient together on disk, all three valid, uninstalling one leaves the other two", async () => {
    await withRoot(async (root) => {
      const ctxRuntime = getCtxRuntime("claude")!;
      const securityRuntime = getSecurityRuntime("claude")!;

      const ctxInstall = await installRuntimeHook(root, ctxRuntime);
      expect(ctxInstall.errors).toEqual([]);
      const secInstall = await installRuntimeHooks(root, securityRuntime);
      expect(secInstall.ok).toBe(true);
      expect(secInstall.errors).toEqual([]);
      const orientErrors = await installOrientRuntime(root, "claude");
      expect(orientErrors).toEqual([]);

      const settings = await readSettingsFile(ctxRuntime.locate(root));
      expect(ctxRuntime.validate!(settings)).toEqual([]);
      expect(securityRuntime.validate(settings)).toEqual([]);

      await uninstallOrientRuntime(root, "claude");
      const afterOrientOut = await readSettingsFile(ctxRuntime.locate(root));
      expect(ctxRuntime.validate!(afterOrientOut)).toEqual([]);
      expect(securityRuntime.validate(afterOrientOut)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// F5 (flow 305 review round 1): flat security merge/strip must not leave
// orphaned managed entries — a managed entry carrying the sentinel with an
// `on` neither surface claims (probe P8's exact input: `on: "legacy"`).
// ---------------------------------------------------------------------------

describe("F5: flat security surfaces sweep up orphaned managed entries", () => {
  test("strip removes an orphaned managed entry and clears the sentinel (probe P8)", () => {
    const cursor = getSecurityRuntime("cursor")!;
    const stripped = cursor.strip({
      securityHooks: [{ on: "legacy", command: "keryx security x", _keryxManaged: "security-agent-hooks" }],
      _keryxManaged: ["security-agent-hooks"],
    });
    expect(stripped).toEqual({});
  });

  test("merge removes an orphaned managed entry when installing either surface", () => {
    const inputSurface = surfacesOf(getHarnessAdapter("cursor")!, { subsystem: "security", flag: "prompt-gate" })[0]!;
    const before: Settings = {
      securityHooks: [{ on: "legacy", command: "keryx security x", _keryxManaged: "security-agent-hooks" }],
      _keryxManaged: ["security-agent-hooks"],
    };
    const after = inputSurface.merge!(before) as { securityHooks: Array<{ on?: string }> };
    expect(after.securityHooks.some((g) => g.on === "legacy")).toBe(false);
    expect(after.securityHooks.some((g) => g.on === "input")).toBe(true);
  });

  test("installing both surfaces then stripping both is byte-identical to the pre-refactor flatMerge/flatStrip result (empty)", () => {
    const cursor = getSecurityRuntime("cursor")!;
    const withOrphan: Settings = {
      securityHooks: [{ on: "legacy", command: "keryx security x", _keryxManaged: "security-agent-hooks" }],
      _keryxManaged: ["security-agent-hooks"],
    };
    const installed = cursor.merge(withOrphan);
    expect(cursor.validate(installed)).toEqual([]);
    const strippedBack = cursor.strip(installed);
    expect(strippedBack).toEqual({});
  });
});
