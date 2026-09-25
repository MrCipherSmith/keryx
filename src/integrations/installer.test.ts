// Flow 307 (W5-b), T6: the installer core — `installIntegration`/
// `uninstallIntegration`/`doctorIntegration`/`resolveSurfaceSelection` in
// `installer.ts`, plus the per-target install-state `install-state.ts`
// records. AC5/AC6.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { validateAgainstSchemaObject } from "../contracts/validator";
import { getHarnessAdapter, HARNESS_ADAPTERS } from "./registry";
import { checkOutputCommand } from "./surfaces";
import {
  doctorIntegration,
  installIntegration,
  resolveSurfaceSelection,
  uninstallIntegration,
} from "./installer";
import { installStatePath, readInstallState, recordSurfaceInstalled } from "./install-state";
import type { SettingsFileOwner } from "./types";

const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-agent-platform-expansion",
  "schemas",
  "install-manifest.schema.json",
);

let manifestDefs: Record<string, unknown> | undefined;

/** `{ $ref: "#/$defs/installState", $defs }`, so `validateAgainstSchemaObject` checks one $def without a schemaDir. */
async function installStateSchemaRef(): Promise<Record<string, unknown>> {
  if (!manifestDefs) {
    const doc = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as { $defs: Record<string, unknown> };
    manifestDefs = doc.$defs;
  }
  return { $ref: "#/$defs/installState", $defs: manifestDefs };
}

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-installer-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Every generic-sweep case installs zed too, whose `instructions` surface's
// `customInstall` reports a problem (never writes) when AGENTS.md lacks
// Keryx's block — so a temp root usable for every adapter carries a
// well-formed AGENTS.md from the start, exactly like `w5b-adapters.test.ts`'s
// own zed fixture.
async function withMetaproject<T>(run: (root: string) => Promise<T>): Promise<T> {
  return withTempDir(async (root) => {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, "AGENTS.md"),
      "# repo\n\n<!-- keryx:index -->\nstuff\n<!-- /keryx:index -->\n",
      "utf8",
    );
    return run(root);
  });
}

const ADAPTERS_WITH_SURFACES = HARNESS_ADAPTERS.filter((a) => a.surfaces.length > 0);

describe("installIntegration / doctorIntegration / uninstallIntegration: every registered runtime with surfaces", () => {
  for (const adapter of ADAPTERS_WITH_SURFACES) {
    test(`${adapter.id}: install writes files, doctor is ok, install-state validates, uninstall clears what it removed`, async () => {
      await withMetaproject(async (root) => {
        const installed = await installIntegration(root, adapter.id);
        expect(installed.errors, JSON.stringify(installed)).toEqual([]);

        const installedSurfaces = installed.results.filter((r) => r.status === "installed");
        for (const result of installedSurfaces) {
          if (result.file) {
            expect(
              existsSync(path.join(root, ...result.file.split("/"))),
              `${adapter.id}/${result.surfaceId} -> ${result.file}`,
            ).toBe(true);
          }
        }

        const doctorAfterInstall = await doctorIntegration(root, adapter.id);
        expect(doctorAfterInstall.ok, JSON.stringify(doctorAfterInstall)).toBe(true);

        const state = await readInstallState(root, adapter.id);
        if (installedSurfaces.length > 0) {
          expect(state, `${adapter.id}: expected install-state`).toBeDefined();
          expect(state!.installedModules.map((r) => r.moduleId).sort()).toEqual(
            installedSurfaces.map((r) => r.surfaceId).sort(),
          );
          const schema = await installStateSchemaRef();
          const validation = validateAgainstSchemaObject(schema, state);
          expect(validation.errors, JSON.stringify(validation.errors)).toEqual([]);
          expect(validation.valid).toBe(true);
        } else {
          expect(state).toBeUndefined();
        }

        const uninstalled = await uninstallIntegration(root, adapter.id);
        expect(uninstalled.errors, JSON.stringify(uninstalled)).toEqual([]);

        const stateAfterUninstall = await readInstallState(root, adapter.id);
        for (const result of installedSurfaces) {
          const uninstallResult = uninstalled.results.find((r) => r.surfaceId === result.surfaceId)!;
          const stillRecorded = stateAfterUninstall?.installedModules.some((r) => r.moduleId === result.surfaceId) ?? false;
          if (uninstallResult.status === "removed") {
            expect(stillRecorded, `${adapter.id}/${result.surfaceId}: should be cleared from install-state`).toBe(false);
          } else {
            // A surface whose uninstall legitimately did nothing (e.g. zed's
            // `instructions`, whose customUninstall never deletes AGENTS.md)
            // keeps its install-state record — it is still, truthfully, installed.
            expect(stillRecorded, `${adapter.id}/${result.surfaceId}: unexpectedly cleared from install-state`).toBe(true);
          }
        }
      });
    });
  }
});

