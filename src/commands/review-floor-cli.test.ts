// `keryx review floor` through the CLI (flow 258, T11).
//
// `src/review/floor.test.ts` proves the detections. This proves the only things
// a detector cannot: that the subcommand is reachable, that a finding actually
// moves the exit code, that `--report-only` moves it back, and that a misspelled
// flag is refused rather than dropped. A guard whose exit code is always 0 is a
// guard nothing can be wired to, and that is invisible from inside the module.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import type { FloorReport } from "../review/floor";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let logs: string[] = [];
let errors: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-floor-"));
  process.chdir(ROOT);
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

/** A diff on disk, which is how the command is driven without a git repository. */
async function diffFile(name: string, body: string): Promise<string> {
  const file = path.join(ROOT, name);
  await writeFile(file, body, "utf8");
  return file;
}

const WEAKENED = [
  "diff --git a/jest.config.js b/jest.config.js",
  "--- a/jest.config.js",
  "+++ b/jest.config.js",
  "@@ -10,4 +10,4 @@",
  " coverageThreshold: {",
  "-    minCoverage: 80,",
  "+    minCoverage: 70,",
  " }",
  "",
].join("\n");

const ORDINARY = [
  "diff --git a/src/refund.ts b/src/refund.ts",
  "--- a/src/refund.ts",
  "+++ b/src/refund.ts",
  "@@ -20,3 +20,4 @@",
  " export function refund(order: Order): Refund {",
  "+  const reference = createReference(order.id);",
  "   return ledger.refund(order);",
  " }",
  "",
].join("\n");

test("a finding fails the command", async () => {
  const file = await diffFile("weakened.diff", WEAKENED);
  await reviewCommand(["floor", "--diff", file]);

  expect(process.exitCode).toBe(1);
  expect(logs.join("\n")).toContain("minCoverage");
  expect(errors.join("\n")).toContain("threshold-lowered=1");
});

test("a diff that lowers nothing exits 0 and says what it scanned", async () => {
  const file = await diffFile("ordinary.diff", ORDINARY);
  await reviewCommand(["floor", "--diff", file]);

  expect(process.exitCode).toBe(0);
  // "nothing found" over nothing scanned is a different fact, and the report
  // has to be able to tell them apart.
  expect(logs.join("\n")).toContain("regions_scanned: 1");
  expect(logs.join("\n")).toContain("findings: 0");
});

test("--report-only prints the same finding and exits 0", async () => {
  const file = await diffFile("weakened.diff", WEAKENED);
  await reviewCommand(["floor", "--diff", file, "--report-only"]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("threshold-lowered");
  expect(errors.join("\n")).toContain("--report-only");
});

test("--json prints the report and nothing else", async () => {
  const file = await diffFile("weakened.diff", WEAKENED);
  await reviewCommand(["floor", "--diff", file, "--json"]);

  const parsed = JSON.parse(logs.join("\n")) as FloorReport;
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.counts.total).toBe(1);
  expect(parsed.findings[0]?.kind).toBe("threshold-lowered");
  expect(parsed.findings[0]?.path).toBe("jest.config.js");
  // Still a failure: the machine-readable form must not be the quiet one.
  expect(process.exitCode).toBe(1);
});

