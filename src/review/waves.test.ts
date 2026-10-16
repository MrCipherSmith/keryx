import { describe, expect, test } from "bun:test";
import { dispatchErrors } from "./dispatch";
import { type LedgerInputs, type RawFile, auditRecord, buildLedger } from "./ledger";
import type { SliceEntry, SliceManifest } from "./slice";
import { requiredSlices } from "./waves";

function entry(id: string, files: string[], extra: Partial<SliceEntry> = {}): SliceEntry {
  return { id, path: `${id}.diff`, bytes: 100, contentHash: `hash-${id}`, files, domain: "src", split: "domain", ...extra };
}

function manifestOf(slices: SliceEntry[]): SliceManifest {
  return { schemaVersion: 1, maxBytes: 18_000, waveBytes: 60_000, source: "diff", slices, omissions: [], totals: { slices: slices.length, bytes: 100 * slices.length, files: slices.length, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 } };
}

const ROUTED = manifestOf([
  entry("slice-01", ["src/a.ts"], { roles: ["review-architecture", "review-logic"], depth: "light" }),
  entry("slice-02", ["src/b.test.ts"], { roles: ["review-logic", "review-testing-practices"], depth: "light" }),
  entry("slice-03", ["src/auth/c.ts"], { roles: ["review-architecture", "review-highload", "review-logic", "review-regression", "review-security-code"], depth: "deep" }),
]);

describe("requiredSlices honours slice roles", () => {
  test("a routed slice is owned by its roles only", () => {
    expect(requiredSlices(ROUTED, "review-logic")).toEqual(["slice-01", "slice-02", "slice-03"]);
    expect(requiredSlices(ROUTED, "review-architecture")).toEqual(["slice-01", "slice-03"]);
    expect(requiredSlices(ROUTED, "review-testing-practices")).toEqual(["slice-02"]);
    expect(requiredSlices(ROUTED, "review-style")).toEqual([]);
  });

  test("without roles the path gates still decide, as before", () => {
    const plain = manifestOf([entry("slice-01", ["src/a.ts"]), entry("slice-02", ["src/b.test.ts"])]);
    expect(requiredSlices(plain, "review-logic")).toEqual(["slice-01", "slice-02"]);
    expect(requiredSlices(plain, "review-testing-practices")).toEqual(["slice-02"]);
  });

  test("a reviewer routing does not decide for (a project reviewer) keeps the old ownership on a routed manifest", () => {
    expect(requiredSlices(ROUTED, "acme-domain-reviewer")).toEqual(["slice-01", "slice-02", "slice-03"]);
  });

  test("retry pieces are never required on their own", () => {
    const withRetry = manifestOf([...ROUTED.slices, entry("r1-review-logic-01", ["src/a.ts"], { retryOf: ["slice-01"], attempt: 1, reviewer: "review-logic" })]);
    expect(requiredSlices(withRetry, "review-logic")).toEqual(["slice-01", "slice-02", "slice-03"]);
  });
});

let clock = 0;
function raw(reviewer: string, slices: string[], findings: Array<Record<string, unknown>> = []): RawFile {
  clock += 1;
  return { name: `raw/${reviewer}.txt`, hash: `h${clock}`, mtimeMs: clock, empty: false, assignedSlices: slices, result: { reviewer, status: "DONE", summary: "s", findings, needs_context: [], slices } };
}

function inputs(manifest: SliceManifest, selected: string[], raws: RawFile[]): LedgerInputs {
  return {
    mode: "all",
    selected,
    manifest,
    payloadSlices: {},
    ruleFiles: Object.fromEntries(selected.map((r) => [r, `skills/${r}/SKILL.md`])),
    raws,
    retry: { schemaVersion: 1, reviewers: {} },
    canonical: [],
    dispositions: [],
    manifestPath: "slices/manifest.json",
  };
}

describe("the ledger honours slice roles", () => {
  const selected = ["review-architecture", "review-highload", "review-logic", "review-security-code", "review-style", "review-testing-practices"];
  const done = [
    raw("review-logic", ["slice-01", "slice-02", "slice-03"]),
    raw("review-architecture", ["slice-01", "slice-03"]),
    raw("review-testing-practices", ["slice-02"]),
    raw("review-security-code", ["slice-03"]),
    raw("review-highload", ["slice-03"]),
  ];

  test("each role is complete on its own slices; a role routing gave no slice runs as routed out, backed by the manifest", () => {
    const { ledger, gaps } = buildLedger(inputs(ROUTED, selected, done));
    expect(gaps).toEqual([]);
    expect(ledger.scopeReviewed).toBe(true);
    const runs = ledger.dispatch.runs as Array<Record<string, unknown>>;
    const style = runs.find((run) => run.reviewer === "review-style")!;
    expect(style).toMatchObject({ status: "complete", scopeComplete: true, routedOut: true, rawEvidence: "slices/manifest.json#roles" });
    expect(dispatchErrors(ledger.dispatch)).toEqual([]);
  });

  test("a role missing a slice it owns is still incomplete", () => {
    const partial = done.map((r) => (r.result!.reviewer === "review-architecture" ? raw("review-architecture", ["slice-01"]) : r));
    const { ledger, gaps } = buildLedger(inputs(ROUTED, selected, partial));
    expect(ledger.scopeReviewed).toBe(false);
    expect(gaps.some((gap) => gap.reviewer === "review-architecture" && gap.detail.includes("slice-03"))).toBe(true);
  });

  test("every changed line is still read by a role: a slice no finished reviewer covered keeps the scope open", () => {
    // review-logic is the only owner of slice-02 besides testing-practices; neither covered it.
    const missing = [raw("review-logic", ["slice-01", "slice-03"]), ...done.filter((r) => r.result!.reviewer !== "review-logic" && r.result!.reviewer !== "review-testing-practices"), raw("review-testing-practices", [])];
    const { ledger } = buildLedger(inputs(ROUTED, selected, missing));
    expect(ledger.scopeReviewed).toBe(false);
  });

  test("the regression reviewer is never routed out: it reads scope B, not only slices", () => {
    const noDeep = manifestOf(ROUTED.slices.slice(0, 2));
    const { ledger } = buildLedger(inputs(noDeep, ["review-logic", "review-regression"], [raw("review-logic", ["slice-01", "slice-02"])]));
    const runs = ledger.dispatch.runs as Array<Record<string, unknown>>;
    expect(runs.find((run) => run.reviewer === "review-regression")?.status).toBe("not-run");
  });

  test("the ledger records the audit sample and what the audit's extra roles caught on it", () => {
    const audited = manifestOf([ROUTED.slices[0]!, { ...ROUTED.slices[2]!, depth: "deep", audit: true }]);
    const raws = [raw("review-security-code", ["slice-03"], [{ id: "S1", severity: "major", file: "src/auth/c.ts" }]), raw("review-logic", ["slice-03"], [{ id: "L1", severity: "minor", file: "src/auth/c.ts" }])];
    expect(auditRecord(audited, raws)).toEqual({ slices: ["slice-03"], caught: [{ slice: "slice-03", findings: ["review-security-code:S1"] }], catchRate: 1 });
    expect(auditRecord(audited, [])?.catchRate).toBe(0);
    expect(auditRecord(ROUTED, raws)).toBeUndefined();
    expect(buildLedger(inputs(audited, ["review-logic", "review-security-code"], raws)).ledger.audit?.catchRate).toBe(1);
  });
});