describe("resolveSurfaceSelection", () => {
  test("claude: 'block' selects both ctx-guard and security-check-output; 'ctx-guard' selects just ctx-guard", () => {
    const claude = getHarnessAdapter("claude")!;
    const byFlag = resolveSurfaceSelection(claude, ["block"]);
    expect(byFlag.map((s) => s.id).sort()).toEqual(["ctx-guard", "security-check-output"]);
    const byId = resolveSurfaceSelection(claude, ["ctx-guard"]);
    expect(byId.map((s) => s.id)).toEqual(["ctx-guard"]);
  });

  test("empty selector list selects every non-opt-in surface (flow 310: an opt-in surface like `agents` is excluded by default)", () => {
    const claude = getHarnessAdapter("claude")!;
    const nonOptIn = claude.surfaces.filter((s) => !s.optIn).length;
    expect(resolveSurfaceSelection(claude, []).length).toBe(nonOptIn);
    expect(resolveSurfaceSelection(claude).length).toBe(nonOptIn);
    // Sanity: claude DOES carry an opt-in surface today (`agents`), so this
    // test would not have caught a regression if `optIn` had no effect.
    expect(nonOptIn).toBeLessThan(claude.surfaces.length);
  });

  test("an opt-in surface is still selected when named explicitly (by flag or id)", () => {
    const claude = getHarnessAdapter("claude")!;
    expect(resolveSurfaceSelection(claude, ["agents"]).map((s) => s.id)).toEqual(["agents"]);
  });

  test("unknown selector throws, naming it and the valid flags/ids for that runtime", () => {
    const claude = getHarnessAdapter("claude")!;
    expect(() => resolveSurfaceSelection(claude, ["bogus-selector"])).toThrow(/bogus-selector/);
    try {
      resolveSurfaceSelection(claude, ["bogus-selector"]);
      throw new Error("expected resolveSurfaceSelection to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("ctx-guard");
      expect(message).toContain("block");
    }
  });
});

// T17: `doctorIntegration --surface <bogus>` must error the same way
// install/uninstall do for an unknown selector, instead of silently ignoring
// it (a never-installed opt-in surface then simply never matched
// `explicitlySelected`, so doctor ran exactly as if `--surface` had been
// omitted — R2-F5's round-3 info note).
describe("doctorIntegration: unknown --surface selector", () => {
  test("an unknown selector throws, same message shape as resolveSurfaceSelection", () => {
    expect(doctorIntegration("/nonexistent", "claude", { surfaces: ["bogus-selector"] })).rejects.toThrow(/bogus-selector/);
  });

  test("a known selector (an opt-in surface never installed) does not throw", async () => {
    await withMetaproject(async (root) => {
      const result = await doctorIntegration(root, "claude", { surfaces: ["agents"] });
      expect(result.surfaces.some((s) => s.surfaceId === "agents")).toBe(true);
    });
  });
});

// review round 4, F1: multi-runtime `keryx integrations doctor --runtime
// all --surface agents` (or a comma list) previously threw for every
// runtime lacking an `agents` surface, because `doctorIntegration` always
// ran the STRICT `resolveSurfaceSelection`. `lenientSelectors` (threaded by
// the CLI exactly like `installIntegration`/`uninstallIntegration` already
// do) fixes that: mirrors install/uninstall's own lenient-selector tests.
describe("doctorIntegration: lenientSelectors (F1)", () => {
  // The CLI only ever sets `lenientSelectors: true` for a multi-runtime
  // (`all`/comma list) selection (see `commands/integrations.ts`); a single
  // explicit `--runtime` always calls with the default `lenientSelectors:
  // false`/omitted, which is what keeps throwing on a bogus selector — same
  // as `installIntegration`/`uninstallIntegration`, `doctorIntegration`
  // itself just does whatever `opts.lenientSelectors` says.
  test("the CLI's default (lenientSelectors omitted) still throws on a bogus selector", async () => {
    await expect(doctorIntegration("/nonexistent", "claude", { surfaces: ["bogus-selector"] })).rejects.toThrow(/bogus-selector/);
  });

  // review round 5, F1: a runtime lacking the selected surface must NOT be
  // skipped — `--surface` is additive for doctor, so a runtime that doesn't
  // declare `agents` is still doctored in full over its own default
  // surfaces. Only the informational `noMatchingSurface` marker is set.
  test("a runtime lacking the selected surface is still doctored in full, with noMatchingSurface only as a marker", async () => {
    await withMetaproject(async (root) => {
      // gemini-cli carries no `agents` surface (see registry.ts) — the
      // multi-runtime case (`--runtime all`/comma list) this fix targets.
      const gemini = getHarnessAdapter("gemini-cli")!;
      const nonOptIn = gemini.surfaces.filter((s) => !s.optIn).length;
      const withoutSelector = await doctorIntegration(root, "gemini-cli", {});
      const result = await doctorIntegration(root, "gemini-cli", { surfaces: ["agents"], lenientSelectors: true });
      expect(result.noMatchingSurface).toBe(true);
      // Same full doctor pass as if `--surface agents` had never been
      // passed: no surfaces silently dropped, no health checks skipped.
      expect(result.surfaces.length).toBe(nonOptIn);
      expect(result.surfaces.map((s) => s.surfaceId).sort()).toEqual(withoutSelector.surfaces.map((s) => s.surfaceId).sort());
      expect(result.problems).toEqual(withoutSelector.problems);
      expect(result.ok).toBe(withoutSelector.ok);
      expect(result.surfaces.some((s) => s.surfaceId === "agents")).toBe(false);
    });
  });

  test("a runtime that DOES carry the selected surface still doctors normally under lenientSelectors", async () => {
    await withMetaproject(async (root) => {
      const result = await doctorIntegration(root, "claude", { surfaces: ["agents"], lenientSelectors: true });
      expect(result.noMatchingSurface).toBeUndefined();
      expect(result.surfaces.some((s) => s.surfaceId === "agents")).toBe(true);
    });
  });

  // review round 5: renamed from "...still errors, even under
  // lenientSelectors" — `doctorIntegration` itself never errors here, it
  // only reports `noMatchingSurface: true`; the CLI aggregate
  // (`commands/integrations.ts`, `handleDoctor`) is what turns "every
  // selected runtime had no matching surface" into an exit-1 error. Kept
  // here to cover the flag doctorIntegration reports, with the name no
  // longer implying doctorIntegration itself throws or errors.
  test("selecting something no runtime declares at all reports noMatchingSurface (the CLI aggregate is what errors)", async () => {
    await withMetaproject(async (root) => {
      const result = await doctorIntegration(root, "gemini-cli", {
        surfaces: ["totally-bogus-selector-nothing-declares"],
        lenientSelectors: true,
      });
      expect(result.noMatchingSurface).toBe(true);
      // Still fully doctored, not skipped, even though nothing matched.
      expect(result.surfaces.length).toBeGreaterThan(0);
    });
  });
});

describe("installIntegration: targeted --surfaces selection installs only that content", () => {
  test("claude: surfaces:['ctx-guard'] writes the guard but not the security-check-output entry", async () => {
    await withMetaproject(async (root) => {
      const result = await installIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      expect(result.errors).toEqual([]);
      expect(result.results.map((r) => r.surfaceId)).toEqual(["ctx-guard"]);
      const settings = JSON.parse(await readFile(path.join(root, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
      const flat = JSON.stringify(settings);
      expect(flat).toContain("keryx ctx hook claude");
      expect(flat).not.toContain(checkOutputCommand("claude"));
    });
  });
});

describe("dry-run writes nothing", () => {
  test("installIntegration dryRun: no files, no install-state, status would-install", async () => {
    await withMetaproject(async (root) => {
      const result = await installIntegration(root, "gemini-cli", { dryRun: true });
      expect(result.errors).toEqual([]);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((r) => r.status === "would-install")).toBe(true);
      expect(existsSync(path.join(root, ".gemini", "settings.json"))).toBe(false);
      expect(existsSync(path.join(root, "GEMINI.md"))).toBe(false);
      expect(await readInstallState(root, "gemini-cli")).toBeUndefined();
    });
  });

  test("uninstallIntegration dryRun: nothing written or removed after a real install", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "gemini-cli");
      const settingsBefore = await readFile(path.join(root, ".gemini", "settings.json"), "utf8");
      const gemBefore = await readFile(path.join(root, "GEMINI.md"), "utf8");

      const result = await uninstallIntegration(root, "gemini-cli", { dryRun: true });
      expect(result.errors).toEqual([]);
      expect(result.results.every((r) => r.status === "would-remove")).toBe(true);

      expect(await readFile(path.join(root, ".gemini", "settings.json"), "utf8")).toBe(settingsBefore);
      expect(await readFile(path.join(root, "GEMINI.md"), "utf8")).toBe(gemBefore);
      expect(await readInstallState(root, "gemini-cli")).toBeDefined();
    });
  });
});

