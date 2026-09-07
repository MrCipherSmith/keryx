import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { uniqueTestRoot } from "../lib/test-tmp";
import {
  analyzeTestingProject,
  computeTestingContext,
  findRelatedTests,
  loadTestingReport,
  relatedTestsInContext,
  runTesting,
} from "./service";

test("analyzes testing context without mutating project tests", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-analyze");
  await reset(root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "bun test" },
      devDependencies: { "bun-types": "latest" },
    }),
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "foo.ts"), "export const foo = 1;\n");
  await writeFile(
    path.join(root, "src", "foo.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('foo', () => expect(1).toBe(1));\n",
  );
  await writeFile(path.join(root, "AGENTS.md"), "Use bun:test for unit tests.\n");

  const context = await analyzeTestingProject(root);

  expect(context.frameworks).toContain("bun");
  expect(context.scripts).toContainEqual({ name: "test", command: "bun test" });
  expect(context.testFiles).toEqual(["src/foo.test.ts"]);
  expect(context.conventions.some((line) => line.includes("bun:test"))).toBe(true);
});

test("finds related tests by naming convention", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-related");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src", "feature"), { recursive: true });
  await writeFile(path.join(root, "src", "feature", "step.ts"), "export const step = 1;\n");
  await writeFile(path.join(root, "src", "feature", "step.test.ts"), "test.todo('step');\n");
  await analyzeTestingProject(root);

  await expect(findRelatedTests(root, "src/feature/step.ts")).resolves.toEqual([
    "src/feature/step.test.ts",
  ]);
});

test("finds related tests by import path when naming is unrelated", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-related-import");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src", "policy"), { recursive: true });
  await mkdir(path.join(root, "src", "features", "checks"), { recursive: true });
  await writeFile(
    path.join(root, "src", "policy", "types.ts"),
    "export type PolicyDecision = \"allow\" | \"deny\";\n",
  );
  await writeFile(
    path.join(root, "src", "features", "checks", "policy-import.test.ts"),
    "import type { PolicyDecision } from \"../../policy/types\";\n\ntest(\"policy\", () => {});\n",
  );
  await analyzeTestingProject(root);

  await expect(findRelatedTests(root, "src/policy/types.ts")).resolves.toEqual([
    "src/features/checks/policy-import.test.ts",
  ]);
});

// AFC-09 (flow 234, AC2) - confirmed pre-existing defect: transient `.claude/worktrees/*`
// checkouts (other agents' scratch worktrees, not project tests) were being walked and
// their test files reported as if they belonged to this project.
test("excludes transient .claude worktree checkouts from test discovery", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-claude-worktree");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "real.test.ts"), "test.todo('real');\n");
  await mkdir(path.join(root, ".claude", "worktrees", "some-worktree-abc123", "src"), { recursive: true });
  await writeFile(
    path.join(root, ".claude", "worktrees", "some-worktree-abc123", "src", "phantom.test.ts"),
    "test.todo('phantom');\n",
  );

  const context = await analyzeTestingProject(root);

  expect(context.testFiles).toEqual(["src/real.test.ts"]);
  expect(context.testFiles.some((file) => file.includes(".claude/worktrees"))).toBe(false);
});

// Narrowness proof (AC2 requirement 3): the `.claude/worktrees` exclusion above must be
// narrow. A broad "skip any nested directory" rule would also drop an ordinary monorepo
// package's tests - that is the opposite defect and must not happen.
test("still discovers tests inside an ordinary nested monorepo package", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-monorepo-package");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "packages", "widgets", "src"), { recursive: true });
  await writeFile(path.join(root, "packages", "widgets", "package.json"), JSON.stringify({ name: "widgets" }));
  await writeFile(
    path.join(root, "packages", "widgets", "src", "widget.test.ts"),
    "test.todo('widget');\n",
  );

  const context = await analyzeTestingProject(root);

  expect(context.testFiles).toContain("packages/widgets/src/widget.test.ts");
});

// AC2 requirement 1: a test file added after a cached context.json was written must still
// be found - a consumer must not silently keep answering from the stale cache.
test("findRelatedTests reflects a test file added after the cached context was written", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-add-reflected");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src", "feature"), { recursive: true });
  await writeFile(path.join(root, "src", "feature", "step.ts"), "export const step = 1;\n");
  await analyzeTestingProject(root); // writes a cached context.json with no related test yet

  // Test file added AFTER the cache was written, without re-running `keryx test analyze`.
  await writeFile(path.join(root, "src", "feature", "step.test.ts"), "test.todo('step');\n");

  await expect(findRelatedTests(root, "src/feature/step.ts")).resolves.toEqual([
    "src/feature/step.test.ts",
  ]);
});

