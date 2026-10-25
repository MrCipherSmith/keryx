// The late results a reviewer left in its package (collectLateResults) and the plain-JSON result reader (wholeFileResult).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatUsageLine } from "./dispatch-usage";
import { collectLateResults, wholeFileResult } from "./retry-eval";

let pkg: string;

beforeEach(async () => {
  pkg = await mkdtemp(path.join(tmpdir(), "retry-eval-"));
  await mkdir(path.join(pkg, "drivers"), { recursive: true });
  await mkdir(path.join(pkg, "raw"), { recursive: true });
  await writeFile(path.join(pkg, "drivers", "review-logic-w1.json"), JSON.stringify({ reviewer: "review-logic", slices: ["slice-01", "slice-02"], result: "raw/review-logic-w1.txt" }));
});

afterEach(async () => {
  await rm(pkg, { recursive: true, force: true });
});

const usage = formatUsageLine({ tokens_in: 10, tokens_out: 2, model: "fake/m" });

test("a plain-JSON result with the host's usage line after it is still read whole (review F-003)", () => {
  expect(wholeFileResult(`{"reviewer":"review-logic","status":"DONE","slices":["slice-01"]}\n${usage}\n`)).toEqual({ reviewer: "review-logic", status: "DONE", slices: ["slice-01"] });
  expect(wholeFileResult("not json")).toBeUndefined();
});

test("a finished reply that names no slices covers none; one that names its slices covers those it was handed (T-R2-002)", async () => {
  const raw = path.join(pkg, "raw", "review-logic-w1.txt");
  await writeFile(raw, `{"reviewer":"review-logic","status":"DONE"}\n${usage}\n`);
  expect(await collectLateResults(pkg, "review-logic", new Set())).toEqual({ covered: [], collected: 0 });
  await writeFile(raw, `{"reviewer":"review-logic","status":"DONE","slices":["slice-01","slice-09"]}\n${usage}\n`);
  expect(await collectLateResults(pkg, "review-logic", new Set())).toEqual({ covered: ["slice-01"], collected: 1 });
});

test("needs_context: an object question keeps a finished reply from counting, as a string question does", async () => {
  const raw = path.join(pkg, "raw", "review-logic-w1.txt");
  await writeFile(raw, `{"reviewer":"review-logic","status":"DONE","slices":["slice-01"],"needs_context":[{"question":"is it rotated?"}]}\n`);
  expect(await collectLateResults(pkg, "review-logic", new Set())).toEqual({ covered: [], collected: 0 });
  await writeFile(raw, `{"reviewer":"review-logic","status":"DONE","slices":["slice-01"],"needs_context":["is it rotated?"]}\n`);
  expect(await collectLateResults(pkg, "review-logic", new Set())).toEqual({ covered: [], collected: 0 });
  await writeFile(raw, `{"reviewer":"review-logic","status":"DONE","slices":["slice-01"],"needs_context":[{}, ""]}\n`);
  expect(await collectLateResults(pkg, "review-logic", new Set())).toEqual({ covered: ["slice-01"], collected: 1 });
});
