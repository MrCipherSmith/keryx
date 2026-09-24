// Flow 307 (W5-b), T6: the installer core — `installIntegration`/
// `uninstallIntegration`/`doctorIntegration`/`resolveSurfaceSelection` in
// `installer.ts`, plus the per-target install-state `install-state.ts`
// records. AC5/AC6.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { installStatePath, readInstallState } from "./install-state";

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

  test("empty selector list selects every surface", () => {
    const claude = getHarnessAdapter("claude")!;
    expect(resolveSurfaceSelection(claude, []).length).toBe(claude.surfaces.length);
    expect(resolveSurfaceSelection(claude).length).toBe(claude.surfaces.length);
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

  test("recorded, valid, sha differs from install -> non-failing note, ok stays true", async () => {
    await withMetaproject(async (root) => {
      await installIntegration(root, "claude", { surfaces: ["ctx-guard"] });
      const file = path.join(root, ".claude", "settings.json");
      const settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      settings.unrelatedKey = "added-after-install";
      await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const doctor = await doctorIntegration(root, "claude");
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
  test("keryx-shell (no surfaces): install/uninstall error quoting its unsupported reasons; doctor throws", async () => {
    await withMetaproject(async (root) => {
      const install = await installIntegration(root, "keryx-shell");
      expect(install.errors.length).toBeGreaterThan(0);
      expect(install.errors[0]).toContain("keryx-shell");

      const uninstall = await uninstallIntegration(root, "keryx-shell");
      expect(uninstall.errors.length).toBeGreaterThan(0);
      expect(uninstall.errors[0]).toContain("keryx-shell");

      await expect(doctorIntegration(root, "keryx-shell")).rejects.toThrow(/keryx-shell/);
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