describe("no .metaproject: surfaces still install, but nothing is recorded", () => {
  test("gemini-cli: files are written; no install-state directory is created", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "AGENTS.md"), "# repo\n\n<!-- keryx:index -->\nstuff\n<!-- /keryx:index -->\n", "utf8");
      const result = await installIntegration(root, "gemini-cli");
      expect(result.errors).toEqual([]);
      expect(existsSync(path.join(root, ".gemini", "settings.json"))).toBe(true);
      expect(await readInstallState(root, "gemini-cli")).toBeUndefined();
      expect(existsSync(installStatePath(root, "gemini-cli"))).toBe(false);
      expect(existsSync(path.join(root, ".metaproject"))).toBe(false);
    });
  });
});

describe("doctor: drift reporting for a recorded surface that is now missing or invalid", () => {
  test("JSON surface: managed entry stripped out of an otherwise-present file -> invalid, drift, ok:false", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      const file = path.join(root, ".claude", "settings.json");
      await writeFile(file, `${JSON.stringify({}, null, 2)}\n`, "utf8");

      const doctor = await doctorIntegration(root, "claude");
      const ctxGuard = doctor.surfaces.find((s) => s.surfaceId === "ctx-guard")!;
      expect(ctxGuard.live).toBe("invalid");
      expect(ctxGuard.drift).toBeDefined();
      expect(ctxGuard.drift).toContain("ctx-guard");
      expect(doctor.ok).toBe(false);
    });
  });

  test("JSON surface: the settings file itself is deleted -> missing, drift, ok:false", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "kiro", { surfaces: ["ctx-guard"] });
      const file = path.join(root, ".kiro", "hooks", "keryx-ctx-guard.json");
      await rm(file, { force: true });

      const doctor = await doctorIntegration(root, "kiro");
      const ctxGuard = doctor.surfaces.find((s) => s.surfaceId === "ctx-guard")!;
      expect(ctxGuard.live).toBe("missing");
      expect(ctxGuard.drift).toContain("missing");
      expect(doctor.ok).toBe(false);
    });
  });

  // kiro's ctx-guard file (.kiro/hooks/keryx-ctx-guard.json) is owned by
  // exactly one surface — F5 keeps the sha256 "changed since install" note
  // for a single-surface file; see the F5 describe block below for the
  // shared-file counterpart (.claude/settings.json, ctx-guard + orient +
  // both security surfaces), where the same edit must NOT produce this note.
  test("recorded, valid, sha differs from install -> non-failing note, ok stays true (single-surface file)", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "kiro", { surfaces: ["ctx-guard"] });
      const file = path.join(root, ".kiro", "hooks", "keryx-ctx-guard.json");
      const settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      settings.unrelatedKey = "added-after-install";
      await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const doctor = await doctorIntegration(root, "kiro");
      const ctxGuard = doctor.surfaces.find((s) => s.surfaceId === "ctx-guard")!;
      expect(ctxGuard.live).toBe("valid");
      expect(ctxGuard.drift).toBe("file changed since install (still valid)");
      expect(doctor.ok).toBe(true);
    });
  });

  test("opencode: plugin file edited after install -> probe reports drift", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "opencode");
      const file = path.join(root, ".opencode", "plugin", "keryx-ctx-guard.js");
      await writeFile(file, "// tampered\n", "utf8");

      const doctor = await doctorIntegration(root, "opencode");
      const surface = doctor.surfaces.find((s) => s.surfaceId === "ctx-guard")!;
      expect(surface.live).toBe("invalid");
      expect(surface.drift).toBeDefined();
      expect(doctor.ok).toBe(false);
    });
  });

  test("unrecorded surface never fails ok, whatever its live status", async () => {
    await withMetaproject(async (root) => {
      // Nothing installed at all: every surface is live-checked but unrecorded.
      const doctor = await doctorIntegration(root, "claude");
      expect(doctor.surfaces.every((s) => s.recorded === undefined)).toBe(true);
      expect(doctor.ok).toBe(true);
    });
  });
});

