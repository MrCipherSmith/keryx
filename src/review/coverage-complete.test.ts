// Flow 431 AC9: every changed file lands in a slice or under a named omission, and the coverage counts say which
// in-scope files (scope A and B together) a review actually looked at.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCoverage } from "../commands/review-chunks";
import { recordChunk } from "./chunks";
import { COVERAGE_FILE, computeCoverage, coverageLine, readCoverage, writeCoverage } from "./coverage-complete";

let root: string;
let pkg: string;
let originalCwd: string;
let originalExitCode: typeof process.exitCode;

const put = (name: string, value: unknown): void => {
  mkdirSync(path.dirname(path.join(pkg, name)), { recursive: true });
  writeFileSync(path.join(pkg, name), JSON.stringify(value));
};
const slice = (id: string, files: string[]) => ({ id, path: `slices/${id}`, bytes: 10, contentHash: id, files, domain: "d", split: "file" });
const manifest = (slices: ReturnType<typeof slice>[], omissions: Array<{ path: string; reason: string; detail: string; bytes: number }> = []) => ({
  schemaVersion: 1,
  maxBytes: 1000,
  waveBytes: 1000,
  source: "diff",
  slices,
  omissions,
  totals: { slices: slices.length, bytes: 10, files: 1, omittedFiles: omissions.length, omittedBytes: 0, droppedBlocks: 0 },
});
const dispatch = (runs: object[]) => ({ dispatch: { version: 1, mode: "all", selected: ["review-logic"], runs } });
const run = (reviewer: string, extra: object = {}) => ({ reviewer, status: "complete", scopeComplete: true, ...extra });
const drop = (file: string, reason: "cap" | "pre-filter" = "cap", detail = "over the cap") => ({ file, hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason, detail });
const radius = (files: string[], dropped: ReturnType<typeof drop>[]) => ({ schemaVersion: 1, scope: "blast-radius", changedFiles: ["src/a.ts"], files: files.map((file) => ({ file })), dropped });

beforeEach(() => {
  originalCwd = process.cwd();
  originalExitCode = process.exitCode;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-coverage-")));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".metaproject"));
  pkg = path.join(root, ".metaproject", "reviews", "r1");
  mkdirSync(pkg, { recursive: true });
  process.chdir(root);
});
afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  rmSync(root, { recursive: true, force: true });
});

test("a changed file in a finished slice is covered, one under a named omission is covered by the omission, the rest are uncovered", async () => {
  put("scope-files.json", { files: ["src/a.ts", "src/b.ts", "src/c.ts", "pnpm-lock.yaml"] });
  put("slice-manifest.json", manifest([slice("s1", ["src/a.ts"]), slice("s2", ["src/b.ts"])], [{ path: "pnpm-lock.yaml", reason: "lockfile", detail: "generated", bytes: 5 }]));
  put("research.json", dispatch([run("review-logic", { coveredSlices: ["s1"] })]));

  const report = await computeCoverage(pkg);
  expect(report.counts).toEqual({ inScope: 4, covered: 1, omitted: 1, uncovered: 2 });
  expect(Object.fromEntries(report.files.map((entry) => [entry.file, entry.status]))).toEqual({
    "pnpm-lock.yaml": "omitted",
    "src/a.ts": "covered",
    "src/b.ts": "uncovered",
    "src/c.ts": "uncovered",
  });
  expect(report.files.find((entry) => entry.file === "src/b.ts")?.reason).toContain("no finished reviewer result");
  expect(report.files.find((entry) => entry.file === "src/c.ts")?.reason).toContain("in no slice");
  expect(report.omissions).toEqual([{ file: "pnpm-lock.yaml", reason: "lockfile" }]);
  expect(report.omissionReasons).toEqual({ lockfile: 1 });
});