// AC2 requirement 2: switching checkout to a state that already has a test the cached
// context predates must still be reflected in changed-scope selection.
test("changed-test selection reflects tests that exist after a checkout switch even when the cached context predates it", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-checkout-reflected");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "old.ts"), "export const old = 1;\n");
  await writeFile(path.join(root, "src", "old.test.ts"), "test.todo('old');\n");
  await analyzeTestingProject(root); // cache reflects only the pre-switch checkout state

  // Simulate `git checkout` landing on a commit that already contains a different
  // module and its test (committed, so it is NOT part of the working diff itself).
  await mkdir(path.join(root, "src", "widget"), { recursive: true });
  await writeFile(path.join(root, "src", "widget", "gadget.ts"), "export const gadget = 1;\n");
  await writeFile(path.join(root, "src", "widget", "gadget.test.ts"), "test.todo('gadget');\n");
  await gitInit(root);

  // Only gadget.ts is the "changed" file for this run.
  await writeFile(path.join(root, "src", "widget", "gadget.ts"), "export const gadget = 2;\n");

  const result = await runTesting({ cwd: root, changed: true, since: "HEAD" });

  expect(result.report.selection.selectedTests).toContain("src/widget/gadget.test.ts");
});

// AC2 requirement 4: when the refresh (file walk) cannot fully complete, the result must be
// distinguishable from "the project legitimately has no tests" - it must say `incomplete`.
test("analyzeTestingProject reports incomplete, not a clean empty result, when part of the tree cannot be read", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-incomplete-refresh");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src", "locked"), { recursive: true });
  await writeFile(path.join(root, "src", "visible.test.ts"), "test.todo('visible');\n");
  await writeFile(path.join(root, "src", "locked", "hidden.test.ts"), "test.todo('hidden');\n");
  await chmod(path.join(root, "src", "locked"), 0o000);

  try {
    const context = await analyzeTestingProject(root);
    expect(context.status).toBe("incomplete");
    expect(context.incompleteReasons.length).toBeGreaterThan(0);
    // Still reports what it COULD see - not indistinguishable from "no tests".
    expect(context.testFiles).toContain("src/visible.test.ts");
  } finally {
    await chmod(path.join(root, "src", "locked"), 0o755);
  }
});

test("runTesting writes normalized report", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-run");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, "src", "ok.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
  );

  const result = await runTesting({ cwd: root });
  const latest = await loadTestingReport(root);

  expect(result.report.status).toBe("pass");
  expect(result.report.runner).toBe("bun-script");
  expect(result.jsonPath).toBe(".metaproject/data/testing/artifacts/latest.json");
  expect(latest?.status).toBe("pass");
});

test("runTesting writes immutable provenance-aware evidence when a run id is supplied", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-provenance-run");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, "src", "ok.test.ts"), "test('ok', () => {});\n");

  await runTesting({ cwd: root, runId: "run-testing-provenance" });

  const record = JSON.parse(await readFile(
    path.join(root, ".metaproject", "data", "testing", "artifacts", "runs", "run-testing-provenance.json"),
    "utf8",
  ));
  const latest = JSON.parse(await readFile(
    path.join(root, ".metaproject", "data", "testing", "artifacts", "latest.json"),
    "utf8",
  ));
  expect(record.runId).toBe("run-testing-provenance");
  expect(record.provenance).toBeDefined();
  expect(latest.run_id).toBe("run-testing-provenance");
  expect(latest.record).toContain("runs/run-testing-provenance.json");
});

test("strict changed run fails when no related tests are selected", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-strict-empty");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "unrelated.test.ts"), "test.todo('unrelated');\n");
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "testing.config.json"),
    JSON.stringify({
      changedSelection: { fallbackWhenEmpty: "warn" },
    }),
  );
  await analyzeTestingProject(root);
  // A changed SOURCE file with no matching test is the case the strict gate must block.
  await gitInit(root);
  await writeFile(path.join(root, "src", "orphan.ts"), "export const orphan = 1;\n");

  const result = await runTesting({ cwd: root, changed: true, strict: true });

  expect(result.report.status).toBe("fail");
  expect(result.report.failures[0]?.name).toBe("no-related-tests-selected");
});

test("the reported failure count matches the failure list when two strict gates fire together", async () => {
  // Both strict gates capped the count at one, so a run that tripped both
  // reported two failures alongside `failed: 1`. A report that undercounts its
  // own failures is the same shape of untruth this phase closed elsewhere:
  // the detail was right and the number a consumer reads was not.
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-two-gates");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "unrelated.test.ts"), "test.todo('unrelated');\n");
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "testing.config.json"),
    JSON.stringify({ changedSelection: { fallbackWhenEmpty: "warn" } }),
  );
  await analyzeTestingProject(root);
  await gitInit(root);
  await writeFile(path.join(root, "src", "orphan.ts"), "export const orphan = 1;\n");

  // Make a subdirectory unreadable so the context refresh also comes back
  // incomplete, tripping the second gate in the same run.
  const locked = path.join(root, "src", "locked");
  await mkdir(locked, { recursive: true });
  await writeFile(path.join(locked, "hidden.test.ts"), "test.todo('hidden');\n");
  await chmod(locked, 0o000);

  try {
    const result = await runTesting({ cwd: root, changed: true, strict: true });

    const names = result.report.failures.map((f) => f.name);
    expect(names).toContain("no-related-tests-selected");
    expect(names).toContain("testing-context-incomplete");
    expect(result.report.counts.failed).toBe(result.report.failures.length);
  } finally {
    await chmod(locked, 0o755);
  }
});