describe("keryx-shell and unknown runtime ids", () => {
  // Flow 306 (W6, T20): keryx-shell's eight native surfaces are all
  // `policy-travels-with-agent`, satisfied entirely by the compiled-in hook
  // runtime (no `merge`/`strip`/`customInstall`) — same shape as zed's
  // `acp-permission` surface. Install/uninstall report `satisfied-by-runtime`
  // for every one of them, with no errors, and doctor reports healthy.
  test("keryx-shell (native surfaces, nothing installable): install/uninstall/doctor are all clean, satisfied-by-runtime", async () => {
    await withMetaproject(async (root) => {
      const install = await installIntegration(root, "keryx-shell");
      expect(install.errors).toEqual([]);
      expect(install.results.length).toBeGreaterThan(0);
      expect(install.results.every((r) => r.status === "satisfied-by-runtime")).toBe(true);

      const uninstall = await uninstallIntegration(root, "keryx-shell");
      expect(uninstall.errors).toEqual([]);
      expect(uninstall.results.every((r) => r.status === "satisfied-by-runtime")).toBe(true);

      const doctor = await doctorIntegration(root, "keryx-shell");
      expect(doctor.ok).toBe(true);
      expect(doctor.problems).toEqual([]);
    });
  });

  test("unknown runtime id: install/uninstall report it and list valid runtimes; doctor throws", async () => {
    await withMetaproject(async (root) => {
      const install = await installIntegration(root, "not-a-real-runtime");
      expect(install.errors[0]).toContain("not-a-real-runtime");
      expect(install.errors[0]).toContain("claude");

      const uninstall = await uninstallIntegration(root, "not-a-real-runtime");
      expect(uninstall.errors[0]).toContain("not-a-real-runtime");

      await expect(doctorIntegration(root, "not-a-real-runtime")).rejects.toThrow(/not-a-real-runtime/);
    });
  });
});

describe("experimental warning", () => {
  test("gemini-cli: every installed surface carries the experimental warning + its riskNotes", async () => {
    await withMetaproject(async (root) => {
      const result = await installIntegration(root, "gemini-cli");
      expect(result.results.length).toBeGreaterThan(0);
      for (const surfaceResult of result.results) {
        expect(surfaceResult.warnings).toContain("experimental — verify on a live install");
        expect(surfaceResult.warnings.length).toBeGreaterThan(1);
      }
    });
  });
});

describe("zed: block (acp-permission) is satisfied-by-runtime, never a file", () => {
  test("install and uninstall both report satisfied-by-runtime; nothing is ever recorded", async () => {
    await withMetaproject(async (root) => {
      const install = await installIntegration(root, "zed", { surfaces: ["block"] });
      expect(install.errors).toEqual([]);
      expect(install.results).toHaveLength(1);
      expect(install.results[0]!.status).toBe("satisfied-by-runtime");
      expect(install.results[0]!.file).toBeUndefined();
      expect(await readInstallState(root, "zed")).toBeUndefined();

      const uninstall = await uninstallIntegration(root, "zed", { surfaces: ["block"] });
      expect(uninstall.errors).toEqual([]);
      expect(uninstall.results[0]!.status).toBe("satisfied-by-runtime");
      expect(await readInstallState(root, "zed")).toBeUndefined();
    });
  });
});

describe("zed: instructions is probe-only (F2) — no AGENTS.md at all", () => {
  test("install without AGENTS.md succeeds: satisfied-by-runtime with the probe problem as a warning, never recorded", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      const install = await installIntegration(root, "zed", { surfaces: ["instructions"] });
      expect(install.errors).toEqual([]);
      expect(install.results).toHaveLength(1);
      expect(install.results[0]!.status).toBe("satisfied-by-runtime");
      expect(install.results[0]!.warnings.some((w) => w.includes("AGENTS.md"))).toBe(true);
      expect(await readInstallState(root, "zed")).toBeUndefined();
    });
  });

  test("uninstall without AGENTS.md succeeds as satisfied-by-runtime and clears a stale pre-fix install-state record", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      // Simulate a record written by the pre-fix behaviour, when zed's
      // `instructions` surface still had a `customInstall`.
      await recordSurfaceInstalled(root, "zed", {
        moduleId: "instructions",
        surface: "instructions",
        writtenPaths: ["AGENTS.md"],
        managedSentinel: true,
      });
      expect(await readInstallState(root, "zed")).toBeDefined();

      const uninstall = await uninstallIntegration(root, "zed", { surfaces: ["instructions"] });
      expect(uninstall.errors).toEqual([]);
      expect(uninstall.results[0]!.status).toBe("satisfied-by-runtime");
      expect(await readInstallState(root, "zed")).toBeUndefined();
    });
  });

  test("doctor without AGENTS.md reports the surface invalid via the probe, without throwing", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      const doctor = await doctorIntegration(root, "zed");
      const instructions = doctor.surfaces.find((s) => s.surfaceId === "instructions")!;
      expect(instructions.live).toBe("invalid");
      expect(instructions.problems.some((p) => p.includes("AGENTS.md"))).toBe(true);
    });
  });

  test("install --runtime <every adapter with surfaces> succeeds without AGENTS.md (zed no longer requires it)", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      for (const adapter of ADAPTERS_WITH_SURFACES) {
        const result = await installIntegration(root, adapter.id);
        expect(result.errors, `${adapter.id}: ${JSON.stringify(result)}`).toEqual([]);
      }
    });
  });
});

