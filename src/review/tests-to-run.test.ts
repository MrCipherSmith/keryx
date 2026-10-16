// Flow 457: the run list a package carries for the tests its blast radius reached.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TESTS_TO_RUN_FILE, detectTestCommand, writeTestsToRun } from "./tests-to-run";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keryx-tests-to-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the test command is read off the project: bun, npm, or unknown", () => {
  expect(detectTestCommand(dir)).toBeUndefined();
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  expect(detectTestCommand(dir)).toBe("npm test --");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test src" } }));
  expect(detectTestCommand(dir)).toBe("bun test");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  expect(detectTestCommand(dir)).toBeUndefined();
  writeFileSync(path.join(dir, "bun.lock"), "");
  expect(detectTestCommand(dir)).toBe("bun test");
});

test("tests-to-run.json lists file, reason and symbols for every test on the run list", async () => {
  const written = await writeTestsToRun(dir, {
    testsToRun: [
      { file: "src/a.test.ts", reason: "graph-consumer", symbols: ["alpha"], via: "src/a.ts" },
      { file: "src/b.test.ts", reason: "related-test", symbols: [], via: "src/b.ts" },
    ],
  });
  expect(written).toBe(path.join(dir, TESTS_TO_RUN_FILE));
  expect(JSON.parse(readFileSync(written, "utf8"))).toEqual([
    { file: "src/a.test.ts", reason: "graph-consumer", symbols: ["alpha"] },
    { file: "src/b.test.ts", reason: "related-test", symbols: [] },
  ]);
  await writeTestsToRun(dir, {});
  expect(JSON.parse(readFileSync(written, "utf8"))).toEqual([]);
});
