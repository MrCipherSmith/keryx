// Flow 234 T21 - CLI-level coverage for findings 1 and 2 closed in this task:
//
// - Finding 1 (blocker): `keryx test run --strict` over a tree it could not
//   fully read must not report a clean PASS. The report must carry the
//   testing-context status/reasons, render them, and a strict run must fail.
// - Finding 2 (major): `keryx test related <file>` is a read-only question and
//   must not write the testing-context snapshot to disk.
//
// `keryx test suggest` (the concurrent analyze+related call site named in
// finding 2's second-order issue) is intentionally NOT exercised here: it
// calls a model provider via `narrate()`, and this suite must not perform
// network calls. Its fix (compute the context once, read-only, and share it -
// see `runSuggest` in ./test.ts) is covered by the service-level tests in
// `../testing/service.test.ts` for `computeTestingContext`/`relatedTestsInContext`,
// the exact functions `runSuggest` now calls.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testCommand } from "./test";

let cwd = "";
let originalCwd = "";
let originalLog: typeof console.log;
let originalError: typeof console.error;
let captured: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "keryx-test-command-"));
  originalCwd = process.cwd();
  process.chdir(cwd);
  captured = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  process.exitCode = undefined;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
  process.exitCode = undefined;
});

test("keryx test run --strict reports FAIL, not PASS, when the testing context could not be fully refreshed", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src", "locked"), { recursive: true });
  writeFileSync(
    path.join(cwd, "src", "visible.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
  );
  writeFileSync(path.join(cwd, "src", "locked", "hidden.test.ts"), "test.todo('hidden');\n");
  chmodSync(path.join(cwd, "src", "locked"), 0o000);

  try {
    await testCommand(["run", "--strict", "--scope", "src/visible"]);

    const output = captured.join("\n");
    expect(output).toContain("# Test Report: FAIL");
    expect(output).toContain("context: incomplete");
    expect(process.exitCode).toBe(1);
  } finally {
    chmodSync(path.join(cwd, "src", "locked"), 0o755);
  }
});

test("keryx test related <file> does not write the testing context snapshot (read-only query)", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "mod1.ts"), "export const mod1 = 1;\n");

  const dataRoot = path.join(cwd, ".metaproject", "data", "testing");

  await testCommand(["related", "src/mod1.ts"]);

  expect(captured.join("\n")).toContain("related tests: src/mod1.ts");
  expect(existsSync(path.join(dataRoot, "context.json"))).toBe(false);
  expect(existsSync(path.join(dataRoot, "context.md"))).toBe(false);
  expect(existsSync(path.join(dataRoot, "recommendations.md"))).toBe(false);
});