test("scope A and B are counted together: a finished chunk covers dropped files, a complete review-regression run covers the files it read", async () => {
  put("scope-files.json", { files: ["src/a.ts"] });
  put("slice-manifest.json", manifest([slice("s1", ["src/a.ts"])]));
  put("blast-radius.json", radius(["src/near.ts"], [drop("src/far-1.ts"), drop("src/far-2.ts"), drop("gen/out.ts", "pre-filter", "generated")]));
  put("research.json", dispatch([run("review-logic", { coveredSlices: ["s1"] })]));
  writeFileSync(path.join(pkg, "chunks.json"), JSON.stringify({ schemaVersion: 1, reviewer: "review-regression", tier: "middle", source: "blast-radius.json", maxFiles: 40, maxBytes: 1000, dropped: 2, chunks: [{ id: "chunk-001", files: ["src/far-1.ts"], bytes: 1 }, { id: "chunk-002", files: ["src/far-2.ts"], bytes: 1 }] }));
  await recordChunk(pkg, "chunk-001", { status: "DONE", findings: [] });

  const before = await computeCoverage(pkg);
  expect(before.counts).toEqual({ inScope: 5, covered: 2, omitted: 1, uncovered: 2 });
  expect(before.files.find((entry) => entry.file === "src/far-2.ts")?.reason).toBe("its chunk has not finished");
  expect(before.files.find((entry) => entry.file === "src/near.ts")?.status).toBe("uncovered");
  expect(before.omissionReasons).toEqual({ "pre-filter: generated": 1 });

  put("research.json", dispatch([run("review-logic", { coveredSlices: ["s1"] }), run("review-regression")]));
  await recordChunk(pkg, "chunk-002", { status: "DONE", findings: [] });
  const after = await computeCoverage(pkg);
  expect(after.counts).toEqual({ inScope: 5, covered: 4, omitted: 1, uncovered: 0 });
});

test("a package with nothing to account against is not tracked and reports no uncovered file", async () => {
  put("scope-files.json", { files: ["src/a.ts"] });
  put("research.json", dispatch([run("review-logic")]));
  const report = await computeCoverage(pkg);
  expect(report.tracked).toBe(false);
  expect(report.counts.uncovered).toBe(0);
  expect(coverageLine(report)).toStartWith("coverage: not tracked");
});

test("the line names the four counts and the omission reasons", () => {
  expect(coverageLine({ tracked: true, counts: { inScope: 12, covered: 8, omitted: 3, uncovered: 1 }, omissionReasons: { lockfile: 2, generated: 1 } })).toBe(
    "coverage: in scope 12, covered 8, omitted 3 (generated 1, lockfile 2), uncovered 1",
  );
});

test("coverage.json lists every omitted file with its reason and survives a round trip", async () => {
  put("scope-files.json", { files: ["src/a.ts", "dist/x.js"] });
  put("slice-manifest.json", manifest([slice("s1", ["src/a.ts"])], [{ path: "dist/x.js", reason: "build-output", detail: "dist", bytes: 3 }]));
  put("research.json", dispatch([run("review-logic", { coveredSlices: ["s1"] })]));
  const written = await writeCoverage(pkg);
  expect(await readCoverage(pkg)).toEqual(written);
  const onDisk = JSON.parse(readFileSync(path.join(pkg, COVERAGE_FILE), "utf8"));
  expect(onDisk.omissions).toEqual([{ file: "dist/x.js", reason: "build-output" }]);
});

test("`keryx review coverage` prints the four counts for A and B together and writes coverage.json", async () => {
  put("scope-files.json", { files: ["src/a.ts"] });
  put("slice-manifest.json", manifest([slice("s1", ["src/a.ts"])]));
  put("blast-radius.json", radius([], [drop("src/far.ts")]));
  put("research.json", dispatch([run("review-logic", { coveredSlices: ["s1"] })]));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await runCoverage(["--package", pkg], { rejectUnknownFlags: () => {} });
  } finally {
    console.log = log;
  }
  expect(lines.join("\n")).toBe("coverage: in scope 2, covered 1, omitted 0, uncovered 1");
  expect((await readCoverage(pkg))?.counts.uncovered).toBe(1);
});
