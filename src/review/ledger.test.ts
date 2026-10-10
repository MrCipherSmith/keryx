import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requiredReviewers } from "./coverage";
import { type LedgerInputs, type RawFile, buildLedger, ledgerBlockers, parseReviewResult } from "./ledger";
import type { SliceManifest } from "./slice";

let root: string;

async function install(name: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-ledger-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  for (const name of ["review-orchestrator", "review-logic", "review-architecture", "review-testing-practices"]) await install(name);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const FILES = ["src/a.ts", "src/b.test.ts"];

function slice(id: string, files: string[], extra: Record<string, unknown> = {}) {
  return { id, path: `${id}.diff`, bytes: 100, files, domain: "src", split: "domain" as const, ...extra };
}

const MANIFEST = {
  schemaVersion: 1,
  maxBytes: 18000,
  source: "diff",
  slices: [slice("slice-01", ["src/a.ts"]), slice("slice-02", ["src/b.test.ts"])],
  omissions: [],
  totals: { slices: 2, bytes: 200, files: 2, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
} as SliceManifest;

let clock = 0;
function raw(reviewer: string, status: string, extra: Record<string, unknown> = {}, name = `raw/${reviewer}.txt`): RawFile {
  clock += 1;
  return { name, hash: `h${clock}`, mtimeMs: clock, empty: false, result: { reviewer, status, summary: "s", findings: [], needs_context: [], ...extra } };
}

async function inputs(overrides: Partial<LedgerInputs> = {}): Promise<LedgerInputs> {
  const required = (await requiredReviewers(root, "all", FILES)).required;
  return {
    mode: "all",
    selected: required,
    manifest: MANIFEST,
    payloadSlices: Object.fromEntries(required.map((r) => [r, ["slice-01", "slice-02"]])),
    ruleFiles: Object.fromEntries(required.map((r) => [r, `.metaproject/skills/gdskills/review/${r}/SKILL.md`])),
    raws: required.map((r) => raw(r, "DONE")),
    retry: { schemaVersion: 1, reviewers: {} },
    canonical: [],
    dispositions: [],
    manifestPath: "slices/manifest.json",
    ...overrides,
  };
}

const blockersOf = (result: ReturnType<typeof buildLedger>, canonical: Array<Record<string, unknown>> = []) =>
  ledgerBlockers(result.ledger, canonical, { root, files: FILES });

describe("parseReviewResult", () => {
  test("reads a REVIEW_RESULT fence and a json fence, and takes the last block that carries a status", () => {
    const labelled = 'STATUS: DONE\n\n```REVIEW_RESULT\n{"status":"DONE","reviewer":"review-logic","findings":[]}\n```\n';
    expect(parseReviewResult(labelled)?.reviewer).toBe("review-logic");
    const twoBlocks = '```json\n{"status":"BLOCKED","reviewer":"a"}\n```\ntext\n```json\n{"status":"DONE","reviewer":"b"}\n```\n';
    expect(parseReviewResult(twoBlocks)?.reviewer).toBe("b");
  });

  test("returns nothing for prose, empty output or a block without a status", () => {
    expect(parseReviewResult("looks fine to me")).toBeUndefined();
    expect(parseReviewResult("(subagent produced no text)")).toBeUndefined();
    expect(parseReviewResult('```json\n{"verdict":"ok"}\n```')).toBeUndefined();
  });
});

describe("buildLedger", () => {
  test("finished reviewers covering every slice give a ledger the completion gate accepts", async () => {
    const result = buildLedger(await inputs());
    expect(result.gaps).toEqual([]);
    expect(result.ledger.scopeReviewed).toBe(true);
    expect(result.ledger.rawReconciled).toBe(true);
    expect(await blockersOf(result)).toEqual([]);
    const run = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs[0]!;
    expect(run).toMatchObject({ status: "complete", scopeComplete: true, executionRequired: false });
    expect(String(run.rawEvidence)).toContain("#sha256:");
  });

  test("no fabrication: a NEEDS_CONTEXT reviewer stays incomplete and the gap carries the exact retry-plan command", async () => {
    const base = await inputs();
    const raws = [raw("review-architecture", "DONE"), raw("review-logic", "NEEDS_CONTEXT", { needs_context: ["finish the unread slices"] }), raw("review-testing-practices", "DONE")];
    const result = buildLedger({ ...base, raws });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic).toMatchObject({ status: "incomplete", scopeComplete: false });
    expect(result.ledger.scopeReviewed).toBe(false);
    const gap = result.gaps.find((g) => g.reviewer === "review-logic")!;
    expect(gap.detail).toContain("finish the unread slices");
    expect(gap.next).toBe("keryx review retry-plan --manifest slices/manifest.json --result raw/review-logic.txt --reviewer review-logic");
    expect((await blockersOf(result)).join("\n")).toContain("review-logic: reviewer scope is incomplete");
  });

  test("a DONE result with open needs_context is not a finished scope", async () => {
    const base = await inputs();
    const raws = base.selected.map((r) => raw(r, "DONE", r === "review-style" || r === "review-logic" ? { needs_context: ["run the tests"] } : {}));
    const result = buildLedger({ ...base, raws });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic.scopeComplete).toBe(false);
  });

  test("a finished reviewer whose payloads missed a slice is not scope-complete and the gap names the slice", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, payloadSlices: { ...base.payloadSlices, "review-logic": ["slice-01"] } });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic.scopeComplete).toBe(false);
    expect(result.gaps.find((g) => g.reviewer === "review-logic")!.detail).toContain("slice-02");
    expect(result.ledger.scopeReviewed).toBe(false);
  });

  test("a retry slice accounts for the original it was cut from", async () => {
    const base = await inputs();
    const manifest = { ...MANIFEST, slices: [...MANIFEST.slices, slice("r1-review-logic-01", ["src/b.test.ts"], { retryOf: ["slice-02"], attempt: 1 })] } as SliceManifest;
    const result = buildLedger({ ...base, manifest, payloadSlices: { ...base.payloadSlices, "review-logic": ["slice-01", "r1-review-logic-01"] } });
    expect(result.gaps).toEqual([]);
  });

  test("a path-gated reviewer is only required to cover the slices its gate matches", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, payloadSlices: { ...base.payloadSlices, "review-testing-practices": ["slice-02"] } });
    expect(result.gaps).toEqual([]);
  });

  test("a required reviewer with no result is not-run, never complete", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, raws: base.raws.filter((r) => r.result?.reviewer !== "review-logic") });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic).toMatchObject({ status: "not-run", scopeComplete: false });
    expect((await blockersOf(result)).join("\n")).toContain("review-logic: not run");
  });

  test("a reviewer the retry state gave up on stays not-run and the gap says no retry is left", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, retry: { schemaVersion: 1, reviewers: { "review-logic": { attempt: 1, status: "BLOCKED", notRun: true } } } });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic.status).toBe("not-run");
    expect(result.gaps.find((g) => g.reviewer === "review-logic")!.next).toContain("no retry is left");
  });

  test("a missing rule file leaves the rule evidence empty and the gate refuses", async () => {
    const base = await inputs();
    const { "review-logic": _gone, ...ruleFiles } = base.ruleFiles;
    const result = buildLedger({ ...base, ruleFiles });
    expect((result.ledger.dispatch as { unresolvedRules: string[] }).unresolvedRules).toEqual(["review-logic"]);
    expect((await blockersOf(result)).length).toBeGreaterThan(0);
  });

  test("the latest result of a reviewer decides, not an earlier finished one", async () => {
    const base = await inputs();
    const later = raw("review-logic", "NEEDS_CONTEXT", { needs_context: ["more"] }, "raw/review-logic-2.txt");
    const result = buildLedger({ ...base, raws: [...base.raws, later] });
    expect((result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!.status).toBe("incomplete");
  });
});

