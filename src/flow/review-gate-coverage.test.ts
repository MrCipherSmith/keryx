// R3-05: the coverage-completeness gate decides only rounds that kept the coverage record. A round cut before that
// accounting existed (a blast radius with dropped files, no chunk plan, no covered slices) must read as ingested.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readyResearchFixture } from "../review/research.test-helpers";
import { readReviewRounds } from "./review-gate";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function round(status: string, extra: Record<string, unknown> = {}): Promise<{ root: string; packageDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-gate-coverage-"));
  roots.push(root);
  const packageDir = path.join(root, ".metaproject", "flows", "001-x", "reviews", "r1");
  await mkdir(packageDir, { recursive: true });
  const manifest = { reviewId: "r1", status, createdAt: "2026-01-01T00:00:00Z", artifacts: { research: "research.json", reviewerDispatch: "research.json" } };
  await writeFile(path.join(packageDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  await writeFile(path.join(packageDir, "findings.json"), "[]", "utf8");
  await writeFile(path.join(packageDir, "research.json"), JSON.stringify(readyResearchFixture()), "utf8");
  await writeFile(path.join(packageDir, "blast-radius.json"), JSON.stringify({ files: [], dropped: [{ file: "src/old.ts", reason: "cap" }] }), "utf8");
  for (const [name, body] of Object.entries(extra)) await writeFile(path.join(packageDir, name), JSON.stringify(body), "utf8");
  return { root, packageDir };
}

const problemsOf = async (root: string): Promise<string[]> => (await readReviewRounds(root, "001-x"))[0]?.problems ?? ["no round read"];

test("a draft round with dropped files and no coverage record is not held to the completeness gate", async () => {
  const { root } = await round("draft");
  expect((await problemsOf(root)).filter((problem) => problem.includes("uncovered"))).toEqual([]);
});

test("a draft round that kept a chunk plan is held to it: the dropped file is uncovered", async () => {
  const { root } = await round("draft", {
    "chunks.json": { schemaVersion: 1, dropped: 1, maxFiles: 25, tier: "middle", reviewer: "review-regression", chunks: [{ id: "c1", files: ["src/old.ts"] }] },
  });
  expect((await problemsOf(root)).some((problem) => problem.includes("uncovered"))).toBe(true);
});

test("a draft round with a coverage.json is held to the gate too", async () => {
  const { root } = await round("draft", { "coverage.json": { schemaVersion: 1 } });
  expect((await problemsOf(root)).some((problem) => problem.includes("uncovered"))).toBe(true);
});
