// Source audit (review round 1, R1-F1 + R1-F7; widened round 2, R2-F4):
// every writer besides `store.ts` itself must go through the choke point
// (`updatePattern` for an existing record, `createPattern` for a brand new
// one) rather than calling `writePattern`/`writeIndex` directly. Both
// primitives still exist and are still exported from `store.ts` itself —
// `store.test.ts` exercises them directly, as the low-level primitives' own
// unit tests, and other `*.test.ts` files use them as plain fixture-seeding
// helpers (writing a record straight to disk to set up a scenario, not
// modeling a production write path) — this audit therefore only scans
// non-test `.ts` files, matching the existing `exit-guard.test.ts` "source
// audit" convention (`isTestFile`).
//
// R2-F4 widened this two ways: the scan now walks all of `src/**`, not just
// `src/learning/` (the facade — `index.ts`/`service.ts` — no longer
// re-exports either primitive, so an outside caller could otherwise only
// reach them via a deep, non-facade import, which this scan also catches),
// and the match pattern is a plain word-boundary regex over BOTH names
// (`\bwritePattern\b|\bwriteIndex\b`) so it also flags an aliased import
// (`import { writePattern as wp }`) or a reference used as a value
// (`const f = writePattern；await f(...)`), not just a direct call
// expression.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.join(__dirname, "..", "..", "src");
const STORE_TS_RELATIVE = "src/learning/store.ts";

function isTestFile(name: string): boolean {
  return /\.(test|smoke|bench)\.tsx?$/.test(name);
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !isTestFile(entry.name)) out.push(full);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/**");
}

// R2-F4: a plain word-boundary reference to either raw primitive name — not
// just a call expression (`writePattern(`) — so an aliased import
// (`writePattern as wp`), a value reference used later (`const f =
// writePattern; await f(...)`), or a parenthesized-then-called form
// (`await (writePattern)(...)`) is caught too, not only the direct-call
// shape the round-1 regex matched.
const RAW_WRITE_REFERENCE_PATTERN = /\bwritePattern\b|\bwriteIndex\b/;

describe("source audit: only store.ts references the raw writePattern/writeIndex (R1-F1/R1-F7/R2-F4 choke point)", () => {
  test("no other non-test .ts file under src/ references writePattern or writeIndex", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const offenders: { file: string; lines: number[] }[] = [];

    for (const file of files) {
      const relative = path.relative(path.join(SRC_ROOT, ".."), file).split(path.sep).join("/");
      if (relative === STORE_TS_RELATIVE) continue;

      const content = readFileSync(file, "utf8");
      const matchedLines: number[] = [];
      content.split("\n").forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (RAW_WRITE_REFERENCE_PATTERN.test(line)) matchedLines.push(index + 1);
      });
      if (matchedLines.length > 0) offenders.push({ file: relative, lines: matchedLines });
    }

    expect(offenders).toEqual([]);
  });

  test("self-check: the scan pattern actually matches a plausible bypass line", () => {
    expect(RAW_WRITE_REFERENCE_PATTERN.test('  await writePattern(root, updated, storeOptions);')).toBe(true);
    expect(RAW_WRITE_REFERENCE_PATTERN.test('  await writeIndex(next, storeOptions);')).toBe(true);
  });

  test("self-check: the scan pattern catches alias/value-reference bypass shapes", () => {
    expect(RAW_WRITE_REFERENCE_PATTERN.test('import { writePattern as wp } from "../learning/store";')).toBe(true);
    expect(RAW_WRITE_REFERENCE_PATTERN.test('const f = writePattern; await f(root, r);')).toBe(true);
    expect(RAW_WRITE_REFERENCE_PATTERN.test('await (writePattern)(root, r);')).toBe(true);
  });

  test("self-check: the scan pattern does not flag updatePattern(/createPattern( calls", () => {
    expect(RAW_WRITE_REFERENCE_PATTERN.test('  await updatePattern(root, id, scope, mutator, storeOptions);')).toBe(false);
    expect(RAW_WRITE_REFERENCE_PATTERN.test('  await createPattern(root, record, storeOptions);')).toBe(false);
  });

  test("self-check: the scan pattern does not flag a comment mentioning writePattern", () => {
    expect(isCommentLine('// through the choke point instead of calling writePattern( directly')).toBe(true);
  });
});
