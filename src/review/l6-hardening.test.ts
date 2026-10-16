// Review of lanes l4+l5: truncation beats a complete list, named and unnamed results never merge, a second-look claim is
// judged by the slice's own changed lines, waves are packed per slice kind, and a reviewer with nothing routed is owed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseReviewResult } from "./ledger";
import { mergeResults } from "./result-parse";
import { secondLookClaimBacked } from "./round-split";
import type { RoundRecord } from "./round-record";
import { defaultGitRunner, resolveBase } from "./prior-round";
import { writeWaveDrivers } from "./wave-drivers";
import type { SliceEntry, SliceManifest } from "./slice";

const LOGIC = (extra: Record<string, unknown> = {}) => JSON.stringify({ reviewer: "review-logic", status: "DONE", slices: ["s1"], findings: [], ...extra });

test("a complete list followed by a cut-off result is truncated: no result, so F1 is not lost", () => {
  const raw = `[${JSON.stringify({ reviewer: "review-logic", status: "DONE", slices: ["s1"] })}]\n{"reviewer":"review-logic","status":"DONE","slices":["s2"],"findings":[{"id":"F1"`;
  expect(parseReviewResult(raw)).toBeUndefined();
});

test("named and unnamed items in one list do not merge; all-unnamed or one explicit reviewer do", () => {
  const named = { reviewer: "review-logic", status: "DONE", slices: ["s1"], findings: [] };
  const unnamed = { status: "DONE", slices: ["s2"], findings: [] };
  expect(mergeResults([named, unnamed])).toBeUndefined();
  expect(parseReviewResult(JSON.stringify([named, unnamed]))).toBeUndefined();
  expect((mergeResults([unnamed, { ...unnamed, slices: ["s3"] }]) as { slices: string[] }).slices).toEqual(["s2", "s3"]);
  expect((mergeResults([named, { ...named, slices: ["s9"] }]) as { slices: string[] }).slices).toEqual(["s1", "s9"]);
});

test("a valid bare result that has a waves or results array field is read as that result", () => {
  for (const key of ["waves", "results"]) {
    const raw = LOGIC({ [key]: [{ status: "DONE", slices: ["s9"], findings: [] }] });
    expect(parseReviewResult(raw)?.slices).toEqual(["s1"]);
  }
});

test("a sample array followed by the real bare result falls back to the strict reader", () => {
  const raw = `Example of the shape: [${JSON.stringify({ reviewer: "sample", status: "DONE", findings: [] })}]\n\nMy result:\n${LOGIC({ slices: ["s7"] })}`;
  expect(parseReviewResult(raw)?.slices).toEqual(["s7"]);
});

test("a second-look claim is judged by the slice's changed lines, not its file", () => {
  const round = { v: 1, round: 2, mode: "delta", range: { base: "a".repeat(40), head: "b".repeat(40) }, fixHunks: [], newHunks: [{ file: "a.ts", startLine: 190, endLine: 190 }], secondLookHunks: [{ file: "a.ts", startLine: 10, endLine: 10 }] } as unknown as RoundRecord;
  const entry = { kind: "second-look" as const, files: ["a.ts"] };
  const legit = "--- a.ts\n@@ 9,11 @@\n x\n-old\n+new\n y\n";
  const forged = "--- a.ts\n@@ 189,191 @@\n x\n-old\n+changed in the delta\n y\n";
  const mixed = "--- a.ts\n@@ 9,191 @@\n x\n-old\n+new\n y\n";
  expect(secondLookClaimBacked(entry, { round, prior: [] }, legit)).toBe(true);
  expect(secondLookClaimBacked(entry, { round, prior: [] }, forged)).toBe(false);
  expect(secondLookClaimBacked(entry, { round, prior: [] }, `${legit}\n${forged}`)).toBe(false);
  expect(mixed.length).toBeGreaterThan(0);
  expect(secondLookClaimBacked(entry, { round: { ...round, secondLookHunks: [] }, prior: [] }, legit)).toBe(false);
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keryx-l6-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("waves are packed per slice kind, so a dispatch never mixes fix, second-look and new", async () => {
  const slice = (id: string, kind: NonNullable<SliceEntry["kind"]>): SliceEntry => ({ id, path: `${id}.diff`, bytes: 100, files: [`${id}.ts`], domain: "d", split: "domain", roles: ["review-logic"], depth: "deep", kind });
  const manifest: SliceManifest = { schemaVersion: 1, maxBytes: 10_000, waveBytes: 10_000, source: "diff", slices: [slice("slice-01", "fix"), slice("slice-02", "new"), slice("slice-03", "second-look")], omissions: [], totals: { slices: 3, bytes: 300, files: 3, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 } };
  const pkg = path.join(dir, ".metaproject", "reviews", "r");
  mkdirSync(path.join(pkg, "slices"), { recursive: true });
  const written = await writeWaveDrivers({ packageDir: pkg, manifest, sliceDir: path.join(pkg, "slices"), reviewers: ["review-logic"] });
  expect(written).toHaveLength(3);
  const kinds = written.map((file) => (JSON.parse(readFileSync(file, "utf8")) as { slices: string[] }).slices);
  expect(kinds).toEqual([["slice-01"], ["slice-03"], ["slice-02"]]);
});

test("an explicit base is kept even when it gives an empty range", async () => {
  const run = (...args: string[]): void => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_COMMITTER_NAME: "t", GIT_AUTHOR_EMAIL: "200531777+MrCipherSmith@users.noreply.github.com", GIT_COMMITTER_EMAIL: "200531777+MrCipherSmith@users.noreply.github.com" };
    const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  run("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "f.txt"), "1\n");
  run("add", "f.txt");
  run("commit", "-q", "-m", "one");
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();
  run("checkout", "-q", "-b", "other");
  writeFileSync(path.join(dir, "f.txt"), "2\n");
  run("commit", "-q", "-am", "two");
  const second = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();
  // --base other == head `second`: an empty range, and main would give a non-empty one; the explicit base wins.
  const resolved = await resolveBase(defaultGitRunner(dir), { kind: "pr", ref: "7", base: "other" }, second);
  expect(resolved).toMatchObject({ ref: "other", sha: second });
  expect(head).not.toBe(second);
});
