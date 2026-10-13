// Flow 431 AC10: `keryx review complete` refuses while an in-scope file is uncovered, names the count, the first files and
// the command that runs the missing chunks, and lets the operator past only in their own words.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coverageGateErrors, recordCoverageWaiver } from "./coverage-complete";
import { READY_DISPATCH } from "./dispatch.test-helpers";
import { readReviewRounds } from "../flow/review-gate";
import { packageResearchErrors } from "./research";

let pkg: string;
const artifacts = { research: "research.json", reviewerDispatch: "research.json" };
const FAR = Array.from({ length: 8 }, (_, index) => `src/far-${index}.ts`);

const writeResearch = (extra: object = {}): void =>
  writeFileSync(path.join(pkg, "research.json"), JSON.stringify({ version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: { ...structuredClone(READY_DISPATCH), ...extra } }));

beforeEach(() => {
  pkg = mkdtempSync(path.join(tmpdir(), "keryx-gate-"));
  writeFileSync(path.join(pkg, "scope-files.json"), JSON.stringify({ files: ["src/a.ts"] }));
  writeFileSync(
    path.join(pkg, "blast-radius.json"),
    JSON.stringify({ schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped: FAR.map((file) => ({ file, hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason: "cap", detail: "over the cap" })) }),
  );
  mkdirSync(path.join(pkg, "slices"), { recursive: true });
  writeResearch();
});
afterEach(() => rmSync(pkg, { recursive: true, force: true }));

test("the gate refuses and names the count, the first files and the command that runs the missing chunks", async () => {
  const errors = await packageResearchErrors(pkg, artifacts, []);
  expect(errors).toHaveLength(1);
  const message = errors[0] as string;
  expect(message).toContain("8 in-scope file(s) are uncovered");
  expect(message).toContain("src/far-0.ts, src/far-1.ts, src/far-2.ts, src/far-3.ts, src/far-4.ts");
  expect(message).toContain("(+3)");
  expect(message).not.toContain("src/far-5.ts,");
  expect(message).toContain("keryx review chunks next --package");
  expect(message).toContain('--waive-coverage "<operator quote>"');
});

test("the only way past is the operator's own words, recorded with the time and the waived files", async () => {
  await expect(recordCoverageWaiver(pkg, "   ")).rejects.toThrow("operator's own words");
  const waiver = await recordCoverageWaiver(pkg, "  skip the far files, they are generated  ", new Date("2026-10-13T10:00:00Z"));
  expect(waiver).toEqual({ operatorQuote: "skip the far files, they are generated", time: "2026-10-13T10:00:00.000Z", files: FAR });
  const saved = JSON.parse(readFileSync(path.join(pkg, "research.json"), "utf8"));
  expect(saved.dispatch.coverageWaiver).toEqual(waiver);
  expect(await packageResearchErrors(pkg, artifacts, [])).toEqual([]);
});

test("a waiver does not cover a file that became uncovered afterwards", async () => {
  await recordCoverageWaiver(pkg, "skip them");
  writeFileSync(
    path.join(pkg, "blast-radius.json"),
    JSON.stringify({ schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped: [...FAR, "src/late.ts"].map((file) => ({ file, hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason: "cap", detail: "over the cap" })) }),
  );
  const errors = await coverageGateErrors(pkg);
  expect(errors.join(" ")).toContain("9 in-scope file(s) are uncovered");
  expect(errors.join(" ")).toContain("does not name every uncovered file");
});

test("there is no unchecked-remainder outcome: a package with nothing waived and nothing covered stays blocked", async () => {
  const errors = await packageResearchErrors(pkg, artifacts, []);
  expect(errors.join(" ")).not.toMatch(/unchecked remainder/i);
  expect(errors.length).toBeGreaterThan(0);
});

test("a package that tracks nothing is not gated, and an empty uncovered set needs no waiver", async () => {
  writeFileSync(path.join(pkg, "blast-radius.json"), JSON.stringify({ schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped: [] }));
  expect(await packageResearchErrors(pkg, artifacts, [])).toEqual([]);
  expect(await recordCoverageWaiver(pkg, "nothing to waive")).toBeUndefined();
});

test("R2-06: the flow review gate reads a closed round without the completeness gate and still gates an open one", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-gate-flow-"));
  try {
    for (const [name, status] of [["closed-round", "closed"], ["open-round", "open"]] as const) {
      const dir = path.join(cwd, ".metaproject", "flows", "f1", "reviews", name);
      cpSync(pkg, dir, { recursive: true });
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: name, status, createdAt: name, artifacts, target: { head: "abc" } }));
      writeFileSync(path.join(dir, "findings.json"), "[]");
    }
    const rounds = await readReviewRounds(cwd, "f1");
    const closed = rounds.find((round) => round.reviewId === "closed-round");
    const open = rounds.find((round) => round.reviewId === "open-round");
    expect(closed?.problems.join(" ")).not.toContain("uncovered");
    expect(open?.problems.join(" ")).toContain("8 in-scope file(s) are uncovered");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
