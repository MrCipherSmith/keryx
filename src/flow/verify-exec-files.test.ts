// Flow 441 AC18: every `[verify: exec ...]` line in a flow's acceptance-criteria.md must name test files that exist.
// `bun test` skips a missing file when the command also names other test files, so the gate passes without running it.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const FLOWS_DIR = path.join(REPO_ROOT, ".metaproject", "flows");
const EXEC_LINE = /\[verify:\s*exec\s+`([^`]+)`/g;
const TEST_FILE = /(?:^|\s)((?:\.\/)?[\w./@-]+\.test\.tsx?)(?=\s|$)/g;

// Flow 375 froze verify commands for board tests that were never written under these names.
// Frozen criteria are not edited here; the operator decides whether to write the tests or re-seal the criteria.
const KNOWN_MISSING: Record<string, readonly string[]> = {
  "375-2026-10-01-product-board": [
    "src/product/board.test.ts",
    "src/product/board-stale.test.ts",
    "src/product/board-model.test.ts",
    "src/product/board-dashboard.test.ts",
  ],
};

function namedTestFiles(command: string): string[] {
  return [...command.matchAll(TEST_FILE)].map((m) => m[1]!.replace(/^\.\//, ""));
}

function missingByFlow(): Map<string, Set<string>> {
  const missing = new Map<string, Set<string>>();
  for (const entry of readdirSync(FLOWS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const acFile = path.join(FLOWS_DIR, entry.name, "acceptance-criteria.md");
    if (!existsSync(acFile)) continue;
    for (const line of readFileSync(acFile, "utf8").split("\n")) {
      for (const exec of line.matchAll(EXEC_LINE)) {
        for (const file of namedTestFiles(exec[1]!)) {
          if (existsSync(path.join(REPO_ROOT, file))) continue;
          if (!missing.has(entry.name)) missing.set(entry.name, new Set());
          missing.get(entry.name)!.add(file);
        }
      }
    }
  }
  return missing;
}

test("every flow verify-exec line names test files that exist", () => {
  const unexpected: string[] = [];
  for (const [flow, files] of missingByFlow()) {
    const allowed = new Set(KNOWN_MISSING[flow] ?? []);
    for (const file of files) if (!allowed.has(file)) unexpected.push(`${flow}: ${file}`);
  }
  expect(unexpected).toEqual([]);
});

test("the known-missing list holds only files that are still missing", () => {
  const missing = missingByFlow();
  const stale: string[] = [];
  for (const [flow, files] of Object.entries(KNOWN_MISSING)) {
    for (const file of files) if (!missing.get(flow)?.has(file)) stale.push(`${flow}: ${file}`);
  }
  expect(stale).toEqual([]);
});

test("the scan recognises exec lines and test-file tokens", () => {
  const line = "- AC2: x. [verify: exec `bun test src/a/b.test.ts ./src/c.test.tsx --timeout 5`]";
  const found = [...line.matchAll(EXEC_LINE)].flatMap((m) => namedTestFiles(m[1]!));
  expect(found).toEqual(["src/a/b.test.ts", "src/c.test.tsx"]);
});
