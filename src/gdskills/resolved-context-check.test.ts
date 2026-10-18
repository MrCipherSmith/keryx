import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectContextResolution } from "./context-resolver";
import { checkResolvedContext } from "./resolved-context-check";
import { sha256Hex } from "./project-rules";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const FLAT = ".metaproject/rules/project/styling.mdc";
const NESTED = ".metaproject/rules/project/core/styling.mdc";

async function fixture(): Promise<{ root: string; resolved: ProjectContextResolution; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-resolved-check-"));
  roots.push(root);
  const text = "---\nglobs: src/**\n---\nstyling\n";
  for (const rel of [FLAT, NESTED]) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
  }
  const sha = sha256Hex(text);
  const resolved: ProjectContextResolution = {
    schema: 1,
    for: "implement",
    files: ["src/a.ts"],
    entries: [{ kind: "rule", source: "project", path: FLAT, sha256: sha, bytes: text.length, reason: "glob:src/**", tier: "must_read", also_at: [NESTED] }],
    budget: { limitBytes: 1000, usedBytes: text.length, exceeded: false, limitSource: "default" },
    warnings: [],
  };
  return { root, resolved, sha };
}

test("citing the primary path or an also_at path with the pinned sha256 satisfies a must_read entry", async () => {
  const { root, resolved, sha } = await fixture();
  for (const cited of [FLAT, NESTED]) {
    const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [{ path: cited, sha256: sha }] } });
    expect(report.misses).toEqual([]);
    expect(report.drifted).toEqual([]);
  }
});

test("an also_at citation with the wrong sha256 is still a miss and reports what was cited", async () => {
  const { root, resolved, sha } = await fixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [{ path: NESTED, sha256: "0".repeat(64) }] } });
  expect(report.misses).toEqual([{ path: FLAT, reason: "glob:src/**", expected: sha, cited: "0".repeat(64) }]);
});

test("no citation at all is a miss without a cited sha256", async () => {
  const { root, resolved, sha } = await fixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [] } });
  expect(report.misses).toEqual([{ path: FLAT, reason: "glob:src/**", expected: sha }]);
});

test("a changed also_at file is reported as drift", async () => {
  const { root, resolved, sha } = await fixture();
  await writeFile(path.join(root, NESTED), "changed\n", "utf8");
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [{ path: FLAT, sha256: sha }] } });
  expect(report.drifted.map((drift) => drift.path)).toEqual([NESTED]);
});
