import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { uniqueTestRoot } from "../../lib/test-tmp";
import { runTesting } from "../../testing/service";
import type { TestingReport } from "../../testing/types";
import { runHealth } from "../run";
import type { HealthContext, RawSourceResult } from "../types";
import { testsAdapter } from "./tests";

const ctx = { cwd: "/repo" } as unknown as HealthContext;

function reportRaw(overrides: Partial<TestingReport> & { context: TestingReport["context"] }): RawSourceResult {
  const report: TestingReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitRef: null,
    status: "pass",
    scope: "project",
    runner: "bun test",
    command: "bun test",
    exitCode: 0,
    durationMs: 1,
    counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
    selection: {
      changed: false,
      strategies: [],
      selectedTests: [],
      changedFiles: [],
      fallback: "none",
      smokeTests: [],
    },
    failures: [],
    relatedFiles: [],
    relatedSkills: [],
    rawLogPath: null,
    ...overrides,
  };
  return {
    source: "tests",
    command: report.command,
    toolVersion: report.runner,
    exitCode: report.exitCode,
    rawPath: "",
    content: JSON.stringify(report),
    imported: true,
  };
}

// F-008 (flow 234 T25, major): the imported testing report's `context` field
// (AFC-09 / T21, AC2) says whether the refresh that produced it could fully
// walk the tree. Before the fix, `parseTestingReport` never read it: a
// report whose context was `incomplete` but whose executed tests all passed
// contributed zero findings, so the source was recorded as completed/parsed
// with clean coverage - indistinguishable from a tree that really was fully
// examined. This is the RED->GREEN unit-level regression for that gap.
test("an incomplete testing context produces a blocking finding naming the reasons, even when every executed test passed", () => {
  const findings = testsAdapter.parse(
    reportRaw({
      status: "pass",
      context: {
        status: "incomplete",
        incompleteReasons: ["EACCES: permission denied, scandir 'src/locked'"],
      },
    }),
    ctx,
  );

  expect(findings).toHaveLength(1);
  expect(findings[0]?.priority).toBe("P0");
  expect(findings[0]?.severity).toBe("error");
  expect(findings[0]?.category).toBe("test");
  expect(findings[0]?.id).toContain("tests-context-incomplete");
  expect(findings[0]?.message).toContain("EACCES: permission denied, scandir 'src/locked'");
});

test("a complete testing context adds no incompleteness finding", () => {
  const findings = testsAdapter.parse(
    reportRaw({
      status: "pass",
      context: { status: "complete", incompleteReasons: [] },
    }),
    ctx,
  );

  expect(findings).toEqual([]);
});

test("an incomplete context is additive to real test failures, not a replacement for them", () => {
  const findings = testsAdapter.parse(
    reportRaw({
      status: "fail",
      context: { status: "incomplete", incompleteReasons: ["EACCES: permission denied, scandir 'src/locked'"] },
      failures: [{ file: "src/a.test.ts", name: "a > works", message: "expected true", priority: "P0" }],
    }),
    ctx,
  );

  expect(findings).toHaveLength(2);
  expect(findings.some((f) => f.id.includes("tests-context-incomplete"))).toBe(true);
  expect(findings.some((f) => f.message === "expected true")).toBe(true);
});

test("tolerates malformed testing report JSON (unchanged pre-existing behavior)", () => {
  const raw: RawSourceResult = {
    source: "tests",
    command: null,
    toolVersion: null,
    exitCode: 0,
    rawPath: "",
    content: "not json",
    imported: true,
  };
  expect(testsAdapter.parse(raw, ctx)).toEqual([]);
});

