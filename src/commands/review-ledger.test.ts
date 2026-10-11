import { expect, test } from "bun:test";
import type { RawFile } from "../review/ledger";
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
