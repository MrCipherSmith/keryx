import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coverageErrors, isAttendedRun } from "../review/coverage";
import type { RawFile } from "../review/ledger";
import { pendingMutants } from "../review/mutate";
import { assignRawDispatch, definitionCandidates, isReviewerReply, readDrivers } from "./review-ledger";

describe("driver files and raw replies (flow 430 AC3, AC4)", () => {
  test("a rule file is found under definition, skill_path, or either key inside payload", () => {
    expect(definitionCandidates({ definition: "a.md" })).toEqual(["a.md"]);
    expect(definitionCandidates({ skill_path: "b.md" })).toEqual(["b.md"]);
    expect(definitionCandidates({ payload: { skill_path: "c.md", definition: "d.md" } })).toEqual(["d.md", "c.md"]);
    expect(definitionCandidates({ definition: "", payload: {} })).toEqual([]);
  });

  test("readDrivers resolves a payload skill_path and still names a missing definition as no rule", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-f430-"));
    try {
      await mkdir(path.join(root, "in", "drivers"), { recursive: true });
      await mkdir(path.join(root, "rules"), { recursive: true });
      await writeFile(path.join(root, "rules", "logic.md"), "# logic\n");
      const put = (name: string, body: object) => writeFile(path.join(root, "in", "drivers", name), JSON.stringify(body));
      await put("review-logic.json", { reviewer: "review-logic", slices: ["S1"], result: "raw/review-logic.txt", payload: { skill_path: "rules/logic.md" } });
      await put("review-style.json", { reviewer: "review-style", slices: [{ id: "S2", status: "DONE" }], result: "raw/review-style.txt", definition: "rules/missing.md" });
      const drivers = await readDrivers(path.join(root, "in"), root);
      expect(drivers.ruleFiles).toEqual({ "review-logic": path.join("rules", "logic.md") });
      expect(drivers.payloadSlices).toEqual({ "review-logic": ["S1"], "review-style": ["S2"] });
      expect([...drivers.replies.files].sort()).toEqual(["review-logic.txt", "review-style.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const replies = { files: new Set(["review-logic.txt"]), reviewers: ["review-logic"] };

  test("a verification payload filed in raw/ is not a reviewer reply", () => {
    expect(isReviewerReply("verification.txt", '{"claims": []}', replies)).toBe(false);
  });

  test("a file holding REVIEW_RESULT, named by a driver, or named after a reviewer still is one", () => {
    expect(isReviewerReply("verification.txt", "REVIEW_RESULT: {}", replies)).toBe(true);
    expect(isReviewerReply("review-logic.txt", "no block here", replies)).toBe(true);
    expect(isReviewerReply("review-logic-retry.txt", "no block here", replies)).toBe(true);
    expect(isReviewerReply("review-logic.2.txt", "no block here", replies)).toBe(true);
  });
});

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
