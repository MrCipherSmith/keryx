// Flow 234 T21 - CLI-level coverage for findings 1 and 2 closed in this task:
//
// - Finding 1 (blocker): `keryx test run --strict` over a tree it could not
//   fully read must not report a clean PASS. The report must carry the
//   testing-context status/reasons, render them, and a strict run must fail.
// - Finding 2 (major): `keryx test related <file>` is a read-only question and
//   must not write the testing-context snapshot to disk.
//
// Flow 234 T27 - two more members of the same class (F-016), plus the sibling
// "same report reads two ways" finding (F-017):
//
// - F-016: `keryx test explain <file>` (below) called `findRelatedTests`,
//   which computes the testing context internally and discards its
//   `status`/`incompleteReasons` - fixed the same way `test related` was
//   fixed under T21 (compute once, read-only, render the status).
// - F-016, second member: `keryx test suggest` already computed the context
//   read-only (T21 finding 2's fix) but discarded `context.status` before the
//   prompt it builds for the model. Fixed by adding a "Testing context: ..."
//   line to the prompt in `runSuggest` (./test.ts). NOT exercised here: it
//   calls a model provider via `narrate()`, and this suite must not perform
//   network calls. Its context-computation half is covered by the
//   service-level tests in `../testing/service.test.ts` for
//   `computeTestingContext`/`relatedTestsInContext`, the exact functions
//   `runSuggest` calls; the prompt-assembly line itself was verified by
//   reading (see the T27 report), not driven end-to-end.
// - F-017: `keryx test status` (below) rendered `report.status` without ever
//   looking at `report.context`, so the same on-disk report could read as a
//   clean "latest status: pass" here while `keryx test report latest` (which
//   already rendered `report.context`) said `context: incomplete`.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testCommand } from "./test";

function git(gitCwd: string, args: string[]): void {
  execFileSync("git", args, { cwd: gitCwd, stdio: "ignore" });
}

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

// Flow 234 T27 - F-016 (major): `keryx test explain <file>` answered "what
// tests relate to this file" the same way `keryx test related` used to before
// T21 - by calling `findRelatedTests`, which computes the testing context
// internally and discards its `status`/`incompleteReasons`. A refresh that
// could not fully walk the tree (e.g. a permission-denied subdirectory) must
// not be indistinguishable from a clean "these are all the related tests"
// answer here either.
test("keryx test explain <file> surfaces the testing-context status (incomplete, with reason)", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src", "locked"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(
    path.join(cwd, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  writeFileSync(path.join(cwd, "src", "locked", "hidden.test.ts"), "test.todo('hidden');\n");
  chmodSync(path.join(cwd, "src", "locked"), 0o000);

  try {
    await testCommand(["explain", "src/a.ts"]);

    const output = captured.join("\n");
    expect(output).toContain("context: incomplete");
    expect(output).toContain("EACCES");
    expect(output).toContain("related tests: 1");
  } finally {
    chmodSync(path.join(cwd, "src", "locked"), 0o755);
  }
});