// End-to-end demonstration: a REAL unreadable subdirectory, a REAL testing
// report produced by the testing layer (src/testing/service.ts's own
// `runTesting`, the same AFC-09 / T21 mechanism `service.test.ts` already
// exercises at "a non-strict run still carries the context status onto the
// report without forcing a failure"), fed into a REAL `runHealth()`. Before
// the fix, this reported a clean pass; after, it fails the gate.
test("health run over a testing report with an incomplete context reports a blocking finding, not a clean pass", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-tests-context-incomplete");
  await mkdir(path.join(root, "src", "locked"), { recursive: true });
  await writeFile(
    path.join(root, "src", "visible.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
  );
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  // Flow 237 T6 defect 4: `compatibleReportForHealth`'s "file"/"module"
  // branch now goes through `loadCompatibleTestingReport`'s gitRef/scope
  // guard like every other scope kind (it no longer bypasses it) — a real
  // commit is needed so the report `runTesting` writes below and the
  // `runHealth` read after it agree on the current gitRef. Committed BEFORE
  // locking "src/locked" so `git add`/`commit` do not need to read into it.
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root, stdio: "ignore" });
  await chmod(path.join(root, "src", "locked"), 0o000);

  try {
    const testingResult = await runTesting({ cwd: root, scope: "src/visible" });
    // Sanity: the fixture actually reproduces AFC-09's incomplete context
    // while the tests that DID run passed - not a stand-in for it.
    expect(testingResult.report.context.status).toBe("incomplete");
    expect(testingResult.report.status).toBe("pass");

    // Restore permissions before the HEALTH run's own project-wide file walk
    // (`src/health/util.ts`'s `listSourceFiles`) reaches "src/locked": unlike
    // the testing layer's own tree walk, it does not catch EACCES and
    // crashes the whole `runHealth()` call outright - a separate, unrelated
    // bug out of this task's file ownership (see the residual noted in the
    // task report). The already-written, already-incomplete testing report
    // on disk is what this test exercises; the directory only needed to be
    // locked long enough for the testing layer to produce that report.
    await chmod(path.join(root, "src", "locked"), 0o755);

    const { report } = await runHealth({
      cwd: root,
      // "file" scope, path matching `report.scope` ("src/visible", the
      // `runTesting` call's own `scope` above via `describeScope`) — this
      // now has to match `loadCompatibleTestingReport`'s gitRef AND scope
      // check to be imported at all; the git commit above is what makes
      // that match possible.
      scope: { kind: "file", path: "src/visible" },
      sources: ["tests"],
    });

    const incomplete = report.findings.find(
      (f) => f.source === "tests" && f.id.includes("tests-context-incomplete"),
    );
    expect(incomplete).toBeDefined();
    expect(incomplete?.priority).toBe("P0");
    expect(report.gate.status).toBe("fail");
  } finally {
    await chmod(path.join(root, "src", "locked"), 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

// Second half of F-008 (reviewer flagged but did not confirm): does a
// corrupted testing report on disk also get silently reported as a clean
// parse, the same shape of bug? Checked by running, not by reading.
//
// It does not. `loadTestingReport` (src/testing/service.ts) already wraps
// its own `JSON.parse` of the on-disk report in a try/catch that returns
// `null` on failure. `tests.ts`'s `import()` then throws `NoImportError`,
// and `run.ts`'s `runAdapter` special-cases the "tests" adapter id on that
// error to record `status: "missing"` rather than falling back to actually
// running the suite. So a corrupted report FILE never reaches
// `parseTestingReport`'s own `JSON.parse` (the catch that returns `[]`) in
// production at all - it is intercepted upstream and recorded honestly as
// "missing", never as an "available"/"parsed" clean pass. This test locks
// that behavior in; it required no code change.
test("a corrupted testing report on disk is recorded as missing, never as a silently clean parse", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-tests-corrupt-report");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "dummy.test.ts"), "test.todo('dummy');\n");
    await mkdir(path.join(root, ".metaproject", "data", "testing", "artifacts"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "data", "testing", "artifacts", "latest.json"),
      "{ this is not valid json",
      "utf8",
    );

    const { report } = await runHealth({ cwd: root, sources: ["tests"] });
    const testsInfo = report.sources.find((s) => s.source === "tests");

    expect(testsInfo?.status).toBe("missing");
    expect(testsInfo?.status).not.toBe("available");
    expect(testsInfo?.findings).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 237 T6 defect 4 (AFC-28/AC-28, "a package grants no rights of its own
// and an old test pass is not reused as evidence for new code"):
// `loadCompatibleTestingReport` (src/testing/service.ts) exists specifically
// to guard against reusing a testing report from a DIFFERENT commit — it
// checks `report.gitRef` against the current `git rev-parse` before treating
// a report as usable evidence. Before this fix, `compatibleReportForHealth`'s
// fallback branch (for `scopeSelector.kind` "module"/"file") called
// `loadTestingReport` directly, going around that guard entirely: any report
// on disk, from any commit, was treated as importable evidence for the
// current tree.
test("a testing report from a different commit is not imported as evidence for a file-scoped health run (compatible-report guard is not bypassed)", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-tests-stale-scope-bypass");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".metaproject", "data", "testing", "artifacts"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root, stdio: "ignore" });

    // A testing report on disk scoped to exactly the file a "file"-scoped
    // health run below asks about — but recorded against a commit that is
    // NOT this fixture's real HEAD (a stale/foreign gitRef).
    const staleReport: TestingReport = {
      schemaVersion: 1,
      generatedAt: new Date(Date.now() - 86_400_000).toISOString(),
      gitRef: "0000000",
      status: "pass",
      scope: "src/a.ts",
      runner: "bun test",
      command: "bun test",
      exitCode: 0,
      durationMs: 1,
      counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
      context: { status: "complete", incompleteReasons: [] },
      selection: {
        changed: false,
        strategies: [],
        selectedTests: [],
        changedFiles: [],
        fallback: "none",
        smokeTests: [],
      },
      failures: [],
      relatedFiles: [],
      relatedSkills: [],
      rawLogPath: null,
    };
    await writeFile(
      path.join(root, ".metaproject", "data", "testing", "artifacts", "latest.json"),
      JSON.stringify(staleReport, null, 2),
      "utf8",
    );

    const fileCtx = {
      cwd: root,
      scopeSelector: { kind: "file", path: "src/a.ts" },
      // No test files of its own in this scope-selection sense (the report
      // above is the only would-be evidence) — if the stale report is
      // (wrongly) accepted, `detect()` reports "available"; if it is
      // correctly rejected, `detect()` falls through to "no test files" and
      // reports "skipped".
      sourceFiles: [],
    } as unknown as HealthContext;

    const status = await testsAdapter.detect(fileCtx);

    expect(status).toBe("skipped");
    expect(status).not.toBe("available");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
