// Source audit (review round 1, R1-F1 + R1-F7): every writer under
// `src/learning/` besides `store.ts` itself must go through the choke point
// (`updatePattern` for an existing record, `createPattern` for a brand new
// one) rather than calling `writePattern` directly. `writePattern` still
// exists and is still exported — `store.test.ts` exercises it directly, as
// the low-level primitive's own unit tests, and other `*.test.ts` files use
// it as a plain fixture-seeding helper (writing a record straight to disk to
// set up a scenario, not modeling a production write path) — this audit
// therefore only scans non-test `.ts` files, matching the existing
// `exit-guard.test.ts` "source audit" convention (`isTestFile`).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const LEARNING_ROOT = __dirname;

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

// Matches a call `writePattern(` — as an identifier, not `updatePattern(`/
// `createPattern(`/`writePatternX(` etc. (word-boundary on the left).
const RAW_WRITE_CALL_PATTERN = /(?<![\w.])writePattern\s*\(/;

describe("source audit: only store.ts calls the raw writePattern (R1-F1/R1-F7 choke point)", () => {
  test("no other non-test .ts file under src/learning/ calls writePattern(", () => {
    const files = collectSourceFiles(LEARNING_ROOT);
    const offenders: { file: string; lines: number[] }[] = [];

    for (const file of files) {
      const relative = path.relative(path.join(LEARNING_ROOT, "..", ".."), file).split(path.sep).join("/");
      if (relative === "src/learning/store.ts") continue;

      const content = readFileSync(file, "utf8");
      const matchedLines: number[] = [];
      content.split("\n").forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (RAW_WRITE_CALL_PATTERN.test(line)) matchedLines.push(index + 1);
      });
      if (matchedLines.length > 0) offenders.push({ file: relative, lines: matchedLines });
    }

    expect(offenders).toEqual([]);
  });

  test("self-check: the scan pattern actually matches a plausible bypass line", () => {
    expect(RAW_WRITE_CALL_PATTERN.test('  await writePattern(root, updated, storeOptions);')).toBe(true);
  });

  test("self-check: the scan pattern does not flag updatePattern(/createPattern( calls", () => {
    expect(RAW_WRITE_CALL_PATTERN.test('  await updatePattern(root, id, scope, mutator, storeOptions);')).toBe(false);
    expect(RAW_WRITE_CALL_PATTERN.test('  await createPattern(root, record, storeOptions);')).toBe(false);
  });

  test("self-check: the scan pattern does not flag a comment mentioning writePattern", () => {
    expect(isCommentLine('// through the choke point instead of calling writePattern( directly')).toBe(true);
  });
});
