import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
