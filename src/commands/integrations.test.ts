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

describe("R2-F5: doctor --surface reaches doctorIntegration, it is not silently ignored", () => {
  test("agents: invisible in default doctor output before opt-in, but named explicitly with --surface agents", async () => {
    await withMetaproject(async (root) => {
      // No `--surface agents` on install, so the opt-in `agents` surface has
      // no install-state record at all — `doctorIntegration`'s R1-F8 default
      // skip means the plain `doctor --runtime claude` output below must NOT
      // mention it.
      await integrationsCommand(["install", "--runtime", "claude"], root);

      captured = [];
      await integrationsCommand(["doctor", "--runtime", "claude", "--json"], root);
      expect(process.exitCode).toBe(0);
      const withoutSurface = JSON.parse(captured.join("\n")) as {
        results: { surfaces: { surfaceId: string }[] }[];
      };
      expect(withoutSurface.results[0]!.surfaces.some((s) => s.surfaceId === "agents")).toBe(false);

      // Before R2-F5's fix, `handleDoctor` parsed `--runtime`/`--json` only
      // and never read `--surface` at all, so this call produced the exact
      // same output as the one above — the flag was accepted and silently
      // had no effect. With it wired through to `doctorIntegration`'s
      // `DoctorOptions.surfaces`, naming the opt-in surface explicitly makes
      // it appear even with no install-state record.
      captured = [];
      await integrationsCommand(["doctor", "--runtime", "claude", "--surface", "agents", "--json"], root);
      expect(process.exitCode).toBe(0);
      const withSurface = JSON.parse(captured.join("\n")) as {
        results: { surfaces: { surfaceId: string }[] }[];
      };
      expect(withSurface.results[0]!.surfaces.some((s) => s.surfaceId === "agents")).toBe(true);
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
  test("install includes every adapter with surfaces (flow 306 T20: keryx-shell now has its own)", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "all", "--json"], root);
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string }[];
        unsupported: { runtimeId: string; unsupported: true; reasons: string[] }[];
      };
      const withSurfaces = HARNESS_ADAPTERS.filter((a) => a.surfaces.length > 0);
      const withoutSurfaces = HARNESS_ADAPTERS.filter((a) => a.surfaces.length === 0);
      expect(parsed.results.map((r) => r.runtimeId).sort()).toEqual(withSurfaces.map((a) => a.id).sort());
      // keryx-shell registered eight native surfaces (T20) and moved from
      // `unsupported` into `results` — no adapter today has zero surfaces,
      // so `unsupported` is empty. This still asserts the general rule
      // (every zero-surface adapter is reported unsupported) rather than a
      // fixed id, so it stays true whether or not that remains the case.
      expect(parsed.unsupported.map((u) => u.runtimeId).sort()).toEqual(withoutSurfaces.map((a) => a.id).sort());
      for (const entry of parsed.unsupported) {
        expect(entry.reasons.length).toBeGreaterThan(0);
      }
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

// review round 4, F1: `doctor` previously threw for every runtime lacking a
// requested opt-in surface (`agents`) under `--runtime all`/a comma list,
// because it always ran the strict selector check. Same F3 lenient-matching
// shape as install/uninstall above, now threaded through `doctorIntegration`.
describe("F1: doctor --runtime all/comma-list + --surface never skips a runtime's own doctor pass", () => {
  test("doctor --runtime all --surface agents exits 0 with no false errors; runtimes without `agents` are still fully doctored, not skipped", async () => {
    await withMetaproject(async (root) => {
      // Install `agents` first on every runtime that carries it, so the
      // matched runtimes' doctor is genuinely `ok`, not just non-throwing.
      await integrationsCommand(["install", "--runtime", "all", "--surface", "agents", "--json"], root);
      expect(process.exitCode).toBe(0);

      captured = [];
      process.exitCode = 0;
      await integrationsCommand(["doctor", "--runtime", "all", "--surface", "agents", "--json"], root);
      expect(process.exitCode).toBe(0);
      expect(capturedErr).toEqual([]);
      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string; ok: boolean; surfaces: unknown[]; noMatchingSurface?: boolean }[];
      };
      const matched = parsed.results.filter((r) => !r.noMatchingSurface);
      const notDeclared = parsed.results.filter((r) => r.noMatchingSurface);
      // Sanity: this fixture actually exercises both branches — some
      // registered runtime carries `agents` (claude/codex/kiro/opencode) and
      // some does not (e.g. gemini-cli), or the test proves nothing about F1.
      expect(matched.length).toBeGreaterThan(0);
      expect(notDeclared.length).toBeGreaterThan(0);
      for (const r of matched) expect(r.ok).toBe(true);
      // review round 5, F1: a runtime that doesn't declare `agents` is still
      // doctored in full over its own default surfaces — `noMatchingSurface`
      // is an informational marker only, never a "skip this runtime" signal.
      for (const r of notDeclared) {
        expect(r.surfaces.length).toBeGreaterThan(0);
        expect(r.ok).toBe(true);
      }
    });
  });

  test("a comma list behaves the same as --runtime all for this selector", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "claude,gemini-cli", "--surface", "agents"], root);
      captured = [];
      process.exitCode = 0;
      await integrationsCommand(["doctor", "--runtime", "claude,gemini-cli", "--surface", "agents", "--json"], root);
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string; noMatchingSurface?: boolean; surfaces: unknown[] }[];
      };
      expect(parsed.results.find((r) => r.runtimeId === "claude")?.noMatchingSurface).toBeUndefined();
      const geminiResult = parsed.results.find((r) => r.runtimeId === "gemini-cli")!;
      expect(geminiResult.noMatchingSurface).toBe(true);
      expect(geminiResult.surfaces.length).toBeGreaterThan(0);
    });
  });

  test("a single explicit runtime with an unknown selector still errors (unchanged)", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["doctor", "--runtime", "claude", "--surface", "bogus-selector"], root);
      expect(process.exitCode).toBe(1);
    });
  });

  test("--runtime all with a selector that matches nothing anywhere errors exactly once", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["doctor", "--runtime", "all", "--surface", "totally-bogus-selector"], root);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("No selected runtime declares surface(s): totally-bogus-selector");
    });
  });

  // review round 5, F1: the actual regression — a broken runtime that
  // doesn't declare the requested opt-in surface must not report healthy
  // just because it was "skipped". Corrupt cursor's hooks.json (cursor
  // carries no `agents` surface), then confirm `--surface agents` still
  // surfaces that drift and exits 1, matching a plain `doctor --runtime
  // claude,cursor` with no `--surface` at all.
  test("a broken runtime lacking the requested surface still reports its own drift and exits 1 (R5-F1 regression)", async () => {
    await withMetaproject(async (root) => {
      await integrationsCommand(["install", "--runtime", "claude,cursor"], root);
      const cursorHooksPath = path.join(root, ".cursor", "hooks.json");
      await writeFile(cursorHooksPath, "{ broken", "utf8");

      captured = [];
      process.exitCode = 0;
      await integrationsCommand(["doctor", "--runtime", "claude,cursor", "--surface", "agents", "--json"], root);
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(captured.join("\n")) as {
        results: { runtimeId: string; ok: boolean; noMatchingSurface?: boolean; problems: string[]; surfaces: { problems: string[] }[] }[];
      };
      const cursorResult = parsed.results.find((r) => r.runtimeId === "cursor")!;
      expect(cursorResult.noMatchingSurface).toBe(true);
      expect(cursorResult.ok).toBe(false);
      const allProblems = [...cursorResult.problems, ...cursorResult.surfaces.flatMap((s) => s.problems)].join(" ");
      expect(allProblems).toContain("not valid JSON");
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
