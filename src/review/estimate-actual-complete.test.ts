import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { READY_COVERAGE_MD, READY_DISPATCH } from "./dispatch.test-helpers";
import { completeManagedReview, createManagedReviewPackage } from "./managed";

const ready = { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH };
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-estimate-complete-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function round(options: { plan: boolean; raws: number[] }): Promise<{ pkg: string; ref: string }> {
  const result = await createManagedReviewPackage({ cwd: dir, mode: "ingest", reportText: "# Review\nEvidence level: ran — bun test\nNo findings.\n", reviewId: "estimate-actual", target: { kind: "report", ref: "review.md" } });
  const pkg = path.resolve(dir, result.path);
  await writeFile(path.join(pkg, "research.json"), JSON.stringify(ready));
  await writeFile(path.join(pkg, "coverage.md"), READY_COVERAGE_MD);
  if (options.plan) {
    const file = path.join(pkg, "plan.json");
    await writeFile(file, JSON.stringify({ dispatches: 54, minutes: { min: 28, max: 70 } }));
    await utimes(file, new Date(T0 - MIN), new Date(T0 - MIN));
  }
  if (options.raws.length > 0) {
    await mkdir(path.join(pkg, "raw"), { recursive: true });
    await writeFile(path.join(pkg, "synthetic fixture report"), "x");
  }
  for (const [index, at] of options.raws.entries()) {
    const file = path.join(pkg, "raw", `r${index}.txt`);
    await writeFile(file, "x");
    await utimes(file, new Date(T0 + at * MIN), new Date(T0 + at * MIN));
  }
  return { pkg, ref: result.path };
}

test("complete writes the line into report.md after the evidence level, returns it, and a second close leaves one line", async () => {
  const { pkg, ref } = await round({ plan: true, raws: [0, 9, 18, 27, 35, 43] });
  const first = await completeManagedReview(dir, ref);
  const expected = "Plan estimate vs actual: plan 28-70 min (54 dispatches); actual 43 min from first to last raw reply (6 replies); pauses over 10 min: 0";
  expect(first.estimateLine).toBe(expected);
  const report = await readFile(path.join(pkg, "report.md"), "utf8");
  expect(report).toContain(`Evidence level: ran — bun test\n${expected}\n`);

  await completeManagedReview(dir, ref);
  const again = await readFile(path.join(pkg, "report.md"), "utf8");
  expect(again.match(/^Plan estimate vs actual:/gm)?.length).toBe(1);
});

test("a package with neither a plan nor a raw reply gets no line and its report is untouched", async () => {
  const { pkg, ref } = await round({ plan: false, raws: [] });
  const before = await readFile(path.join(pkg, "report.md"), "utf8");
  const done = await completeManagedReview(dir, ref);
  expect(done.estimateLine).toBeUndefined();
  expect(await readFile(path.join(pkg, "report.md"), "utf8")).toBe(before);
});
