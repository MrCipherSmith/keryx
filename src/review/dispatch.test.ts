import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { coverageErrors, requiredReviewers } from "./coverage";
import { dispatchErrors } from "./dispatch";
import { packageResearchErrors } from "./research";
import { READY_DISPATCH } from "./dispatch.test-helpers";
const valid = () => structuredClone(READY_DISPATCH);
test("independent complete dispatch is accepted", () => {
  expect(dispatchErrors(valid())).toEqual([]);
});
test("one execution cannot impersonate independent roles", () => {
  const d = valid(); d.selected.push("other");
  d.runs.push({ ...d.runs[0]!, reviewer: "other" });
  expect(dispatchErrors(d).join(" ")).toContain("shared execution");
});
test("selected missing, duplicate and unselected runs block completion", () => {
  const d = valid(); d.selected.push("missing");
  expect(dispatchErrors(d).join(" ")).toContain("not dispatched");
  d.runs.push(d.runs[0]!);
  expect(dispatchErrors(d).join(" ")).toContain("duplicate reviewer");
  d.runs[0]!.reviewer = "unselected";
  expect(dispatchErrors(d).join(" ")).toContain("unexpected");
});
test("unresolved anchors and partial or NEEDS_CONTEXT results block completion", () => {
  for (const change of [{ unresolvedRules: ["testing.md"] }, { runs: [{ ...valid().runs[0], status: "NEEDS_CONTEXT" }] }, { runs: [{ ...valid().runs[0], scopeComplete: false }] }])
    expect(dispatchErrors({ ...valid(), ...change }).length).toBeGreaterThan(0);
});
test("a reviewer marked not-run is reported as not run, never as a clean pass", () => {
  const d = valid();
  const run = { ...d.runs[0], status: "not-run", scopeComplete: false, notRunReason: "INCOMPLETE after a smaller-slice retry" };
  const errors = dispatchErrors({ ...d, runs: [run] });
  expect(errors.join(" ")).toContain("not run (INCOMPLETE after a smaller-slice retry)");
  expect(errors.join(" ")).not.toContain("scope is incomplete");
});
test("read-only pass cannot satisfy a required executable investigation", () => {
  const d = valid();
  const run = { ...d.runs[0], executionRequired: true, executionEvidence: [] as string[] };
  expect(dispatchErrors({ ...d, runs: [run] }).join(" ")).toContain("required execution");
  run.executionEvidence.push("baseline and mutation assertion logs");
  expect(dispatchErrors({ ...d, runs: [run] })).toEqual([]);
});
test("malformed inventory and absent provenance fail closed", () => {
  for (const v of [null, [], {}, { ...valid(), selected: [] }, { ...valid(), selected: ["x", "x"] }, { ...valid(), runs: null }, { ...valid(), runs: [{ ...valid().runs[0], ruleEvidence: [] }] }, { ...valid(), runs: [{ ...valid().runs[0], executionReason: "" }] }])
    expect(dispatchErrors(v).length).toBeGreaterThan(0);
});
test("package gate rereads dispatch; legacy absence is compatible only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keryx-dispatch-"));
  try {
    const ledger = { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: valid() };
    const artifacts = { research: "research.json", reviewerDispatch: "research.json" };
    const file = path.join(dir, "research.json");
    await writeFile(file, JSON.stringify(ledger));
    expect(await packageResearchErrors(dir, artifacts, [])).toEqual([]);
    await writeFile(file, JSON.stringify({ ...ledger, dispatch: { ...valid(), unresolvedRules: ["missing"] } }));
    expect((await packageResearchErrors(dir, artifacts, [])).join(" ")).toContain("unresolved rule");
    expect(await packageResearchErrors(dir, { research: "research.json" }, [])).toEqual([]);
    expect((await packageResearchErrors(dir, { reviewerDispatch: "research.json" }, [])).length).toBeGreaterThan(0);
    expect((await packageResearchErrors(dir, { ...artifacts, reviewerDispatch: "../x" }, [])).join(" ")).toContain("locator");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Flow 428 AC1 and AC3: the reviewer set a dispatch must cover, and the ways it is refused.
async function reviewRoot(skills: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "keryx-dispatch-set-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  for (const name of skills) {
    const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
  }
  return root;
}

const SET = ["review-orchestrator", "review-verifier", "review-logic", "review-architecture", "review-clean-code", "review-regression"];
const FILES = ["src/app/page.tsx"];

test("a pull request's reviewer set defaults to every applicable reviewer, and a diff-only dispatch needs the operator's words", async () => {
  const root = await reviewRoot(SET);
  try {
    const all = await requiredReviewers(root, "all", FILES);
    expect(all.mode).toBe("all");
    expect(all.required).toEqual(["review-architecture", "review-clean-code", "review-logic"]);
    const narrowed = ["review-logic"];
    expect((await coverageErrors({ mode: "diff", selected: narrowed }, { root, files: FILES })).join(" ")).toContain("needs operatorQuote");
    expect((await coverageErrors({ mode: "diff", selected: narrowed, operatorQuote: "   " }, { root, files: FILES })).join(" ")).toContain("needs operatorQuote");
    const quoted = await coverageErrors({ mode: "diff", selected: narrowed, operatorQuote: "only the logic reviewer, please" }, { root, files: FILES });
    expect(quoted).toEqual([]);
    expect((await coverageErrors({ mode: "all", selected: narrowed }, { root, files: FILES })).join(" ")).toContain("missing: review-architecture, review-clean-code");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review-regression is required exactly when a blast radius was computed, and the exclusion carries the reason", async () => {
  const root = await reviewRoot(SET);
  try {
    for (const mode of ["all", "diff"] as const) {
      expect((await requiredReviewers(root, mode, FILES, { blastRadius: true })).required).toContain("review-regression");
      const none = await requiredReviewers(root, mode, FILES, { blastRadius: false });
      expect(none.required).not.toContain("review-regression");
      expect(none.excluded.find((e) => e.reviewer === "review-regression")?.reason).toContain("no blast radius computed");
    }
    const without = (await requiredReviewers(root, "all", FILES)).required;
    const refused = await coverageErrors({ mode: "all", selected: without }, { root, files: FILES, blastRadius: true });
    expect(refused.join(" ")).toContain("missing: review-regression");
    expect(await coverageErrors({ mode: "all", selected: without }, { root, files: FILES, blastRadius: false })).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
