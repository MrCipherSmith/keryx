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
