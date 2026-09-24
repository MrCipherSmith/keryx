// Flow 307 (W5-b), T8: `keryx integrations install|uninstall|doctor|matrix` —
// the CLI surface over the installer core and the generated capability
// matrix. Hermetic temp dirs throughout; no test touches the real repo.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { integrationsCommand } from "./integrations";
import { ctxCommand } from "./ctx";
import { validateCapabilityMatrix, type CapabilityMatrixDocument } from "../integrations/matrix";
import { HARNESS_ADAPTERS } from "../integrations/service";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-integrations-cmd-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

let captured: string[] = [];
let capturedErr: string[] = [];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let prevExitCode: typeof process.exitCode;

beforeAll(() => {
  prevExitCode = process.exitCode;
});

afterAll(() => {
  // `process.exitCode = undefined` does NOT clear a previously-set exit code
  // in Bun (unlike Node) — it leaves the last non-zero value in place, which
  // then becomes the whole test run's real process exit code even though
  // every assertion passed. `?? 0` is what actually restores "no error".
  process.exitCode = prevExitCode ?? 0;
});

beforeEach(() => {
  captured = [];
  capturedErr = [];
  originalLog = console.log;
  originalErr = console.error;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => capturedErr.push(parts.map(String).join(" "));
  process.exitCode = 0;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
});

describe("keryx integrations install/doctor/uninstall — claude and gemini-cli", () => {
  for (const runtimeId of ["claude", "gemini-cli"]) {
    test(`${runtimeId}: install writes files, doctor is ok, uninstall removes them`, async () => {
      await withMetaproject(async (root) => {
        await integrationsCommand(["install", "--runtime", runtimeId], root);
        expect(process.exitCode).toBe(0);
        expect(capturedErr).toEqual([]);

        captured = [];
        await integrationsCommand(["doctor", "--runtime", runtimeId], root);
        expect(process.exitCode).toBe(0);
        expect(captured.join("\n")).toContain("ok");

        captured = [];
        await integrationsCommand(["uninstall", "--runtime", runtimeId], root);
        expect(process.exitCode).toBe(0);
        expect(capturedErr).toEqual([]);
      });
    });
  }
});

describe("--surface ctx-guard installs only the ctx guard", () => {
  test("claude: .claude/settings.json carries the ctx-guard hook but not the security check-output one", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "claude", "--surface", "ctx-guard"], root);
      expect(process.exitCode).toBe(0);

      const settings = JSON.parse(await readFile(path.join(root, ".claude", "settings.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const flat = JSON.stringify(settings);
      expect(flat).toContain("keryx ctx hook claude");
      expect(flat).not.toContain("keryx security check-output");
    });
  });
});

describe("--json output", () => {
  test("install --json parses and carries the runtimeId + results", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "gemini-cli", "--json"], root);
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string; results: unknown[]; errors: string[] }[];
        unsupported: unknown[];
      };
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0]!.runtimeId).toBe("gemini-cli");
      expect(parsed.results[0]!.errors).toEqual([]);
      expect(parsed.results[0]!.results.length).toBeGreaterThan(0);
    });
  });
});

describe("doctor exit code", () => {
  test("exits 1 after the managed entry is removed from the settings file", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "claude", "--surface", "ctx-guard"], root);
      const file = path.join(root, ".claude", "settings.json");
      await writeFile(file, `${JSON.stringify({}, null, 2)}\n`, "utf8");

      captured = [];
      await integrationsCommand(["doctor", "--runtime", "claude"], root);
      expect(process.exitCode).toBe(1);
    });
  });
});

describe("M3 (round 3): doctor --runtime all survives one runtime's corrupt settings file", () => {
  test("a corrupt kiro settings file does not abort doctor for every OTHER runtime, and exits 1", async () => {
    await withMetaproject(async (root) => {
      // kiro's ctx-guard surface reads .kiro/hooks/keryx-ctx-guard.json —
      // install it first so doctor has a RECORDED install-state entry for
      // it (a live problem on a never-installed surface does not fail
      // `doctor` on its own), then corrupt the file so `readSettingsFile`
      // throws when doctor reaches kiro. Before the fix, that throw escaped
      // `doctorIntegration` uncaught and aborted the whole `--runtime all`
      // loop in `handleDoctor`, so no runtime AFTER kiro in iteration order
      // printed anything.
      await integrationsCommand(["install", "--runtime", "kiro", "--surface", "ctx-guard"], root);
      await writeFile(path.join(root, ".kiro", "hooks", "keryx-ctx-guard.json"), "{ not valid json", "utf8");

      captured = [];
      await integrationsCommand(["doctor", "--runtime", "all", "--json"], root);
      expect(process.exitCode).toBe(1);

      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string; ok: boolean; surfaces: { surfaceId: string; live: string; problems: string[] }[] }[];
      };
      const withSurfaces = HARNESS_ADAPTERS.filter((a) => a.surfaces.length > 0);
      // Every supported runtime is still printed — kiro's corrupt file did
      // not stop the loop from reaching the rest.
      expect(parsed.results.map((r) => r.runtimeId).sort()).toEqual(withSurfaces.map((a) => a.id).sort());

      const kiro = parsed.results.find((r) => r.runtimeId === "kiro")!;
      expect(kiro.ok).toBe(false);
      const ctxGuard = kiro.surfaces.find((s) => s.surfaceId === "ctx-guard")!;
      expect(ctxGuard.live).toBe("invalid");
      expect(ctxGuard.problems.join(" ")).toContain("not valid JSON");
    });
  });
});

