// Flow 313 (W4 portability), lane C3 re-plan — R3-F5, choke point f.
//
// The round-3 review found the W4 workflow could not even round-trip THIS
// repository's own `.metaproject/` project scope: the real W8 audit
// (`runHarnessAudit`, never stubbed here — that is the point of this test)
// refused the export on documented placeholders and quoted documentation
// examples that are not real secrets or real injection payloads (R3-F5).
// This test exports the real, live `.metaproject/` of the repository this
// test file lives in, imports it into a completely fresh temp project +
// temp `KERYX_HOME`, and requires the audit gate to pass with zero
// high/critical findings and zero apply refusals — the same path
// `keryx bundle export`/`keryx bundle import` drive in production, through
// the public `./service` facade only (mirrors `roundtrip.e2e.test.ts` and
// `hook-audit.e2e.test.ts`).
//
// Lane C2 owns `src/bundle/**` export/plan/apply core and may be renaming or
// skipping non-portable source names concurrently (R3-F21) — `exported.
// result.skipped` is read and reported, never asserted empty, so this test
// does not couple to C2's in-flight skip policy.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { applyBundlePlan, auditBundlePlan, exportBundle, openBundle, parseManifest, planBundleImport } from "./service";

// This test file lives at `<repo-root>/src/bundle/own-repo-roundtrip.test.ts`.
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

let root: string;
let targetProjectRoot: string;
let targetHomeDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-own-repo-roundtrip-"));
  targetProjectRoot = path.join(root, "target-project");
  targetHomeDir = path.join(root, "target-home");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test(
  "own-repo round trip: exporting this repo's project scope and importing it into a fresh project succeeds with zero refusals under the real W8 audit",
  async () => {
    const bundleOut = path.join(root, "own-repo-bundle");

    const exported = await exportBundle({
      projectRoot: REPO_ROOT,
      scope: "project",
      out: bundleOut,
      keryxVersion: "0.2.999-own-repo-roundtrip-test",
      homeDir: path.join(root, "unused-source-home"),
      env: {},
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(`export refused: ${exported.refusals.map((r) => `${r.reason}: ${r.message}`).join("; ")}`);
    }
    expect(exported.result.entries.length).toBeGreaterThan(0);

    // R3-F21 (lane C2, concurrent): export may skip non-portable source
    // names rather than refusing the whole bundle — tolerated here, listed
    // and counted for visibility, never asserted to be zero.
    if (exported.result.skipped.length > 0) {
      console.log(
        `own-repo-roundtrip: export skipped ${exported.result.skipped.length} non-portable entr${exported.result.skipped.length === 1 ? "y" : "ies"}: ` +
          exported.result.skipped.map((s) => `${s.path} (${s.reason})`).join(", "),
      );
    }

    const opened = await openBundle(bundleOut);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const parsed = parseManifest(opened.value.manifestBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const plan = await planBundleImport({
      source: opened.value,
      manifest: parsed.manifest,
      projectRoot: targetProjectRoot,
      homeDir: targetHomeDir,
      env: {},
      allowHooks: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      const conflicts = plan.entries.filter((e) => e.bucket === "conflict");
      throw new Error(`plan refused; conflicting entries: ${conflicts.map((e) => `${e.targetRelative} (${e.conflictReason})`).join(", ")}`);
    }

    // The real W8 audit — `runAudit` is intentionally NOT overridden here.
    const audit = await auditBundlePlan(plan);
    if (!audit.ok) {
      const blocking = (audit.report?.findings ?? []).filter((f) => (f.severity === "high" || f.severity === "critical") && !f.suppressed.value);
      const detail = blocking.map((f) => `${f.check} @ ${f.path ?? "?"}: ${f.message}`).join("\n  ");
      throw new Error(
        `own-repo round trip refused by the real W8 audit (${blocking.length} blocking finding(s)):\n  ${detail}\n` +
          `refusals: ${audit.refusals.map((r) => `${r.reason}: ${r.message}`).join("; ")}`,
      );
    }
    expect(audit.ok).toBe(true);

    const apply = await applyBundlePlan(plan, audit, { homeDir: targetHomeDir, env: {} });
    expect(apply.refusals).toEqual([]);
    expect(apply.written.length).toBe(plan.entries.length);
  },
  30_000,
);
