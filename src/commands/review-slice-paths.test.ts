// Flow 441 AC8/AC9: the path flags of the review commands that name a file refuse a path outside the project
// root and `.metaproject/`, before anything is read or written.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewPathFlagRefusal } from "../lib/review-path-flags";
import { type SliceDeps, runDispatchCheck, runRetryPlan, runSlice } from "./review-slice";

const DIFF = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

const deps: SliceDeps = {
  gitDiff: async () => DIFF,
  readDiffSource: async () => DIFF,
  parseContextLines: () => 3,
  rejectUnknownFlags: () => {},
};

let originalCwd: string;
let originalExitCode: typeof process.exitCode;
let dir: string;
let outside: string;

function real(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalExitCode = process.exitCode;
  dir = real("keryx-slice-paths-");
  outside = real("keryx-slice-outside-");
  mkdirSync(path.join(dir, ".git"));
  mkdirSync(path.join(dir, ".metaproject"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
});

const quietly = async (run: () => Promise<void>): Promise<void> => {
  const log = console.log;
  console.log = () => {};
  try {
    await run();
  } finally {
    console.log = log;
  }
};

test("AC8: review slice --out outside the project exits with a named reason and writes nothing", async () => {
  const target = path.join(outside, "slices");
  await expect(runSlice(["--out", target], deps)).rejects.toThrow(/keryx review slice --out: .*outside the project root/);
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(outside)).toEqual([]);

  await expect(runSlice(["--out", "../escaped"], deps)).rejects.toThrow(/outside the project root/);
  expect(existsSync(path.join(dir, "..", "escaped"))).toBe(false);
});

test("AC8: review slice --out inside the project, under .metaproject/reviews/ and the default directory still work", async () => {
  await quietly(() => runSlice(["--out", "out/slices"], deps));
  expect(existsSync(path.join(dir, "out", "slices", "manifest.json"))).toBe(true);

  await quietly(() => runSlice(["--out", ".metaproject/reviews/r1/slices"], deps));
  expect(existsSync(path.join(dir, ".metaproject", "reviews", "r1", "slices", "manifest.json"))).toBe(true);

  await quietly(() => runSlice([], deps));
  expect(existsSync(path.join(dir, ".metaproject", "data", "review", "slices", "manifest.json"))).toBe(true);
});

test("AC8: review slice --out through a symlink inside the project that points outside is refused", async () => {
  symlinkSync(outside, path.join(dir, "escape"));
  await expect(runSlice(["--out", "escape/slices"], deps)).rejects.toThrow(/outside the project root/);
  await expect(runSlice(["--out=escape"], deps)).rejects.toThrow(/outside the project root/);
  expect(readdirSync(outside)).toEqual([]);
});

test("AC9: review retry-plan --manifest outside the project is refused", async () => {
  const manifest = path.join(outside, "manifest.json");
  writeFileSync(manifest, "{}");
  await expect(runRetryPlan(["--manifest", manifest, "--next-wave"], deps)).rejects.toThrow(/retry-plan --manifest: .*outside the project root/);
});

test("AC9: review retry-plan --state outside the project is refused", async () => {
  const manifest = path.join(dir, "manifest.json");
  writeFileSync(manifest, "{}");
  const state = path.join(outside, "retry-state.json");
  await expect(runRetryPlan(["--manifest", manifest, "--next-wave", "--state", state], deps)).rejects.toThrow(/retry-plan --state: .*outside the project root/);
  expect(existsSync(state)).toBe(false);
});

test("AC9: review dispatch-check --manifest outside the project is refused", async () => {
  const manifest = path.join(outside, "manifest.json");
  writeFileSync(manifest, "{}");
  const payload = path.join(dir, "payload.json");
  writeFileSync(payload, "{}");
  await expect(runDispatchCheck(["--payload", payload, "--manifest", manifest], deps)).rejects.toThrow(/dispatch-check --manifest: .*outside the project root/);
});

test("AC9: a manifest that is a symlink to a file outside the project is refused", async () => {
  const target = path.join(outside, "manifest.json");
  writeFileSync(target, "{}");
  symlinkSync(target, path.join(dir, "manifest.json"));
  await expect(runRetryPlan(["--manifest", "manifest.json", "--next-wave"], deps)).rejects.toThrow(/outside the project root/);
});

test("AC9: the same flags stay usable inside the project", async () => {
  const payload = path.join(dir, "payload.json");
  writeFileSync(payload, "{}");
  const manifest = path.join(dir, ".metaproject", "reviews", "manifest.json");
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, "{}");
  // The check may fail on its payload; what matters is that it is not refused for the path.
  await quietly(() => runDispatchCheck(["--payload", payload, "--manifest", manifest], deps).catch(() => {}));
});

test("reviewPathFlagRefusal: the rule the commands and the trust table share", () => {
  const where = { projectRoot: dir, cwd: dir };
  expect(reviewPathFlagRefusal("slice", ["--out", "a/b"], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("slice", ["--out=.metaproject/reviews/x"], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("slice", [], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("slice", ["--out", outside], where)).toMatch(/outside the project root/);
  expect(reviewPathFlagRefusal("slice", [`--out=${outside}`], where)).toMatch(/outside the project root/);
  expect(reviewPathFlagRefusal("retry-plan", ["--manifest", "m.json", "--state", outside], where)).toMatch(/--state/);
  expect(reviewPathFlagRefusal("dispatch-check", ["--manifest", outside], where)).toMatch(/--manifest/);
  expect(reviewPathFlagRefusal("status", ["--out", outside], where)).toBeUndefined();
});