test("an unknown flag is refused rather than ignored", async () => {
  const file = await diffFile("weakened.diff", WEAKENED);
  await reviewCommand(["floor", "--diff", file, "--fail-never"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--fail-never");
  // Refused BEFORE the report: an operator who guessed a flag that turns the
  // guard off must not also be told the guard passed.
  expect(logs.join("\n")).not.toContain("Floor guard");
});

test("the subcommand is listed in `keryx review --help`", async () => {
  await reviewCommand(["--help"]);
  expect(logs.join("\n")).toContain("keryx review floor");
  expect(process.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// `--ref` resolves through the merge base
// ---------------------------------------------------------------------------
//
// These two are the only tests here that build a real repository, because the
// thing under test IS the git resolution and a diff on disk cannot exercise it.
//
// The defect they pin was measured, not imagined: on `skills/skill-gaps`, two
// commits behind `origin/main`, `floor --ref origin/main` reported two
// `assertion-removed` findings in files no commit of the branch touches. `git
// diff <ref>` is two-dot, so the base's own additions came back inverted as the
// branch's removals — a guard demanding a justification, in the diff, for a
// change that is not in the diff.
//
// They come as a pair on purpose. The first alone would pass against a `floor`
// that had simply been broken into silence.

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

const ONE_ASSERTION = 'test("a", () => {\n  expect(one()).toBe(1);\n});\n';
const FOUR_ASSERTIONS =
  'test("a", () => {\n  expect(one()).toBe(1);\n  expect(two()).toBe(2);\n  expect(three()).toBe(3);\n  expect(four()).toBe(4);\n});\n';

/** A repo forked at `base`, where the two sides have since moved apart. */
async function forkedRepo(options: { onBase: string; onBranch: string }): Promise<void> {
  await git("init", "-q", "-b", "main", ".");
  await git("config", "user.email", "floor@test.invalid");
  await git("config", "user.name", "floor");
  await writeFile(path.join(ROOT, "thing.test.ts"), ONE_ASSERTION, "utf8");
  await git("add", "thing.test.ts");
  await git("commit", "-qm", "base");

  await git("checkout", "-q", "-b", "feature");
  await writeFile(path.join(ROOT, "thing.test.ts"), options.onBranch, "utf8");
  // Work of the branch's own, in a file neither side of this test looks at, so
  // the branch has a real commit even when it leaves `thing.test.ts` alone.
  await writeFile(path.join(ROOT, "note.ts"), "export const note = 1;\n", "utf8");
  await git("add", "thing.test.ts", "note.ts");
  await git("commit", "-qm", "feature work");

  // The base moves on AFTER the fork — this is the condition the bug needed.
  await git("checkout", "-q", "main");
  await writeFile(path.join(ROOT, "thing.test.ts"), options.onBase, "utf8");
  await git("add", "thing.test.ts");
  await git("commit", "-qm", "main gains assertions");

  await git("checkout", "-q", "feature");
}

test("assertions the BASE gained after the fork are not reported as this branch's removals", async () => {
  // The branch leaves the file exactly as it forked it. Every difference
  // between `main` and here belongs to `main`.
  await forkedRepo({ onBase: FOUR_ASSERTIONS, onBranch: ONE_ASSERTION });

  await reviewCommand(["floor", "--ref", "main", "--json"]);

  const parsed = JSON.parse(logs.join("\n")) as FloorReport;
  // Against the pre-fix two-dot resolution this is 1: `assertion-removed`,
  // 3 assertions, in a file this branch never touched.
  expect(parsed.counts.total).toBe(0);
  expect(parsed.findings).toEqual([]);
  expect(process.exitCode).toBe(0);
});

test("an assertion this branch removed is still reported", async () => {
  // The converse, and the reason the fix is not just "report less". The base
  // moves the same way, but the branch ALSO cut two assertions of its own.
  await forkedRepo({
    onBase: FOUR_ASSERTIONS,
    onBranch: 'test("a", () => {\n});\n',
  });

  await reviewCommand(["floor", "--ref", "main", "--json"]);

  const parsed = JSON.parse(logs.join("\n")) as FloorReport;
  expect(parsed.counts.byKind["assertion-removed"]).toBe(1);
  expect(parsed.findings[0]?.path).toBe("thing.test.ts");
  // One removal, from the fork point — not four, which is what counting against
  // `main`'s tip would have produced.
  expect(parsed.findings[0]?.detail).toContain("removes 1 assertion-carrying line(s)");
  expect(process.exitCode).toBe(1);
});

test("a ref that shares no history with HEAD is refused, not silently diffed", async () => {
  await forkedRepo({ onBase: FOUR_ASSERTIONS, onBranch: ONE_ASSERTION });
  await git("checkout", "-q", "--orphan", "unrelated");
  await git("commit", "-qm", "unrelated root", "--allow-empty");
  await git("checkout", "-q", "feature");

  await reviewCommand(["floor", "--ref", "unrelated"]);

  // Falling back to the raw ref here is exactly the bug, so it stops instead.
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("merge base");
  expect(logs.join("\n")).not.toContain("Floor guard");
});