describe("F4: custom (markdown-block) uninstall dry-run agrees with the real run", () => {
  test("gemini-cli: GEMINI.md present without the managed block -> dry-run says nothing-to-remove, matching the real uninstall", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "gemini-cli", { surfaces: ["instructions"] });
      // Hand-edit the file to drop the managed block but keep the file itself.
      await writeFile(path.join(root, "GEMINI.md"), "# unrelated content, no keryx block\n", "utf8");

      const dryRun = await uninstallIntegration(root, "gemini-cli", { surfaces: ["instructions"], dryRun: true });
      expect(dryRun.errors).toEqual([]);
      expect(dryRun.results[0]!.status).toBe("nothing-to-remove");

      const real = await uninstallIntegration(root, "gemini-cli", { surfaces: ["instructions"] });
      expect(real.errors).toEqual([]);
      expect(real.results[0]!.status).toBe("nothing-to-remove");
      // The hand-edited content must survive untouched.
      expect(await readFile(path.join(root, "GEMINI.md"), "utf8")).toBe("# unrelated content, no keryx block\n");
    });
  });

  test("gemini-cli: GEMINI.md present WITH the managed block -> dry-run says would-remove, matching the real uninstall", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "gemini-cli", { surfaces: ["instructions"] });

      const dryRun = await uninstallIntegration(root, "gemini-cli", { surfaces: ["instructions"], dryRun: true });
      expect(dryRun.results[0]!.status).toBe("would-remove");

      const real = await uninstallIntegration(root, "gemini-cli", { surfaces: ["instructions"] });
      expect(real.results[0]!.status).toBe("removed");
    });
  });
});

describe("F5: a JSON surface sharing its settings file with another surface carries no sha256 drift note", () => {
  test("claude: installing orient after ctx-guard on the same file produces no drift note for ctx-guard", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      const state = await readInstallState(root, "claude");
      const ctxGuardRecord = state!.installedModules.find((r) => r.moduleId === "ctx-guard")!;
      expect(Object.keys(ctxGuardRecord.sha256)).toEqual([]);

      // Installing a sibling surface on the same file changes its bytes —
      // this must not retroactively read as ctx-guard's own drift.
      await installIntegration(root, "claude", { surfaces: ["orient"] });

      const doctor = await doctorIntegration(root, "claude");
      const ctxGuard = doctor.surfaces.find((s) => s.surfaceId === "ctx-guard")!;
      expect(ctxGuard.live).toBe("valid");
      expect(ctxGuard.drift).toBeUndefined();
    });
  });

  test("opencode: a single-surface plugin file still gets its sha256 recorded and still flags drift", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "opencode");
      const state = await readInstallState(root, "opencode");
      const record = state!.installedModules.find((r) => r.moduleId === "ctx-guard")!;
      expect(Object.keys(record.sha256).length).toBeGreaterThan(0);
    });
  });
});

describe("F7: a malformed install-state file never crashes doctor/install/uninstall", () => {
  async function writeMalformedState(root: string, runtimeId: string, content: string): Promise<void> {
    const file = installStatePath(root, runtimeId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }

  test("invalid JSON: readInstallState returns undefined, doctor reports a problem instead of throwing", async () => {
    await withMetaproject(async (root) => {
      await writeMalformedState(root, "claude", "{ not json");
      expect(await readInstallState(root, "claude")).toBeUndefined();

      const doctor = await doctorIntegration(root, "claude");
      expect(doctor.problems.some((p) => p.includes("install-state unreadable"))).toBe(true);
      expect(doctor.ok).toBe(false);
    });
  });

  test("valid JSON but wrong shape (missing schemaVersion/installedModules): same treatment", async () => {
    await withMetaproject(async (root) => {
      await writeMalformedState(root, "claude", JSON.stringify({ foo: "bar" }));
      expect(await readInstallState(root, "claude")).toBeUndefined();

      const doctor = await doctorIntegration(root, "claude");
      expect(doctor.problems.some((p) => p.includes("install-state unreadable"))).toBe(true);
      expect(doctor.ok).toBe(false);
    });
  });

  test("a valid well-formed state file never reports the unreadable problem", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      const doctor = await doctorIntegration(root, "claude");
      expect(doctor.problems).toEqual([]);
    });
  });

  test("install/uninstall never throw when install-state is malformed", async () => {
    await withMetaproject(async (root) => {
      await writeMalformedState(root, "claude", "{ not json");
      const install = await installIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      expect(install.errors).toEqual([]);
      const uninstall = await uninstallIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      expect(uninstall.errors).toEqual([]);
    });
  });
});

