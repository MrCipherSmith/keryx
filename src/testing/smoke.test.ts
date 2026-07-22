import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { resolveSmokeSet, staticChangedSelection } from "./selection";
import { analyzeTestingProject, runTesting } from "./service";
import { uniqueTestRoot } from "../lib/test-tmp";
const TEST_FILES = ["src/a.test.ts", "src/b.test.ts", "src/smoke.test.ts", "e2e/smoke.test.ts"];

// --- resolveSmokeSet unit --------------------------------------------------

test("resolveSmokeSet expands globs / paths / tags; empty ⇒ []", () => {
  expect(resolveSmokeSet({ selectors: [] }, TEST_FILES)).toEqual([]);
  expect(resolveSmokeSet(undefined, TEST_FILES)).toEqual([]);
  // Glob.
  expect(resolveSmokeSet({ selectors: ["**/smoke.test.ts"] }, TEST_FILES)).toEqual([
    "e2e/smoke.test.ts",
    "src/smoke.test.ts",
  ]);
  // Explicit path.
  expect(resolveSmokeSet({ selectors: ["src/a.test.ts"] }, TEST_FILES)).toEqual(["src/a.test.ts"]);
  // Tag/segment substring.
  expect(resolveSmokeSet({ selectors: ["e2e/"] }, TEST_FILES)).toEqual(["e2e/smoke.test.ts"]);
});

// --- AC13: compose-not-suppress across modes (union superset) --------------

test("AC13: smoke union composes with, never suppresses, the scoped selection", () => {
  const scoped = new Set(["src/a.test.ts"]);
  const smoke = resolveSmokeSet({ selectors: ["**/smoke.test.ts"] }, TEST_FILES);
  const combined = new Set([...scoped, ...smoke]);
  // Final set ⊇ scoped selection.
  for (const t of scoped) {
    expect(combined.has(t)).toBe(true);
  }
  expect(combined.has("src/smoke.test.ts")).toBe(true);
});

test("AC12: smoke unions into the changed-mode selection", async () => {
  // Changed selection (static) unioned with smoke at the same layer service.ts uses.
  const changed = staticChangedSelection(["src/a.ts"], TEST_FILES);
  const smoke = resolveSmokeSet({ selectors: ["src/smoke.test.ts"] }, TEST_FILES);
  const combined = Array.from(new Set([...changed, ...smoke])).sort();
  expect(combined).toContain("src/smoke.test.ts");
});

// --- AC12/AC14: end-to-end via runTesting (project + scope) ----------------

async function seedRepo(root: string, smokeSelectors: string[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  const trivial = "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n";
  await writeFile(path.join(root, "src", "a.test.ts"), trivial);
  await writeFile(path.join(root, "src", "smoke.test.ts"), trivial);
  await writeFile(
    path.join(root, ".metaproject", "testing.config.json"),
    JSON.stringify({ smoke: { selectors: smokeSelectors } }),
  );
  await analyzeTestingProject(root);
}

test("AC12: smoke tier is recorded and composed in project + scope modes", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-smoke-modes");
  await seedRepo(root, ["src/smoke.test.ts"]);

  const project = await runTesting({ cwd: root });
  expect(project.report.selection.smokeTests).toEqual(["src/smoke.test.ts"]);
  expect(project.report.selection.selectedTests).toContain("src/smoke.test.ts");

  const scope = await runTesting({ cwd: root, scope: "src/a" });
  expect(scope.report.selection.smokeTests).toEqual(["src/smoke.test.ts"]);
  // Composes: the scope test AND smoke are both present.
  expect(scope.report.selection.selectedTests).toContain("src/a.test.ts");
  expect(scope.report.selection.selectedTests).toContain("src/smoke.test.ts");

  await rm(root, { recursive: true, force: true });
});

test("AC14: with no smoke block, smokeTests is [] and selection is byte-identical", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-smoke-empty");
  await seedRepo(root, []);

  const scope = await runTesting({ cwd: root, scope: "src/a" });
  expect(scope.report.selection.smokeTests).toEqual([]);
  // Scope selection unchanged (only the scope's own tests).
  expect(scope.report.selection.selectedTests).toContain("src/a.test.ts");
  expect(scope.report.selection.selectedTests).not.toContain("src/smoke.test.ts");
  expect(scope.report.selection.strategies).toEqual(["runner", "gdgraph", "naming"]);

  await rm(root, { recursive: true, force: true });
});