// Flow 234 T27 - F-017 (minor): `keryx test status` rendered `report.status`
// ("latest status: pass") without ever looking at `report.context` - the same
// report `keryx test report latest` already renders with `context: incomplete`
// (see runReport). Same file on disk, two surfaces, opposite impressions.
test("keryx test status surfaces the same report's context status as keryx test report latest", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src", "locked"), { recursive: true });
  writeFileSync(
    path.join(cwd, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  writeFileSync(path.join(cwd, "src", "locked", "hidden.test.ts"), "test.todo('hidden');\n");
  chmodSync(path.join(cwd, "src", "locked"), 0o000);

  try {
    // No --strict: the run itself still reports PASS even though the context
    // refresh it used was incomplete (see src/testing/service.ts: the strict
    // gate is the only place `context.status === "incomplete"` flips `status`
    // to "fail" - AFC-09 / flow 234 T21 finding 1).
    await testCommand(["run", "--scope", "src/a"]);
    captured = [];

    await testCommand(["status"]);
    const statusOutput = captured.join("\n");
    expect(statusOutput).toContain("latest status: pass");
    expect(statusOutput).toContain("latest run context: incomplete");
    expect(statusOutput).toContain("EACCES");

    captured = [];
    await testCommand(["report", "latest"]);
    const reportOutput = captured.join("\n");
    expect(reportOutput).toContain("# Test Report: PASS");
    expect(reportOutput).toContain("context: incomplete");
  } finally {
    chmodSync(path.join(cwd, "src", "locked"), 0o755);
  }
});

// Flow 234, orchestrator follow-up to T27. Its enumeration named two further
// members of the same class and left them, correctly, as out of the findings
// it was given. They are closed here rather than left for a sixth round: this
// class has survived by being repaired one member at a time.
test("keryx test context surfaces the status of the walk that produced it", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src", "locked"), { recursive: true });
  writeFileSync(
    path.join(cwd, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  writeFileSync(path.join(cwd, "src", "locked", "hidden.test.ts"), "test.todo('hidden');\n");
  chmodSync(path.join(cwd, "src", "locked"), 0o000);

  try {
    await testCommand(["analyze"]);
    captured = [];
    await testCommand(["context"]);

    const output = captured.join("\n");
    expect(output).toContain("status: incomplete");
    expect(output).toContain("EACCES");
  } finally {
    chmodSync(path.join(cwd, "src", "locked"), 0o755);
  }
});

test("keryx test coverage-map build says whether the file set behind the map was complete", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src", "locked"), { recursive: true });
  writeFileSync(
    path.join(cwd, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  writeFileSync(path.join(cwd, "src", "locked", "hidden.test.ts"), "test.todo('hidden');\n");
  chmodSync(path.join(cwd, "src", "locked"), 0o000);

  try {
    await testCommand(["coverage-map", "build"]);

    const output = captured.join("\n");
    // A map built from a partly-walked tree is smaller than the truth and
    // otherwise looks exactly like a small project.
    expect(output).toContain("context: incomplete");
    expect(output).toContain("EACCES");
  } finally {
    chmodSync(path.join(cwd, "src", "locked"), 0o755);
  }
});

// ---------------------------------------------------------------------------
// Flow 237 T6 defect 3 (AFC-28/AC-28, "a different checkout or consumer sees
// changed grounds before it acts"): `keryx test status` (runStatus, ./test.ts)
// printed `latest status: pass` with no qualifier at all saying whether that
// pass still corresponds to the tree on disk. A report generated yesterday
// against a since-modified working tree (or a tree that has moved to a new
// commit since) read exactly the same as a report generated one second ago
// against the current tree — a genuinely different set of grounds with no
// visible difference to the reader acting on it.
// ---------------------------------------------------------------------------

test("keryx test status flags a report as possibly stale when the working tree has changed since the run (uncommitted changes)", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(
    path.join(cwd, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@test.com"]);
  git(cwd, ["config", "user.name", "test"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "initial"]);

  await testCommand(["run", "--scope", "src/a"]);
  captured = [];

  // The grounds change: a new, uncommitted file appears in the working tree
  // after the report was generated (HEAD has not moved — a plain gitRef
  // comparison alone would miss this).
  writeFileSync(path.join(cwd, "src", "b.ts"), "export const b = 2;\n");

  await testCommand(["status"]);
  const output = captured.join("\n");

  expect(output).toContain("latest status: pass");
  // The defect: before the fix there was no line saying the working tree no
  // longer matches what the report was generated against.
  expect(output.toLowerCase()).toContain("stale");
  expect(output.toLowerCase()).toContain("uncommitted");
});

test("keryx test status flags a report as possibly stale when HEAD has moved since the run (new commit)", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(
    path.join(cwd, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@test.com"]);
  git(cwd, ["config", "user.name", "test"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "initial"]);

  await testCommand(["run", "--scope", "src/a"]);
  captured = [];

  writeFileSync(path.join(cwd, "src", "b.ts"), "export const b = 2;\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "a new commit after the test run"]);

  await testCommand(["status"]);
  const output = captured.join("\n");

  expect(output).toContain("latest status: pass");
  expect(output.toLowerCase()).toContain("stale");
  expect(output).toContain("gitRef");
});

test("keryx test status reports the report as current when gitRef matches and the tree is clean", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(
    path.join(cwd, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@test.com"]);
  git(cwd, ["config", "user.name", "test"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "initial"]);

  await testCommand(["run", "--scope", "src/a"]);
  captured = [];

  await testCommand(["status"]);
  const output = captured.join("\n");

  expect(output).toContain("latest status: pass");
  expect(output.toLowerCase()).not.toContain("stale");
});

// Flow 237 T11 (F3): the same defect class, inside the function T6 added to
// fix it. `isWorkingTreeDirty` returns `boolean | null` and `null` means "the
// check could not run" — but the caller tested `if (dirty)`, so `null` was
// falsy, added no reason, and `keryx test status` printed
// "current (gitRef matches, working tree clean)" about a working tree it had
// just failed to read.
//
// The breakage here is real, not mocked: a corrupt `.git/index` leaves
// `git rev-parse HEAD` working (so the gitRef half still MATCHES and cannot
// carry the finding) while `git status` exits 128 — the exact shape that made
// the old code assert a clean tree.
test("keryx test status says unknown — not current — when git status cannot run (corrupt .git/index)", async () => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(
    path.join(cwd, "src", "a.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  );
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@test.com"]);
  git(cwd, ["config", "user.name", "test"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "initial"]);

  await testCommand(["run", "--scope", "src/a"]);
  captured = [];

  writeFileSync(path.join(cwd, ".git", "index"), "GARBAGE-NOT-AN-INDEX");
  // Precondition of the case: HEAD still resolves, so the gitRef comparison
  // still succeeds and only the working-tree check is broken.
  expect(
    execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim().length,
  ).toBeGreaterThan(0);
  let statusExit = 0;
  try {
    execFileSync("git", ["status", "--porcelain=v1"], { cwd, stdio: "ignore" });
  } catch (error) {
    statusExit = (error as { status?: number }).status ?? -1;
  }
  expect(statusExit).not.toBe(0);

  await testCommand(["status"]);
  const output = captured.join("\n");

  expect(output).toContain("report freshness:");
  // The defect, verbatim: this line used to read
  // "current (gitRef matches, working tree clean)".
  expect(output).not.toContain("working tree clean");
  expect(output).not.toContain("report freshness: current");
  expect(output).toContain("report freshness: unknown");
  expect(output).toContain("could not be determined");
}, 30_000);