describe("F10: a shared-file group failure is reported once, not duplicated/re-prefixed per surface", () => {
  test("a two-surface JSON group whose owner refuses to write reports the owner's error exactly once, verbatim", async () => {
    await withMetaproject(async (root) => {
      const claude = getHarnessAdapter("claude")!;
      const ONE_MESSAGE =
        "security-check-output: this operation left a previously-valid surface invalid on .claude/settings.json — refusing to write";
      const fakeOwner: SettingsFileOwner = {
        relativePath: ".claude/settings.json",
        surfaces: () =>
          claude.surfaces.filter((s) => s.id === "security-check-input" || s.id === "security-check-output"),
        apply: () => ({ settings: {}, errors: [ONE_MESSAGE] }),
      };

      const result = await installIntegration(root, "claude", {
        surfaces: ["security-check-input", "security-check-output"],
        ownerOverride: fakeOwner,
      });

      // Exactly one copy of the message — not one per surface in the group,
      // and not re-prefixed with a surface id on top of its own wording.
      expect(result.errors).toEqual([ONE_MESSAGE]);
      expect(result.results.every((r) => r.status === "failed")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Review round 2 fixes
// ---------------------------------------------------------------------------

describe("F4/N1 (round 2): a malformed (unterminated) markdown block — dry-run and the real run agree, and a throw never escapes", () => {
  async function writeUnterminated(root: string, relativePath: string): Promise<void> {
    const file = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# Notes\n\n<!-- keryx:instructions -->\nno end marker here\n", "utf8");
  }

  test("uninstall dry-run reports failed for an unterminated block, matching the real uninstall", async () => {
    await withMetaproject(async (root) => {
      await writeUnterminated(root, "GEMINI.md");

      const dryRun = await uninstallIntegration(root, "gemini-cli", { surfaces: ["instructions"], dryRun: true });
      expect(dryRun.results[0]!.status).toBe("failed");
      expect(dryRun.results[0]!.errors[0]).toContain("unterminated");

      // The real run must reach the SAME outcome (failed), not throw and
      // abort uninstallIntegration entirely (N1).
      const real = await uninstallIntegration(root, "gemini-cli", { surfaces: ["instructions"] });
      expect(real.results[0]!.status).toBe("failed");
      expect(real.results[0]!.errors[0]).toContain("unterminated");
      // Untouched — refusing must never delete/rewrite the file.
      expect(await readFile(path.join(root, "GEMINI.md"), "utf8")).toContain("no end marker here");
    });
  });

  test("install dry-run reports failed for an unterminated block, matching the real install", async () => {
    await withMetaproject(async (root) => {
      await writeUnterminated(root, "GEMINI.md");

      const dryRun = await installIntegration(root, "gemini-cli", { surfaces: ["instructions"], dryRun: true });
      expect(dryRun.results[0]!.status).toBe("failed");

      const real = await installIntegration(root, "gemini-cli", { surfaces: ["instructions"] });
      expect(real.results[0]!.status).toBe("failed");
    });
  });

  // R3-F12 (supersedes the earlier N1 decision this test used to pin): a
  // JSON surface in the SAME install call must NOT be written when a custom
  // surface in the same call is going to refuse — writing `.gemini/settings.json`
  // (plus its install-state record) and THEN failing on `instructions` left the
  // runtime half-installed with no way to tell from the exit code alone.
  // Every selected surface is checked before the first write now, so a
  // failing surface anywhere in the call means NOTHING in the call is
  // written. This test fails on the pre-fix (N1) behavior, which wrote
  // `.gemini/settings.json` regardless.
  test("a failing custom surface in the call stops a JSON surface in the SAME call from being written (all-or-nothing)", async () => {
    await withMetaproject(async (root) => {
      await writeUnterminated(root, "GEMINI.md");
      const result = await installIntegration(root, "gemini-cli");
      const ctxGuard = result.results.find((r) => r.surfaceId === "ctx-guard");
      const instructions = result.results.find((r) => r.surfaceId === "instructions");
      expect(ctxGuard?.status).toBe("failed");
      expect(instructions?.status).toBe("failed");
      expect(existsSync(path.join(root, ".gemini", "settings.json"))).toBe(false);
    });
  });
});

describe("N2 (round 2): uninstall presence is judged PER SURFACE, not by a sentinel shared with a sibling surface", () => {
  test("claude: installing only security-check-output, then uninstalling security-check-input, reports nothing-to-remove", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["security-check-output"] });

      const uninstall = await uninstallIntegration(root, "claude", { surfaces: ["security-check-input"] });
      expect(uninstall.results[0]!.status).toBe("nothing-to-remove");

      // security-check-output must be untouched by that uninstall.
      const doctor = await doctorIntegration(root, "claude");
      const output = doctor.surfaces.find((s) => s.surfaceId === "security-check-output")!;
      expect(output.live).toBe("valid");
    });
  });

  test("claude: installing only security-check-output, dry-run uninstalling security-check-input also reports nothing-to-remove", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["security-check-output"] });
      const dryRun = await uninstallIntegration(root, "claude", { surfaces: ["security-check-input"], dryRun: true });
      expect(dryRun.results[0]!.status).toBe("nothing-to-remove");
    });
  });

  test("claude: uninstalling the surface that WAS installed still reports removed", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["security-check-output"] });
      const uninstall = await uninstallIntegration(root, "claude", { surfaces: ["security-check-output"] });
      expect(uninstall.results[0]!.status).toBe("removed");
    });
  });
});

describe("M2 (round 3): presence is judged by validate/sentinel-group, never by strip's own empty-container cleanup", () => {
  test("claude: an UNRELATED empty hooks.PreToolUse array (never touched by ctx-guard) reports nothing-to-remove, not removed", async () => {
    await withMetaproject(async (root) => {
      const file = path.join(root, ".claude", "settings.json");
      await mkdir(path.dirname(file), { recursive: true });
      // The round-3 repro: `strip`'s own empty-container cleanup used to make
      // the OLD strip-diff presence check ("did strip change anything?")
      // report "installed" here, even though ctx-guard was never installed —
      // `stripFromHookArray` deletes an empty `hooks` object regardless of
      // who emptied it.
      await writeFile(file, `${JSON.stringify({ hooks: { PreToolUse: [] }, x: 1 }, null, 2)}\n`, "utf8");

      const uninstall = await uninstallIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      expect(uninstall.results[0]!.status).toBe("nothing-to-remove");

      // The unrelated key survives — `strip`'s own empty-container cleanup
      // (a harmless normalisation `uninstallSurfaces` always applies) is not
      // what the STATUS is judged on any more.
      const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      expect(after.x).toBe(1);
    });
  });

  test("claude: a genuinely installed ctx-guard, even with a STALE matcher, still reports removed", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      const file = path.join(root, ".claude", "settings.json");
      const settings = JSON.parse(await readFile(file, "utf8")) as {
        hooks: { PreToolUse: Array<Record<string, unknown>> };
      };
      // Corrupt the matcher by hand so `validate` fails (stale) while the
      // sentinel-tagged group is still there — presence must still be judged
      // "installed" via the group fallback, not only via `validate`.
      settings.hooks.PreToolUse[0]!.matcher = "SomethingElse";
      await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const uninstall = await uninstallIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      expect(uninstall.results[0]!.status).toBe("removed");
    });
  });
});

