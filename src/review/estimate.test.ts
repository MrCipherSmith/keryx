import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ASSUMED_PARALLEL_DISPATCHES, CHILD_DEADLINE_MINUTES, TYPICAL_DISPATCH_MINUTES, estimatePackage, estimateRound, renderEstimate } from "./estimate";
import type { SliceManifest } from "./slice";

const manifest = (count: number, bytes: number, waveBytes: number): SliceManifest => ({
  schemaVersion: 1,
  maxBytes: bytes,
  waveBytes,
  source: "diff",
  slices: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, path: `slices/s${i}.diff`, bytes, files: [`src/f${i}.ts`], domain: "d", split: "domain" })) as SliceManifest["slices"],
  omissions: [],
  totals: { slices: count, bytes: bytes * count, files: count, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
});

test("roles x slices = assignments, waves follow the wave budget", () => {
  const e = estimateRound(["review-logic", "review-style", "review-clean-code"], manifest(10, 100, 500), "full");
  expect(e.assignments).toBe(30);
  expect(e.perRole.every((r) => r.slices === 10 && r.waves === 2)).toBe(true);
  expect(e.dispatches).toBe(6);
  expect(e.sequentialBatches).toBe(2);
  expect(e.minutes).toEqual({ min: 2 * TYPICAL_DISPATCH_MINUTES, max: 2 * CHILD_DEADLINE_MINUTES });
});

test("many roles queue behind the parallelism limit", () => {
  const roles = Array.from({ length: 8 }, (_, i) => `review-r${i}`);
  const e = estimateRound(roles, manifest(1, 10, 100));
  expect(e.dispatches).toBe(8);
  expect(e.sequentialBatches).toBe(Math.ceil(8 / ASSUMED_PARALLEL_DISPATCHES));
});

test("an unsliced package has assignments = roles and one wave each", () => {
  const e = estimateRound(["review-logic", "review-style"], undefined);
  expect(e).toMatchObject({ sliced: false, assignments: 2, dispatches: 2, sequentialBatches: 1 });
  expect(renderEstimate(e)).toContain("not sliced");
});

test("estimatePackage reads the manifest and the recorded depth from a package", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-estimate-"));
  try {
    for (const name of ["review-orchestrator", "review-logic", "review-style", "review-testing-practices", "review-clean-code"]) {
      const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`);
    }
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { gdskills: {} } }));
    const pkg = path.join(root, ".metaproject", "reviews", "r1");
    await mkdir(path.join(pkg, "slices"), { recursive: true });
    await writeFile(path.join(pkg, "slices", "manifest.json"), JSON.stringify(manifest(4, 100, 1000)));
    await writeFile(path.join(pkg, "round-depth.json"), JSON.stringify({ requested: "auto", depth: "light", reason: "auto: small" }));
    const e = await estimatePackage(pkg);
    expect(e.depth).toBe("light");
    expect(e.roles).toBe(3);
    // review-testing-practices is path-gated to test files, so it owns none of these slices: 2 roles x 4 slices.
    expect(e.assignments).toBe(8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
