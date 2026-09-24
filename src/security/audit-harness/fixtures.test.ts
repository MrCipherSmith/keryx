// Flow 308 (W8 Design part A, Lane A) — labeled-fixture test (Wave-1 exit,
// AC16) plus AC1 (coverage/schema): every fixture under `fixtures/<name>/`
// declares its expected check-id set in `expected.json`; this test copies
// each fixture to a tmp dir, runs the audit, and asserts the exact set.

import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { computeObjectChecksum } from "../config";
import { defaultBaselinePath, runHarnessAudit } from "./index";
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

// --- F23 -----------------------------------------------------------------
//
// `validateAgainstSchema` (src/security/schemas.ts) is a draft-2020-12
// SUBSET: it does not understand `const` or `oneOf` at all (only
// type/enum/required/properties/additionalProperties/items/pattern/format).
// The bundled schema's `schemaVersion` (`const: "1.0.0"`), `baseline`
// (`oneOf [null, baselineState]`) and `finding.fixProposal`
// (`oneOf [null, fixProposal]`) are therefore never actually checked by the
// W8-AC1 pass above, however clean it looks — these assertions cover exactly
// those three shapes directly instead.

test("F23: schemaVersion is the exact const \"1.0.0\", and baseline / fixProposal follow the schema's oneOf(null, object) shape", async () => {
  // Branch 1: no baseline configured, no --fix-proposals -> baseline is
  // null, and any fixProposal-bearing finding still comes back `null`
  // (never present-but-omitted, and never a raw internal id).
  const fixtureDir = path.join(FIXTURES_ROOT, "permissive-settings");
  const bareTarget = path.join(tmp, "bare");
  await cp(fixtureDir, bareTarget, { recursive: true });
  const bareReport = await runHarnessAudit(bareTarget);
  expect(bareReport.schemaVersion).toBe("1.0.0");
  expect(bareReport.baseline).toBeNull();
  const bareFindingWithProposal = bareReport.findings.find((f) => f.check === "over-permissive-allowlist");
  expect(bareFindingWithProposal).toBeTruthy();
  // fixProposals:false -> the field is explicitly `null`, not populated.
  expect(bareFindingWithProposal?.fixProposal).toBeNull();

  // Branch 2: --fix-proposals true, plus a real (ok) baseline configured ->
  // baseline takes its object branch, and the same finding's fixProposal
  // takes ITS object branch, shaped exactly like the schema's `fixProposal`
  // $def (`required: ["id", "rationale"]`, `additionalProperties: false`).
  const wiredTarget = path.join(tmp, "wired");
  await cp(fixtureDir, wiredTarget, { recursive: true });
  await mkdir(path.join(wiredTarget, ".metaproject"), { recursive: true });
  const entries = [{ findingId: "unrelated-id-not-present", justification: "kept only so baseline is configured" }];
  await writeFile(
    defaultBaselinePath(wiredTarget),
    `${JSON.stringify({ schemaVersion: 1, entries, checksum: computeObjectChecksum(entries) }, null, 2)}\n`,
    "utf8",
  );
  const wiredReport = await runHarnessAudit(wiredTarget, { fixProposals: true });
  expect(wiredReport.schemaVersion).toBe("1.0.0");
  expect(wiredReport.baseline).not.toBeNull();
  expect(typeof wiredReport.baseline).toBe("object");
  expect(wiredReport.baseline?.tamperState).toBe("ok");

  const wiredFindingWithProposal = wiredReport.findings.find((f) => f.check === "over-permissive-allowlist");
  const proposal = wiredFindingWithProposal?.fixProposal;
  expect(proposal).not.toBeNull();
  expect(proposal).toBeTruthy();
  expect(typeof proposal!.id).toBe("string");
  expect(proposal!.id.length).toBeGreaterThan(0);
  expect(typeof proposal!.rationale).toBe("string");
  // `additionalProperties: false` on the fixProposal $def: only id/rationale/
  // patch are allowed keys.
  expect(Object.keys(proposal!).every((k) => k === "id" || k === "rationale" || k === "patch")).toBe(true);
});