describe("F7 (round 2): a malformed RECORD inside installedModules invalidates the whole state, never crashes", () => {
  async function writeState(root: string, runtimeId: string, installedModules: unknown): Promise<void> {
    const file = installStatePath(root, runtimeId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: "1.0.0", target: runtimeId, installedModules, recordedAt: new Date().toISOString() }),
      "utf8",
    );
  }

  test("installedModules: [null] — readInstallState returns undefined, doctor reports a problem instead of crashing", async () => {
    await withMetaproject(async (root) => {
      await writeState(root, "claude", [null]);
      expect(await readInstallState(root, "claude")).toBeUndefined();

      const doctor = await doctorIntegration(root, "claude");
      expect(doctor.problems.some((p) => p.includes("install-state unreadable"))).toBe(true);
      expect(doctor.ok).toBe(false);
    });
  });

  test("installedModules with a record missing moduleId — same treatment, install repairs the file", async () => {
    await withMetaproject(async (root) => {
      await writeState(root, "claude", [{ writtenPaths: [], sha256: {}, managedSentinel: true }]);
      expect(await readInstallState(root, "claude")).toBeUndefined();

      const install = await installIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      expect(install.errors).toEqual([]);

      // Repaired: the state file is now valid and carries only the fresh record.
      const state = await readInstallState(root, "claude");
      expect(state).toBeDefined();
      expect(state!.installedModules.map((r) => r.moduleId)).toEqual(["ctx-guard"]);
    });
  });

  test("a record missing sha256 defaults to {} rather than crashing shaDriftedSinceInstall (via doctor)", async () => {
    await withMetaproject(async (root) => {
      await writeState(root, "claude", [
        { moduleId: "ctx-guard", writtenPaths: [".claude/settings.json"], managedSentinel: true },
      ]);
      expect(await readInstallState(root, "claude")).toBeDefined();
      // Must not throw.
      const doctor = await doctorIntegration(root, "claude");
      expect(doctor.problems).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// R1-F2/F8 (review round 1, flow 310 W2): the `agents` surface is
// directory-backed (`.claude/agents`), unlike every other surface's single
// settings file — `recordSurfaceInstalled` hashing that directory used to
// throw EISDIR in any project WITH a `.metaproject/` (the only case the
// pre-fix test suite never exercised), after the agent files were already
// written to disk. F8: the surface is also opt-in, so the default,
// no-selector `doctor` must not report it "invalid" merely because nobody
// has opted in yet, and a dry-run uninstall must judge presence off actual
// managed files, not bare directory existence.
// ---------------------------------------------------------------------------

describe("R1-F2/F8: the agents surface (directory-backed, opt-in)", () => {
  test("install --surface agents in a project WITH .metaproject/ succeeds, records state, and doctor/uninstall round-trip cleanly", async () => {
    await withMetaproject(async (root) => {
      const installed = await installIntegration(root, "claude", { surfaces: ["agents"] });
      expect(installed.errors, JSON.stringify(installed)).toEqual([]);
      expect(installed.results.some((r) => r.surfaceId === "agents" && r.status === "installed")).toBe(true);
      expect(existsSync(path.join(root, ".claude", "agents"))).toBe(true);
      const writtenFiles = await readdir(path.join(root, ".claude", "agents"));
      expect(writtenFiles.length).toBeGreaterThan(0);

      // R1-F2: this used to throw EISDIR here — the install-state write is
      // the very thing that crashed, and nothing was recorded on failure.
      const state = await readInstallState(root, "claude");
      expect(state?.installedModules.some((r) => r.moduleId === "agents")).toBe(true);

      const doctor = await doctorIntegration(root, "claude", { surfaces: ["agents"] });
      expect(doctor.ok, JSON.stringify(doctor)).toBe(true);
      const agentsDoctor = doctor.surfaces.find((s) => s.surfaceId === "agents");
      expect(agentsDoctor?.live).toBe("valid");

      const uninstalled = await uninstallIntegration(root, "claude", { surfaces: ["agents"] });
      expect(uninstalled.errors, JSON.stringify(uninstalled)).toEqual([]);
      expect(uninstalled.results.some((r) => r.surfaceId === "agents" && r.status === "removed")).toBe(true);
    });
  });

  test("R1-F8: doctor with NO selector does not report a never-installed agents surface as invalid", async () => {
    await withMetaproject(async (root) => {
      const doctor = await doctorIntegration(root, "claude");
      expect(doctor.ok, JSON.stringify(doctor)).toBe(true);
      expect(doctor.surfaces.some((s) => s.surfaceId === "agents")).toBe(false);
    });
  });

  test("R1-F8: doctor still reports an INSTALLED agents surface even with no selector (drift stays visible once opted in)", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["agents"] });
      const doctor = await doctorIntegration(root, "claude");
      expect(doctor.surfaces.some((s) => s.surfaceId === "agents")).toBe(true);
    });
  });

  test("R1-F8: a dry-run uninstall reports nothing-to-remove for a directory holding only unmanaged files", async () => {
    await withMetaproject(async (root) => {
      await mkdir(path.join(root, ".claude", "agents"), { recursive: true });
      await writeFile(path.join(root, ".claude", "agents", "hand-authored.md"), "# not keryx's\n", "utf8");

      const dryRun = await uninstallIntegration(root, "claude", { surfaces: ["agents"], dryRun: true });
      const agentsResult = dryRun.results.find((r) => r.surfaceId === "agents");
      expect(agentsResult?.status).toBe("nothing-to-remove");
    });
  });

  test("R1-F8: a dry-run uninstall reports would-remove once at least one managed file exists", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["agents"] });
      const dryRun = await uninstallIntegration(root, "claude", { surfaces: ["agents"], dryRun: true });
      const agentsResult = dryRun.results.find((r) => r.surfaceId === "agents");
      expect(agentsResult?.status).toBe("would-remove");
    });
  });

  // T17 (design pt. 3): a managed file hand-edited since export is kept, not
  // deleted, even with no `--force` equivalent for uninstall at all — and the
  // keep is reported as a warning alongside the uninstall's own status line.
  test("T17: uninstall keeps a hand-edited managed agent export, reports it as a warning, and still removes every unedited one", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["agents"] });
      const agentsDir = path.join(root, ".claude", "agents");
      const files = await readdir(agentsDir);
      expect(files.length).toBeGreaterThan(1); // sanity: more than one bundled agent, so "removed the rest" is a real assertion
      const [editedFile, ...untouchedFiles] = files;
      const editedPath = path.join(agentsDir, editedFile!);
      const original = await readFile(editedPath, "utf8");
      await writeFile(editedPath, `${original}\nhand-added line, sentinel left untouched\n`, "utf8");

      const uninstalled = await uninstallIntegration(root, "claude", { surfaces: ["agents"] });
      expect(uninstalled.errors, JSON.stringify(uninstalled)).toEqual([]);
      const agentsResult = uninstalled.results.find((r) => r.surfaceId === "agents");
      // Something else was still removed, so the surface-level status is
      // "removed", not "nothing-to-remove" — the hand-edited file's kept-ness
      // shows up in `warnings`, not by flipping this to failure/no-op.
      expect(agentsResult?.status).toBe("removed");
      expect(agentsResult?.warnings.some((w) => w.includes(editedFile!) && w.includes("hand-edited"))).toBe(true);

      // The hand-edited file is untouched on disk...
      expect(existsSync(editedPath)).toBe(true);
      expect(await readFile(editedPath, "utf8")).toContain("hand-added line");
      // ...and every OTHER managed file was actually removed.
      for (const untouched of untouchedFiles) {
        expect(existsSync(path.join(agentsDir, untouched))).toBe(false);
      }
    });
  });

  // review round 4, F2: `hasManagedAgentExports` (which `inspectAgentsExports`
  // wires into `customUninstallDryRun`) used to count a hand-edited managed
  // file as "something to remove", so a directory holding ONLY hand-edited
  // exports reported `would-remove` on dry-run while the real uninstall then
  // kept every one of them (nothing actually removed) — dry-run and the real
  // run disagreed. Fixed to count only VERIFIED files, matching exactly what
  // `removeManagedAgentExportsDetailed` deletes.
  test("F2: a directory with only hand-edited managed exports — dry-run says nothing-to-remove, matching the real run which removes nothing", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["agents"] });
      const agentsDir = path.join(root, ".claude", "agents");
      const files = await readdir(agentsDir);
      expect(files.length).toBeGreaterThan(0); // sanity
      for (const file of files) {
        const filePath = path.join(agentsDir, file);
        const original = await readFile(filePath, "utf8");
        await writeFile(filePath, `${original}\nhand-added line, sentinel left untouched\n`, "utf8");
      }

      const dryRun = await uninstallIntegration(root, "claude", { surfaces: ["agents"], dryRun: true });
      const dryRunResult = dryRun.results.find((r) => r.surfaceId === "agents");
      expect(dryRunResult?.status).toBe("nothing-to-remove");

      const real = await uninstallIntegration(root, "claude", { surfaces: ["agents"] });
      const realResult = real.results.find((r) => r.surfaceId === "agents");
      // Dry-run and the real run agree: nothing removed, every file kept.
      expect(realResult?.status).toBe("nothing-to-remove");
      for (const file of files) {
        expect(existsSync(path.join(agentsDir, file))).toBe(true);
      }
    });
  });

  test("F2: a mixed directory (verified + hand-edited) — dry-run says would-remove, and the real run removes only the verified file", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["agents"] });
      const agentsDir = path.join(root, ".claude", "agents");
      const files = await readdir(agentsDir);
      expect(files.length).toBeGreaterThan(1); // sanity: need at least one verified + one hand-edited
      const [editedFile, ...verifiedFiles] = files;
      const editedPath = path.join(agentsDir, editedFile!);
      const original = await readFile(editedPath, "utf8");
      await writeFile(editedPath, `${original}\nhand-added line, sentinel left untouched\n`, "utf8");

      const dryRun = await uninstallIntegration(root, "claude", { surfaces: ["agents"], dryRun: true });
      const dryRunResult = dryRun.results.find((r) => r.surfaceId === "agents");
      expect(dryRunResult?.status).toBe("would-remove");

      const real = await uninstallIntegration(root, "claude", { surfaces: ["agents"] });
      const realResult = real.results.find((r) => r.surfaceId === "agents");
      expect(realResult?.status).toBe("removed");
      expect(existsSync(editedPath)).toBe(true); // hand-edited file kept
      for (const verified of verifiedFiles) {
        expect(existsSync(path.join(agentsDir, verified))).toBe(false); // verified files removed
      }
    });
  });
});