describe("raw findings", () => {
  const finding = { id: "L-01", severity: "minor", problem: "p", impact: "i", suggested_fix: "f", evidence: "e", confidence: 0.5, reviewer: "review-logic" };

  async function withFinding() {
    const base = await inputs();
    return { ...base, raws: base.raws.map((r) => (r.result?.reviewer === "review-logic" ? { ...r, result: { ...r.result, findings: [finding] } } : r)) };
  }

  test("a raw finding with no canonical match and no closure stays unresolved and blocks the gate", async () => {
    const result = buildLedger(await withFinding());
    expect(result.ledger.obligations).toHaveLength(1);
    expect(result.ledger.obligations[0]).toMatchObject({ status: "unresolved" });
    expect(result.ledger.rawReconciled).toBe(false);
    expect(result.gaps.some((g) => g.next.includes("--dispositions"))).toBe(true);
    expect((await blockersOf(result)).join("\n")).toContain("unresolved research");
  });

  test("a canonical finding of the same reviewer and id closes it with evidence", async () => {
    const base = await withFinding();
    const result = buildLedger({ ...base, canonical: [finding] });
    expect(result.ledger.obligations[0]).toMatchObject({ status: "finding", finding: "L-01" });
    expect(await blockersOf(result, [finding])).toEqual([]);
  });

  test("a disposition closes it only with evidence and reason", async () => {
    const base = await withFinding();
    const id = "review-logic:L-01";
    const thin = buildLedger({ ...base, dispositions: [{ id, status: "refuted", evidence: "", reason: "" }] });
    expect(thin.ledger.obligations[0]).toMatchObject({ status: "unresolved" });
    const full = buildLedger({ ...base, dispositions: [{ id, status: "refuted", evidence: "ran the case, no failure", reason: "the guard exists at a.ts:12" }] });
    expect(full.ledger.obligations[0]).toMatchObject({ status: "refuted", evidence: "ran the case, no failure" });
    expect(await blockersOf(full)).toEqual([]);
  });

  test("a finding disposition must resolve to exactly one canonical finding", async () => {
    const base = await withFinding();
    const result = buildLedger({ ...base, dispositions: [{ id: "review-logic:L-01", status: "finding", finding: "nope", evidence: "e", reason: "r" }] });
    expect(result.ledger.obligations[0]).toMatchObject({ status: "unresolved" });
  });
});

describe("raw files", () => {
  test("an empty reviewer output does not block reconciliation, an unparseable one does", async () => {
    const base = await inputs();
    const empty: RawFile = { name: "raw/lost.txt", hash: "x", mtimeMs: 1, empty: true };
    expect(buildLedger({ ...base, raws: [...base.raws, empty] }).ledger.rawReconciled).toBe(true);
    const garbled: RawFile = { name: "raw/garbled.txt", hash: "y", mtimeMs: 1, empty: false };
    const result = buildLedger({ ...base, raws: [...base.raws, garbled] });
    expect(result.ledger.rawReconciled).toBe(false);
    expect(result.gaps.some((g) => g.detail.includes("raw/garbled.txt"))).toBe(true);
  });

  test("the same inputs build the same ledger", async () => {
    const base = await inputs();
    expect(JSON.stringify(buildLedger(base))).toBe(JSON.stringify(buildLedger(base)));
  });
});
