import { expect, test } from "bun:test";
import type { RewindEntry } from "./manifest";
import { enforceRetention, pruneManifest, REWIND_MAX_SNAPSHOTS } from "./retention";
import { git, initShadow, shadowRepo } from "./shadow";
import { captureTree, writeSnapshotRef } from "./snapshot";
import { makeProject, write } from "./rewind.test-helpers";

function entry(seq: number, tree = `t${seq}`): RewindEntry {
  return { seq, kind: "turn", tree, at: "2026-01-01T00:00:00.000Z", archiveIndex: seq * 2, prompt: `p${seq}`, skipped: [] };
}

test("the default cap is 50", () => {
  expect(REWIND_MAX_SNAPSHOTS).toBe(50);
});

test("pruneManifest drops the oldest beyond the cap and keeps order", () => {
  const entries = Array.from({ length: 55 }, (_, i) => entry(i + 1));
  const { keep, drop } = pruneManifest(entries);
  expect(keep).toHaveLength(50);
  expect(keep[0]?.seq).toBe(6);
  expect(keep.at(-1)?.seq).toBe(55);
  expect(drop.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
});

test("pruneManifest under the cap drops nothing", () => {
  const { keep, drop } = pruneManifest([entry(1), entry(2)], 50);
  expect(keep).toHaveLength(2);
  expect(drop).toHaveLength(0);
});

test("enforceRetention removes the refs and the unreachable objects of pruned snapshots", async () => {
  const project = makeProject();
  const repo = shadowRepo(project.rewindDir, project.root);
  await initShadow(repo);
  const entries: RewindEntry[] = [];
  for (let i = 1; i <= 6; i += 1) {
    write(project.root, "a.txt", `version ${i}\n`);
    const { tree } = await captureTree(repo);
    await writeSnapshotRef(repo, i, tree);
    entries.push(entry(i, tree));
  }
  const result = await enforceRetention(repo, entries, 4);
  expect(result.dropped).toBe(2);
  expect(result.keep.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
  const refs = (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/rewind/"])).stdout.trim().split("\n");
  expect(refs.sort()).toEqual(["refs/rewind/3", "refs/rewind/4", "refs/rewind/5", "refs/rewind/6"]);
  expect((await git(repo, ["cat-file", "-e", entries[0]!.tree])).code).not.toBe(0);
  expect((await git(repo, ["cat-file", "-e", entries[5]!.tree])).code).toBe(0);
});
