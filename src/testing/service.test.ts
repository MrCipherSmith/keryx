import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { uniqueTestRoot } from "../lib/test-tmp";
import {
  analyzeTestingProject,
  findRelatedTests,
  loadTestingReport,
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
