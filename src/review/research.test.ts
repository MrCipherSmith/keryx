import { validateAgainstSchemaObject } from "../contracts/validator";
import { READY_DISPATCH } from "./dispatch.test-helpers";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { researchErrors, packageResearchErrors, PENDING_RESEARCH } from "./research";
import { createManagedReviewPackage, completeManagedReview } from "./managed";
const ready = { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH };
const obligation = { id: "R1", source: "raw-reviewer#paragraph-3", question: "Does the consumer satisfy its contract?", status: "finding", evidence: "source.ts:20 and probe.log", reason: "Probe contradicts required outcome", finding: "F1" };
test("unresolved work and unreconciled raw are not completion", () => {
  expect(researchErrors(PENDING_RESEARCH, []).length).toBe(2);
  for (const status of ["open", "unverifiable", "deferred"]) expect(researchErrors({ ...ready, obligations: [{ ...obligation, status }] }, [{ id: "F1" }]).join(" ")).toContain("unresolved");
});
test("finding survives canonical consolidation and resolves uniquely", () => {
  const ledger = { ...ready, obligations: [obligation] };
  expect(researchErrors(ledger, []).join(" ")).toContain("uniquely");
  expect(researchErrors(ledger, [{ id: "F1" }, { id: "F1" }]).length).toBe(1);
  expect(researchErrors(ledger, [{ id: "F1" }])).toEqual([]);
});
test("refutation and exclusion require evidence, reason and provenance", () => {
  for (const status of ["refuted", "out-of-scope"]) {
    expect(researchErrors({ ...ready, obligations: [{ ...obligation, status }] }, [])).toEqual([]);
    for (const field of ["evidence", "reason", "source", "question"]) expect(researchErrors({ ...ready, obligations: [{ ...obligation, status, [field]: " " }] }, []).length).toBeGreaterThan(0);
  }
});
test("malformed and duplicate obligations are refused", () => {
  for (const value of [null, [], { ...ready, obligations: {} }, { ...ready, obligations: [null] }, { ...ready, obligations: [obligation, obligation] }]) expect(researchErrors(value, [{ id: "F1" }]).length).toBeGreaterThan(0);
});
test("unreadable and escaping artifacts fail closed; legacy is explicit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keryx-research-"));
  try {
    expect(await packageResearchErrors(dir, {}, [])).toEqual([]);
    expect((await packageResearchErrors(dir, { research: "research.json" }, [])).join(" ")).toContain("unreadable");
    expect((await packageResearchErrors(dir, { research: "../research.json" }, [])).join(" ")).toContain("locator");
    await writeFile(path.join(dir, "research.json"), "not json");
    expect((await packageResearchErrors(dir, { research: "research.json" }, [])).length).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("real new package cannot close until research is resolved", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keryx-research-managed-"));
  try {
    const result = await createManagedReviewPackage({ cwd: dir, mode: "ingest", reportText: "# Review\nNo findings.\n", reviewId: "research-regression", target: { kind: "report", ref: "review.md" } });
    const pkg = path.resolve(dir, result.path);
    const schema = JSON.parse(await readFile(new URL("../../docs/requirements/managed-review-feedback-loop/schemas/managed-review-package.schema.json", import.meta.url), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8"));
    expect(manifest.artifacts.research).toBe("research.json");
    expect(manifest.artifacts.reviewerDispatch).toBe("research.json");
    expect(validateAgainstSchemaObject(schema, manifest).errors).toEqual([]);
    await expect(completeManagedReview(dir, result.path)).rejects.toThrow("research scope census");
    expect(JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8")).status).not.toBe("closed");
    await writeFile(path.join(pkg, "research.json"), JSON.stringify(ready));
    expect((await completeManagedReview(dir, result.path)).manifest.status).toBe("closed");
    await writeFile(path.join(pkg, "research.json"), JSON.stringify({ ...ready, obligations: [{ ...obligation, status: "open" }] }));
    await expect(completeManagedReview(dir, result.path)).rejects.toThrow("unresolved research");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
