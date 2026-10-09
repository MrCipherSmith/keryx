// The round that would have died, ingesting.
//
// On 2026-09-12 a report reached `review ingest` with no `id` on any finding
// and was refused with "…#undefined claimed by 5 findings". Everything needed
// to fill that in was in the report. These drive the REAL ingest, so a repair
// that exists but is never called fails here rather than passing review.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManagedReviewPackage, type ManagedReviewIngestInput } from "./managed";
import type { ManagedReviewManifest, StructuredReviewFinding } from "./types";

const ORIGINAL_CWD = process.cwd();
const pendingTests = new Set<Promise<void>>();

function workspaceTest(name: string, fn: (root: string) => Promise<void>): void {
  test(name, () => {
    const run = (async () => {
      // Setup belongs to the callback too: a timed-out hook must not outlive cleanup.
      const root = await mkdtemp(path.join(tmpdir(), "gd-repair-ingest-"));
      try {
        await mkdir(path.join(root, ".metaproject"), { recursive: true });
        const schemaDir = path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas");
        await mkdir(schemaDir, { recursive: true });
        await writeFile(
          path.join(schemaDir, "managed-review-package.schema.json"),
          await readFile(
            path.join(ORIGINAL_CWD, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
            "utf8",
          ),
          "utf8",
        );
        await fn(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    })();
    pendingTests.add(run);
    // Return the original promise so ordinary failures still fail the test, while
    // handling late rejections when Bun has already reported a timeout.
    void run.then(() => pendingTests.delete(run), () => pendingTests.delete(run));
    return run;
  });
}

afterEach(async () => {
  // Bun does not cancel callbacks on timeout. Include setup, assertions and cleanup.
  await Promise.allSettled([...pendingTests]);
}, 60_000);

/** A finding as a reviewer actually emits one: a title, and no `id`. */
function untitledFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewer: "review-logic",
    severity: "minor",
    title: "the guard drops a real phone number",
    impact: "a number beside a word is no longer redacted",
    suggested_fix: "require positive evidence of an identifier",
    evidence: "ran the six cases before and after",
    confidence: "high",
    ...over,
  };
}

async function ingest(root: string, findings: unknown[], over: Partial<ManagedReviewIngestInput> = {}): Promise<{
  findings: StructuredReviewFinding[];
  manifest: ManagedReviewManifest;
}> {
  const result = await createManagedReviewPackage({
    cwd: root,
    mode: "ingest",
    reviewId: "2026-09-15-repair",
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: findings as never,
    now: new Date("2026-09-15T12:00:00Z"),
    ...over,
  });
  return {
    findings: JSON.parse(await readFile(path.join(root, result.path, "findings.json"), "utf8")) as StructuredReviewFinding[],
    manifest: JSON.parse(await readFile(path.join(root, result.path, "manifest.json"), "utf8")) as ManagedReviewManifest,
  };
}

workspaceTest("AC3: five findings with no id ingest cleanly, numbered by report order", async (root) => {
  const { findings, manifest } = await ingest(root, [
    untitledFinding(),
    untitledFinding({ title: "the scan is unbounded" }),
    untitledFinding({ title: "the branch is unreachable" }),
    untitledFinding({ title: "the test names the wrong surface" }),
    untitledFinding({ title: "the ssn rule has the same hole" }),
  ]);
  expect(findings.map((finding) => finding.id)).toEqual(["F-001", "F-002", "F-003", "F-004", "F-005"]);
  // And the keys they used to collide on are distinct.
  expect(new Set(findings.map((finding) => finding.global_id)).size).toBe(5);
  expect(manifest.repairs?.filter((repair) => repair.field === "id")).toHaveLength(5);
});

workspaceTest("AC3: `problem` is carried across from the reviewer's own title, and the record says so", async (root) => {
  const { findings, manifest } = await ingest(root, [untitledFinding()]);
  expect(findings[0]?.problem).toBe("the guard drops a real phone number");
  expect(manifest.repairs).toEqual([
    { finding: "F-001", field: "id", source: "position 1 in the report" },
    { finding: "F-001", field: "problem", source: "the finding's own title" },
  ]);
});

workspaceTest("AC4: a blocker with no class_scope is still refused — repair does not reach judgement", async (root) => {
  await expect(
    ingest(root, [untitledFinding({ severity: "blocker" })]),
  ).rejects.toThrow(/class_scope/);
});

workspaceTest("AC4: a finding with neither problem nor title is still refused", async (root) => {
  const { title: _dropped, ...noTitle } = untitledFinding();
  await expect(ingest(root, [noTitle])).rejects.toThrow(/review-finding\.schema\.json/);
});

workspaceTest("BOUNDARY: a complete report records no repairs at all", async (root) => {
  const { manifest } = await ingest(root, [
    untitledFinding({ id: "F-042", problem: "stated by the reviewer" }),
  ]);
  expect(manifest.repairs).toBeUndefined();
});