describe("--runtime all", () => {
  test("install includes every adapter with surfaces and reports keryx-shell unsupported", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "all", "--json"], root);
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string }[];
        unsupported: { runtimeId: string; unsupported: true; reasons: string[] }[];
      };
      const withSurfaces = HARNESS_ADAPTERS.filter((a) => a.surfaces.length > 0);
      expect(parsed.results.map((r) => r.runtimeId).sort()).toEqual(withSurfaces.map((a) => a.id).sort());
      expect(parsed.unsupported.map((u) => u.runtimeId)).toEqual(["keryx-shell"]);
      expect(parsed.unsupported[0]!.reasons.length).toBeGreaterThan(0);
    });
  });
});

describe("F3: --runtime all + --surface skips runtimes that declare no matching surface", () => {
  test("install --runtime all --surface instructions succeeds; matched runtimes install, unmatched ones are skipped", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "all", "--surface", "instructions", "--json"], root);
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string; results: unknown[]; errors: string[]; noMatchingSurface?: boolean }[];
      };
      const matched = parsed.results.filter((r) => !r.noMatchingSurface);
      const skipped = parsed.results.filter((r) => r.noMatchingSurface);
      expect(matched.length).toBeGreaterThan(0);
      expect(skipped.length).toBeGreaterThan(0);
      for (const r of matched) {
        expect(r.errors).toEqual([]);
        expect(r.results.length).toBeGreaterThan(0);
      }
      for (const r of skipped) {
        expect(r.results).toEqual([]);
        expect(r.errors).toEqual([]);
      }
    });
  });

  test("uninstall --runtime all --surface instructions succeeds the same way", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "all", "--surface", "instructions"], root);
      captured = [];
      await integrationsCommand(["uninstall", "--runtime", "all", "--surface", "instructions", "--json"], root);
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string; noMatchingSurface?: boolean }[];
      };
      expect(parsed.results.some((r) => !r.noMatchingSurface)).toBe(true);
      expect(parsed.results.some((r) => r.noMatchingSurface)).toBe(true);
    });
  });

  test("a single explicit runtime with an unknown selector still errors (unchanged)", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "claude", "--surface", "bogus-selector"], root);
      expect(process.exitCode).toBe(1);
    });
  });

  test("--runtime all with a selector that matches nothing anywhere errors exactly once", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "all", "--surface", "totally-bogus-selector"], root);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("No selected runtime declares surface(s): totally-bogus-selector");
    });
  });
});

describe("missing/unknown --runtime", () => {
  test("missing --runtime errors and exits 1", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install"], root);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("--runtime is required");
    });
  });

  test("unknown runtime id errors and exits 1", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "not-a-real-runtime"], root);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("not-a-real-runtime");
    });
  });
});

describe("matrix --check", () => {
  test("passes on the repo root", async () => {
    await integrationsCommand(["matrix", "--check"], REPO_ROOT);
    expect(process.exitCode).toBe(0);
  });

  test("fails on a temp dir with a drifted copy (--file)", async () => {
    await withTempDir(async (root) => {
      const artifactRelative = "matrix.json";
      const fullPath = path.join(root, artifactRelative);
      const original = JSON.parse(
        await readFile(path.join(REPO_ROOT, "docs/integrations/harness-capability-matrix.json"), "utf8"),
      ) as CapabilityMatrixDocument;
      const tampered = { ...original, harnesses: [...original.harnesses] };
      (tampered as unknown as Record<string, unknown>).version = "9.9.9-tampered";
      await writeFile(fullPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

      await integrationsCommand(["matrix", "--check", "--file", artifactRelative], root);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("does not match");
    });
  });
});

describe("matrix --json", () => {
  test("validates against the schema", async () => {
    await integrationsCommand(["matrix", "--json"], REPO_ROOT);
    const doc = JSON.parse(captured.join("\n")) as CapabilityMatrixDocument;
    const result = validateCapabilityMatrix(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("ctx install-hook vs integrations install --surface ctx-guard", () => {
  test("produce byte-identical .claude/settings.json", async () => {
    const viaCtx = await withMetaproject(async (root) => {
      const originalCwd = process.cwd();
      process.chdir(root);
      try {
        await ctxCommand(["install-hook", "--runtime", "claude"]);
      } finally {
        process.chdir(originalCwd);
      }
      return readFile(path.join(root, ".claude", "settings.json"), "utf8");
    });

    const viaIntegrations = await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "claude", "--surface", "ctx-guard"], root);
      return readFile(path.join(root, ".claude", "settings.json"), "utf8");
    });

    expect(viaIntegrations).toBe(viaCtx);
  });
});

describe("keryx integrations --help / no subcommand", () => {
  test("no subcommand prints help, exit code untouched", async () => {
    await integrationsCommand([], REPO_ROOT);
    expect(process.exitCode).toBe(0);
    expect(captured.join("\n")).toContain("keryx integrations");
  });

  test("unknown subcommand prints help and exits 1", async () => {
    await integrationsCommand(["bogus"], REPO_ROOT);
    expect(process.exitCode).toBe(1);
  });
});

describe("dry-run writes nothing", () => {
  test("install --dry-run: no files written", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "gemini-cli", "--dry-run"], root);
      expect(process.exitCode).toBe(0);
      expect(existsSync(path.join(root, ".gemini", "settings.json"))).toBe(false);
      expect(existsSync(path.join(root, "GEMINI.md"))).toBe(false);
    });
  });
});
