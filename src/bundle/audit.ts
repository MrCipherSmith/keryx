// Flow 313 (W4 portability), T6 — the mandatory W8 audit stage between plan
// and apply. Stages the bytes a `new`/`update`/forced-`conflict` bucket would
// write into a fresh temp directory (at their BUNDLE paths) and hands it to
// W8's `runHarnessAudit` under the `imported-bundles` surface, per
// W4-portability.md's Plan -> Audit -> Apply lifecycle and AC12.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { auditGate, runHarnessAudit, type AuditFinding, type AuditReport, type RunAuditOptions } from "../security/service";
import type { PlanEntry } from "./plan";
import { BUNDLE_REFUSAL, type BundleRefusal } from "./types";

export type RunAuditFn = (root: string, options?: RunAuditOptions) => Promise<AuditReport>;

export interface AuditBundlePlanOptions {
  runAudit?: RunAuditFn;
}

export interface AuditBundlePlanResult {
  ok: boolean;
  refusals: BundleRefusal[];
  report: AuditReport | null;
}

function entriesToStage(plan: { entries: readonly PlanEntry[] }): PlanEntry[] {
  return plan.entries.filter((e) => e.bucket === "new" || e.bucket === "update" || (e.bucket === "conflict" && e.forced));
}

export async function auditBundlePlan(
  plan: { entries: readonly PlanEntry[] },
  opts: AuditBundlePlanOptions = {},
): Promise<AuditBundlePlanResult> {
  const toStage = entriesToStage(plan);
  if (toStage.length === 0) {
    return { ok: true, refusals: [], report: null };
  }

  const runAudit: RunAuditFn = opts.runAudit ?? (runHarnessAudit as unknown as RunAuditFn);

  const stagingDir = await mkdtemp(path.join(tmpdir(), "keryx-bundle-audit-"));
  try {
    for (const entry of toStage) {
      const abs = path.join(stagingDir, ...entry.path.split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, entry.bytes);
    }

    const report = await runAudit(stagingDir, {
      importedBundle: { entries: toStage.map((e) => ({ path: e.path, kind: e.kind })) },
    });

    const refusals: BundleRefusal[] = [];
    const importedSurface = report.surfaces.find((s) => s.surface === "imported-bundles");
    if (importedSurface !== undefined && importedSurface.status === "error") {
      refusals.push({ reason: BUNDLE_REFUSAL.auditIncomplete, message: `imported-bundles audit surface reported an error: ${importedSurface.error ?? "unknown"}` });
    }

    if (auditGate(report) === "fail") {
      const blocking: AuditFinding[] = report.findings.filter((f) => (f.severity === "high" || f.severity === "critical") && !f.suppressed.value);
      const names = blocking.map((f) => `${f.id} (${f.check} @ ${f.path ?? "?"})`).join(", ");
      refusals.push({ reason: BUNDLE_REFUSAL.auditFailed, message: `import refused by W8 audit: ${names || "policy gate failed"}` });
    }

    return { ok: refusals.length === 0, refusals, report };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
