// Flow 313 (W4 portability), T6 — Wave-3 exit end-to-end test. Uses the
// checked-in fixture project under `src/bundle/fixtures/roundtrip/`:
// export -> import -> inspect is byte-identical for every checksummed entry,
// and a file the fixture marks as later human-modified is never silently
// overwritten (only `--force` overwrites it).

import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openBundle } from "./archive";
import { auditBundlePlan } from "./audit";
import { applyBundlePlan } from "./apply";
import { exportBundle } from "./export";
import { inspectBundle } from "./inspect";
import { parseManifest } from "./manifest";
import { planBundleImport } from "./plan";
import type { AuditReport } from "../security/service";

const FIXTURE_ROOT = path.join(import.meta.dir, "fixtures", "roundtrip");

const OK_AUDIT_REPORT: AuditReport = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-09-24T00:00:00.000Z",
  root: "",
  surfaces: [{ surface: "imported-bundles", status: "scanned", pathsScanned: [] }],
  findings: [],
  summary: { score: 100, grade: "A", countsBySeverity: { low: 0, medium: 0, high: 0, critical: 0 }, totalFindings: 0 },
  coverage: { status: "complete" },
  baseline: null,
};
const STUB_RUN_AUDIT = async (): Promise<AuditReport> => OK_AUDIT_REPORT;

let root: string;
let sourceProjectRoot: string;
let sourceUserHome: string;
let targetProjectRoot: string;
let targetUserHome: string;
let markedPath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-roundtrip-"));

  sourceProjectRoot = path.join(root, "source-project");
  cpSync(path.join(FIXTURE_ROOT, "project"), sourceProjectRoot, { recursive: true });

  sourceUserHome = path.join(root, "source-user-home");
  cpSync(path.join(FIXTURE_ROOT, "user-home"), sourceUserHome, { recursive: true });

  targetProjectRoot = path.join(root, "target-project");
  mkdirSync(targetProjectRoot, { recursive: true });
  targetUserHome = path.join(root, "target-user-home");
  mkdirSync(targetUserHome, { recursive: true });

  const marker = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, "user-modified.json"), "utf8")) as { path: string };
  markedPath = marker.path;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readTree(dir: string, base = dir): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    const stat = lstatSync(abs);
    if (stat.isDirectory()) {
      for (const [k, v] of readTree(abs, base)) out.set(k, v);
    } else {
      out.set(rel, readFileSync(abs));
    }
  }
  return out;
}

describe("W4 bundle round trip (Wave-3 exit)", () => {
  test("project-scope: export -> import -> inspect is byte-identical; a human-modified file is refused, then --force overwrites it", async () => {
    const bundleOut = path.join(root, "project-bundle");
    const exported = await exportBundle({
      projectRoot: sourceProjectRoot,
      scope: "project",
      out: bundleOut,
      keryxVersion: "0.2.999-fixture",
      homeDir: path.join(root, "unused-home"),
      env: {},
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.entries.length).toBeGreaterThanOrEqual(5);

    const opened = await openBundle(bundleOut);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const parsed = parseManifest(opened.value.manifestBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const plan1 = await planBundleImport({ source: opened.value, manifest: parsed.manifest, projectRoot: targetProjectRoot, homeDir: targetUserHome, env: {}, allowHooks: true });
    expect(plan1.ok).toBe(true);
    expect(plan1.entries.every((e) => e.bucket === "new")).toBe(true);

    const audit1 = await auditBundlePlan(plan1, { runAudit: STUB_RUN_AUDIT });
    expect(audit1.ok).toBe(true);
    const apply1 = await applyBundlePlan(plan1, audit1, { homeDir: targetUserHome, env: {} });
    expect(apply1.refusals).toEqual([]);
    expect(apply1.written.length).toBe(plan1.entries.length);

    // Every imported file byte-equals the bundle bytes.
    const bundleTree = readTree(bundleOut);
    for (const entry of parsed.manifest.contents) {
      const targetAbs = path.join(targetProjectRoot, ".metaproject", ...entry.path.split("/"));
      expect(readFileSync(targetAbs).equals(bundleTree.get(entry.path) as Buffer)).toBe(true);
    }

    // inspect reports every entry identical.
    const inspected = await inspectBundle(bundleOut, { projectRoot: targetProjectRoot, homeDir: targetUserHome, env: {} });
    expect(inspected.ok).toBe(true);
    expect(inspected.entries.every((e) => e.bucket === "identical")).toBe(true);

    // Modify the fixture-marked path; re-import refuses it, unforced.
    const markedAbs = path.join(targetProjectRoot, ".metaproject", ...markedPath.split("/"));
    const humanEdit = "human edit: this file was changed after import\n";
    writeFileSync(markedAbs, humanEdit);

    const plan2 = await planBundleImport({ source: opened.value, manifest: parsed.manifest, projectRoot: targetProjectRoot, homeDir: targetUserHome, env: {}, allowHooks: true });
    expect(plan2.ok).toBe(false);
    const markedEntry2 = plan2.entries.find((e) => e.targetRelative === markedPath);
    expect(markedEntry2?.bucket).toBe("conflict");
    expect(markedEntry2?.conflictReason).toBe("user-modified");

    const audit2 = await auditBundlePlan(plan2, { runAudit: STUB_RUN_AUDIT });
    const apply2 = await applyBundlePlan(plan2, audit2, { homeDir: targetUserHome, env: {} });
    expect(apply2.written).toEqual([]);
    expect(readFileSync(markedAbs, "utf8")).toBe(humanEdit);

    // --force overwrites exactly that path.
    const plan3 = await planBundleImport({
      source: opened.value,
      manifest: parsed.manifest,
      projectRoot: targetProjectRoot,
      homeDir: targetUserHome,
      env: {},
      force: [markedPath],
      allowHooks: true,
    });
    expect(plan3.ok).toBe(true);
    const audit3 = await auditBundlePlan(plan3, { runAudit: STUB_RUN_AUDIT });
    const apply3 = await applyBundlePlan(plan3, audit3, { homeDir: targetUserHome, env: {} });
    expect(apply3.refusals).toEqual([]);
    expect(apply3.written).toContain(`project:${markedPath}`);
    expect(readFileSync(markedAbs).equals(bundleTree.get(markedPath) as Buffer)).toBe(true);
  });

  test("user-scope learned-pattern: import always lands at status candidate regardless of the source status", async () => {
    const bundleOut = path.join(root, "user-bundle");
    const exported = await exportBundle({
      projectRoot: path.join(root, "unused-project"),
      scope: "user",
      out: bundleOut,
      keryxVersion: "0.2.999-fixture",
      homeDir: sourceUserHome,
      env: {},
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.result.entries.some((e) => e.kind === "learned-pattern")).toBe(true);

    const opened = await openBundle(bundleOut);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const parsed = parseManifest(opened.value.manifestBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const plan = await planBundleImport({ source: opened.value, manifest: parsed.manifest, projectRoot: path.join(root, "unused-project-2"), homeDir: targetUserHome, env: {}, targetScope: "user" });
    expect(plan.ok).toBe(true);
    const audit = await auditBundlePlan(plan, { runAudit: STUB_RUN_AUDIT });
    const apply = await applyBundlePlan(plan, audit, { homeDir: targetUserHome, env: {} });
    expect(apply.refusals).toEqual([]);

    const writtenAbs = path.join(targetUserHome, ".keryx", "learning", "patterns", "demo-pattern.json");
    const written = JSON.parse(readFileSync(writtenAbs, "utf8")) as { status: string; scope: string };
    expect(written.status).toBe("candidate");
    expect(written.scope).toBe("user");
  });
});