test("strict changed run does not fail when only docs/artifacts changed", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-strict-docs");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "unrelated.test.ts"), "test.todo('unrelated');\n");
  await mkdir(path.join(root, ".metaproject", "wiki", "components"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "testing.config.json"),
    JSON.stringify({ changedSelection: { fallbackWhenEmpty: "warn" } }),
  );
  await analyzeTestingProject(root);
  // Docs-only change (e.g. wiki enrichment) has nothing to test - must not block.
  await gitInit(root);
  await writeFile(path.join(root, ".metaproject", "wiki", "components", "src-x.md"), "# Module\n");

  const result = await runTesting({ cwd: root, changed: true, strict: true });

  expect(result.report.status).not.toBe("fail");
  expect(result.report.failures.some((f) => f.name === "no-related-tests-selected")).toBe(false);
});

// Finding 1 (flow 234 T21, AC2 blocker): the context's `incomplete` status was
// computed and then discarded before the report - a strict run over a tree it
// could not fully read reported a clean PASS. The report must carry the
// context status/reasons, and a strict run must not treat that as a pass.
test("strict run treats an incomplete testing context as not a pass, even when the executed tests pass", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-strict-incomplete-context");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src", "locked"), { recursive: true });
  await writeFile(
    path.join(root, "src", "visible.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
  );
  await writeFile(path.join(root, "src", "locked", "hidden.test.ts"), "test.todo('hidden');\n");
  await chmod(path.join(root, "src", "locked"), 0o000);

  try {
    const result = await runTesting({ cwd: root, strict: true, scope: "src/visible" });

    // The context's incompleteness must reach the report, not be discarded.
    expect(result.report.context.status).toBe("incomplete");
    expect(result.report.context.incompleteReasons.length).toBeGreaterThan(0);
    // The underlying command passed (visible.test.ts is a real, passing test) -
    // proving this is NOT the pre-existing "no command ran" path, but a new,
    // independent gate on context completeness.
    expect(result.report.status).not.toBe("pass");
    expect(result.report.exitCode).toBe(1);
    expect(result.report.failures.some((f) => f.name === "testing-context-incomplete")).toBe(true);
    // Serialized form (what a consumer like `test report --json` actually sees)
    // must mention it - not just the in-memory TestingContext.
    expect(JSON.stringify(result.report)).toContain("incomplete");
  } finally {
    await chmod(path.join(root, "src", "locked"), 0o755);
  }
});

// Finding 1: a non-strict run must still surface the context status on the
// report (carried, not discarded) even though it does not force a failure.
test("a non-strict run still carries the context status onto the report without forcing a failure", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-nonstrict-incomplete-context");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src", "locked"), { recursive: true });
  await writeFile(
    path.join(root, "src", "visible.test.ts"),
    "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
  );
  await chmod(path.join(root, "src", "locked"), 0o000);

  try {
    const result = await runTesting({ cwd: root, scope: "src/visible" });

    expect(result.report.context.status).toBe("incomplete");
    expect(result.report.status).toBe("pass");
  } finally {
    await chmod(path.join(root, "src", "locked"), 0o755);
  }
});

// Finding 2 (flow 234 T21, major): asking a read-only relatedness question
// through `findRelatedTests` was re-analyzing AND persisting the snapshot,
// dirtying the working tree (3 tracked files) for what is only a question.
test("findRelatedTests does not write the testing context snapshot to disk", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-related-readonly");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "mod1.ts"), "export const mod1 = 1;\n");

  const dataRoot = path.join(root, ".metaproject", "data", "testing");
  const related = await findRelatedTests(root, "src/mod1.ts");

  expect(related).toEqual([]);
  expect(existsSync(path.join(dataRoot, "context.json"))).toBe(false);
  expect(existsSync(path.join(dataRoot, "context.md"))).toBe(false);
  expect(existsSync(path.join(dataRoot, "recommendations.md"))).toBe(false);
});

// Finding 2: the computation itself (`computeTestingContext`) must still be
// pure and correct - it is `analyzeTestingProject` minus the persistence, not
// a different answer.
test("computeTestingContext computes the same context as analyzeTestingProject without persisting it", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-testing-compute-pure");
  await reset(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "step.ts"), "export const step = 1;\n");
  await writeFile(path.join(root, "src", "step.test.ts"), "test.todo('step');\n");

  const dataRoot = path.join(root, ".metaproject", "data", "testing");
  const context = await computeTestingContext(root);

  expect(context.testFiles).toEqual(["src/step.test.ts"]);
  expect(existsSync(path.join(dataRoot, "context.json"))).toBe(false);

  const related = await relatedTestsInContext(root, context, "src/step.ts");
  expect(related).toEqual(["src/step.test.ts"]);
});

async function reset(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

// Initialize a git repo with one commit so `git diff HEAD` resolves and any
// file created afterward is picked up as an untracked change.
async function gitInit(root: string): Promise<void> {
  const run = (args: string[]): void => {
    Bun.spawnSync(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" });
  };
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  run(["add", "-A"]);
  run(["commit", "-m", "baseline"]);
}
