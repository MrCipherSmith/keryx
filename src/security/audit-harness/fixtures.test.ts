// Flow 308 (W8 Design part A, Lane A) — labeled-fixture test (Wave-1 exit,
// AC16) plus AC1 (coverage/schema): every fixture under `fixtures/<name>/`
// declares its expected check-id set in `expected.json`; this test copies
// each fixture to a tmp dir, runs the audit, and asserts the exact set.

import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runHarnessAudit } from "./index";
import { validateAgainstSchema, type JsonSchema } from "../schemas";

const FIXTURES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function fixtureNames(): Promise<string[]> {
  const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "keryx-audit-harness-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// Top-level await (supported by bun's ESM test runner): fixture directories
// must be known SYNCHRONOUSLY when `describe` registers its `test`s below —
// an async `describe` callback does not reliably finish registering before
// the runner starts executing, so the listing happens here instead.
const FIXTURE_NAMES = await fixtureNames();

describe("labeled fixtures (Wave-1 exit, W8-AC16)", () => {
  for (const name of FIXTURE_NAMES) {
    test(`fixture "${name}" produces exactly its expected check ids`, async () => {
      const fixtureDir = path.join(FIXTURES_ROOT, name);
      const target = path.join(tmp, name);
      await cp(fixtureDir, target, { recursive: true });
      const expected = JSON.parse(await readFile(path.join(fixtureDir, "expected.json"), "utf8")) as {
        checks: string[];
      };

      const report = await runHarnessAudit(target);
      const actualChecks: string[] = [...new Set(report.findings.map((f): string => f.check))].sort();

      expect(actualChecks).toEqual([...expected.checks].sort());
      for (const finding of report.findings) {
        expect(typeof finding.severity).toBe("string");
        expect(finding.severity.length).toBeGreaterThan(0);
      }
      expect(typeof report.summary.score).toBe("number");
      expect(["A", "B", "C", "D", "F"]).toContain(report.summary.grade);
    });
  }
});

// --- W8-AC1 --------------------------------------------------------------

// Faithful copy of docs/requirements/keryx-agent-platform-expansion/schemas/
// harness-audit-report.schema.json's shape, loaded at test time so a schema
// drift is caught here rather than only at review — see the note on
// `format` below.
async function loadReportSchema(): Promise<JsonSchema> {
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "docs",
    "requirements",
    "keryx-agent-platform-expansion",
    "schemas",
    "harness-audit-report.schema.json",
  );
  const raw = JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;
  return raw;
}

test("W8-AC1: CLAUDE.md-only project reports every surface, none absent-as-scanned, and validates against the schema", async () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "claude-md-only");
  await cp(fixtureDir, tmp, { recursive: true });

  const report = await runHarnessAudit(tmp);

  const surfaceIds: string[] = report.surfaces.map((s): string => s.surface).sort();
  expect(surfaceIds).toEqual(
    [
      "agent-definitions",
      "hooks",
      "imported-bundles",
      "instructions",
      "mcp-configs",
      "settings",
      "skills",
    ].sort(),
  );
  for (const surface of report.surfaces) {
    expect(["scanned", "not-applicable", "error"]).toContain(surface.status);
    if (surface.surface !== "instructions") {
      // Nothing else exists in this fixture: every other surface must be
      // not-applicable, never silently "scanned and clean".
      expect(surface.status).toBe("not-applicable");
    } else {
      expect(surface.status).toBe("scanned");
    }
  }

  const schema = await loadReportSchema();
  const errors = validateAgainstSchema(report, schema).filter((e) => !e.message.includes("format"));
  expect(errors).toEqual([]);
});
