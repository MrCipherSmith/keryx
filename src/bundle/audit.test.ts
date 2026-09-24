// Flow 313 (W4 portability), T6 — audit.ts: staging, the imported-bundles
// error/incomplete refusal, and the high/critical-finding refusal. Uses a
// stubbed `runAudit` (dependency-injected) so this test does not depend on
// lane B's `runHarnessAudit` timing.

import { describe, expect, test } from "bun:test";

import { auditBundlePlan } from "./audit";
import type { AuditReport } from "../security/service";
import type { PlanEntry } from "./plan";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-09-24T00:00:00.000Z",
    root: "/tmp/staging",
    surfaces: [{ surface: "imported-bundles", status: "scanned", pathsScanned: [] }],
    findings: [],
    summary: { score: 100, grade: "A", countsBySeverity: { low: 0, medium: 0, high: 0, critical: 0 }, totalFindings: 0 },
    coverage: { status: "complete" },
    baseline: null,
    ...overrides,
  };
}

function entry(overrides: Partial<PlanEntry> = {}): PlanEntry {
  return {
    path: "agents/a.md",
    kind: "agent",
    entryScope: "project",
    targetScope: "project",
    targetRelative: "agents/a.md",
    displayId: "project:agents/a.md",
    targetPath: "/tmp/target/agents/a.md",
    bucket: "new",
    forced: false,
    incomingSha256: "a".repeat(64),
    bytes: Buffer.from("content"),
    ...overrides,
  };
}

describe("auditBundlePlan", () => {
  test("nothing to write -> ok, no audit call", async () => {
    let called = false;
    const result = await auditBundlePlan(
      { entries: [entry({ bucket: "identical" })] },
      { runAudit: async () => { called = true; return baseReport(); } },
    );
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
  });

  test("a clean report passes", async () => {
    const result = await auditBundlePlan({ entries: [entry()] }, { runAudit: async () => baseReport() });
    expect(result.ok).toBe(true);
  });

  test("an error status on the imported-bundles surface refuses as audit-incomplete", async () => {
    const result = await auditBundlePlan(
      { entries: [entry()] },
      { runAudit: async () => baseReport({ surfaces: [{ surface: "imported-bundles", status: "error", pathsScanned: [], error: "boom" }] }) },
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "audit-incomplete")).toBe(true);
  });

  test("a high-severity finding refuses as audit-failed", async () => {
    const result = await auditBundlePlan(
      { entries: [entry()] },
      {
        runAudit: async () =>
          baseReport({
            findings: [
              {
                id: "f1",
                surface: "imported-bundles",
                check: "hook-command-injection",
                severity: "high",
                confidence: 0.9,
                message: "danger",
                evidence: {},
                suppressed: { value: false, baselineEntryId: null },
              },
            ],
            summary: { score: 10, grade: "F", countsBySeverity: { low: 0, medium: 0, high: 1, critical: 0 }, totalFindings: 1 },
          }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "audit-failed")).toBe(true);
  });

  test("stages entries at their bundle paths", async () => {
    let stagedRoot = "";
    let stagedOptions: unknown;
    await auditBundlePlan(
      { entries: [entry({ path: "skills/foo/SKILL.md" })] },
      {
        runAudit: async (root, options) => {
          stagedRoot = root;
          stagedOptions = options;
          return baseReport();
        },
      },
    );
    expect(stagedRoot.length).toBeGreaterThan(0);
    expect(JSON.stringify(stagedOptions)).toContain("skills/foo/SKILL.md");
  });
});
