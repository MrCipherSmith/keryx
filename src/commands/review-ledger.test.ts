import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coverageErrors, isAttendedRun } from "../review/coverage";
import type { RawFile } from "../review/ledger";
import { pendingMutants } from "../review/mutate";
import { assignRawDispatch } from "./review-ledger";

for (const [label, reviewer, slices, expected] of [
  ["ambiguous raw does not cover union", "reviewer", [["A"], ["B"]], []],
  ["unique dispatch assigns only its slices", "reviewer", [["B"]], ["B"]],
  ["other reviewer cannot assign reply", "other", [["A"]], undefined],
] as const) {
  test(label, () => {
    const raw: RawFile = { name: "raw/reviewer.txt", hash: "hash", mtimeMs: 1, empty: false,
      result: { reviewer: "reviewer", status: "DONE" } };
    const assignments = new Map<string, string[][]>([[`${reviewer}\0raw/reviewer.txt`, slices.map((s) => [...s])]]);
    assignRawDispatch([raw], assignments);
    expect(raw.assignedSlices).toEqual(expected === undefined ? undefined : [...expected]);
  });
}

describe("the close rule for a mutation pass (flow 428 AC5)", () => {
  const dispatch = { mode: "all", override: { operatorQuote: "fixture", reason: "fixture" } };
  const base = { root: "/nonexistent" };

  test("an attended review with proposed mutants nobody ran is refused", async () => {
    const errors = await coverageErrors(dispatch, { ...base, pendingMutants: 3, attended: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("3 proposed mutant(s)");
    expect(errors[0]).toContain("keryx review mutate");
  });

  test("a waiver carrying the operator's words lets it close", async () => {
    const waived = { ...dispatch, mutationWaiver: { operatorQuote: "не гоняй мутации, тесты не запускаются", reason: "suite needs a database" } };
    expect(await coverageErrors(waived, { ...base, pendingMutants: 3, attended: true })).toEqual([]);
    expect(await coverageErrors({ ...dispatch, mutationWaiver: { reason: "no quote" } }, { ...base, pendingMutants: 3, attended: true })).toHaveLength(1);
  });

  test("the unattended rule is unchanged: pending mutants do not block an autonomous run", async () => {
    expect(await coverageErrors(dispatch, { ...base, pendingMutants: 3, attended: false })).toEqual([]);
  });

  test("no pending mutants means nothing to refuse", async () => {
    expect(await coverageErrors(dispatch, { ...base, pendingMutants: 0, attended: true })).toEqual([]);
  });

  test("the autonomous runner's child shell is the only unattended process", () => {
    expect(isAttendedRun({})).toBe(true);
    expect(isAttendedRun({ KERYX_AUTONOMOUS_ANSWERS_FILE: "/tmp/answers.json" })).toBe(false);
  });

  test("pendingMutants counts only mutants no recorded pass ran, and a spec marked not runnable has none", async () => {
    const pkg = await mkdtemp(path.join(tmpdir(), "keryx-ac5-"));
    try {
      await mkdir(path.join(pkg, "research-evidence"), { recursive: true });
      const spec = (extra: object) => writeFile(path.join(pkg, "research-evidence", "mutants.json"), JSON.stringify({ ...extra, mutants: [{ id: "A", file: "f.ts", anchor: "x", replacement: "y" }] }));
      await spec({});
      expect(await pendingMutants(pkg)).toHaveLength(1);
      await spec({ runnable: false });
      expect(await pendingMutants(pkg)).toEqual([]);
    } finally {
      await rm(pkg, { recursive: true, force: true });
    }
  });
});
