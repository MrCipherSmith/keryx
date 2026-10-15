import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describeReviewWave, resolveReviewWave } from "./wave-key";

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(): Promise<{ root: string; pkg: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-wavekey-"));
  made.push(root);
  const pkg = ".metaproject/reviews/pkg";
  await mkdir(path.join(root, pkg), { recursive: true });
  await writeFile(path.join(root, pkg, "manifest.json"), "{}");
  await writeFile(
    path.join(root, pkg, "chunks.json"),
    JSON.stringify({ schemaVersion: 1, chunks: [{ id: "chunk-1", files: [], bytes: 0 }] }),
  );
  return { root, pkg };
}

test("a chunk of the recorded plan resolves to a key that names package and pass", async () => {
  const { root, pkg } = await project();
  const wave = await resolveReviewWave(root, { package: pkg, pass: "chunk-1" });
  expect(wave.ok).toBe(true);
  if (wave.ok) expect(describeReviewWave(wave.key)).toBe("pkg/chunk-1");
});

test("the same wave named by an absolute path or a symlink gets the same key", async () => {
  const { root, pkg } = await project();
  await symlink(path.join(root, pkg), path.join(root, "alias"));
  const keys = await Promise.all(
    [pkg, path.join(root, pkg), "alias"].map((p) => resolveReviewWave(root, { package: p, pass: "chunk-1" })),
  );
  expect(new Set(keys.map((k) => (k.ok ? k.key : "refused"))).size).toBe(1);
  expect(keys[0]?.ok).toBe(true);
});

test("round is a wave of any package that has a manifest", async () => {
  const { root, pkg } = await project();
  await rm(path.join(root, pkg, "chunks.json"));
  expect((await resolveReviewWave(root, { package: pkg, pass: "round" })).ok).toBe(true);
  expect((await resolveReviewWave(root, { package: pkg, pass: "chunk-1" })).ok).toBe(false);
});

test("retry chunks recorded in chunk-state.json are waves", async () => {
  const { root, pkg } = await project();
  await writeFile(
    path.join(root, pkg, "chunk-state.json"),
    JSON.stringify({
      schemaVersion: 1,
      retry: {},
      outcomes: {},
      derived: [{ id: "chunk-1.a", files: [], bytes: 0 }],
    }),
  );
  expect((await resolveReviewWave(root, { package: pkg, pass: "chunk-1.a" })).ok).toBe(true);
});

test("an invented pass, a package outside the project, a missing manifest and bad shapes are refused", async () => {
  const { root, pkg } = await project();
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-wavekey-out-"));
  made.push(outside);
  await writeFile(path.join(outside, "manifest.json"), "{}");
  await mkdir(path.join(root, "empty"));
  await symlink(outside, path.join(root, "escape"));
  const refused: unknown[] = [
    { package: pkg, pass: "invented" },
    { package: outside, pass: "round" },
    { package: "escape", pass: "round" },
    { package: "../", pass: "round" },
    { package: ".", pass: "round" },
    { package: "empty", pass: "round" },
    { package: "missing", pass: "round" },
    { package: pkg, pass: "" },
    { package: pkg },
    { pass: "round" },
    { package: 4, pass: "round" },
    "pkg/chunk-1",
    null,
    undefined,
  ];
  for (const wave of refused) {
    const result = await resolveReviewWave(root, wave);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  }
});
