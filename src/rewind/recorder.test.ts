import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadManifest } from "./manifest";
import { createRewindRecorder, rewindDisabledByEnv } from "./recorder";
import { makeProject, read, write } from "./rewind.test-helpers";

function recorderFor(project: { root: string; rewindDir: string }, extra: Partial<Parameters<typeof createRewindRecorder>[0]> = {}) {
  return createRewindRecorder({ workTree: project.root, dir: () => project.rewindDir, enabled: () => true, ...extra });
}

test("a turn that never mutates creates no shadow repo and no manifest", async () => {
  const project = makeProject();
  const recorder = recorderFor(project);
  recorder.beginTurn({ archiveIndex: 0, prompt: "just reading" });
  expect(recorder.snapshotCount()).toBe(0);
  expect(existsSync(project.rewindDir)).toBe(false);
});

test("beforeMutation snapshots once per turn, even for concurrent calls", async () => {
  const project = makeProject();
  const recorder = recorderFor(project);
  recorder.beginTurn({ archiveIndex: 4, prompt: "  rewrite   the\nthing " });
  await Promise.all([recorder.beforeMutation(), recorder.beforeMutation(), recorder.beforeMutation()]);
  await recorder.beforeMutation();
  expect(recorder.snapshotCount()).toBe(1);
  const [entry] = recorder.entries();
  expect(entry).toMatchObject({ kind: "turn", archiveIndex: 4, prompt: "rewrite the thing" });
  recorder.beginTurn({ archiveIndex: 6, prompt: "next" });
  await recorder.beforeMutation();
  expect(recorder.snapshotCount()).toBe(2);
});

test("the manifest is persisted and reloaded by a fresh recorder", async () => {
  const project = makeProject();
  const first = recorderFor(project);
  first.beginTurn({ archiveIndex: 0, prompt: "one" });
  await first.beforeMutation();
  expect(loadManifest(project.rewindDir).entries).toHaveLength(1);
  expect(recorderFor(project).snapshotCount()).toBe(1);
});

test("disabled recorder, or no session dir, records nothing", async () => {
  const project = makeProject();
  const off = recorderFor(project, { enabled: () => false });
  off.beginTurn({ archiveIndex: 0, prompt: "x" });
  await off.beforeMutation();
  expect(off.snapshotCount()).toBe(0);
  const none = recorderFor(project, { dir: () => undefined });
  none.beginTurn({ archiveIndex: 0, prompt: "x" });
  await none.beforeMutation();
  expect(none.snapshotCount()).toBe(0);
  expect(existsSync(project.rewindDir)).toBe(false);
});

test("KERYX_REWIND=off disables snapshots", () => {
  expect(rewindDisabledByEnv({ KERYX_REWIND: "off" })).toBe(true);
  expect(rewindDisabledByEnv({ KERYX_REWIND: " OFF " })).toBe(true);
  expect(rewindDisabledByEnv({ KERYX_REWIND: "on" })).toBe(false);
  expect(rewindDisabledByEnv({})).toBe(false);
});

test("a failing snapshot never throws and is reported once", async () => {
  const project = makeProject();
  const errors: string[] = [];
  const recorder = createRewindRecorder({
    workTree: path.join(project.root, "does-not-exist"),
    dir: () => project.rewindDir,
    enabled: () => true,
    onError: (message) => errors.push(message),
  });
  recorder.beginTurn({ archiveIndex: 0, prompt: "a" });
  await recorder.beforeMutation();
  recorder.beginTurn({ archiveIndex: 2, prompt: "b" });
  await recorder.beforeMutation();
  expect(errors).toHaveLength(1);
  expect(recorder.snapshotCount()).toBe(0);
});

test("describe lists newest first with the number of files each turn changed", async () => {
  const project = makeProject();
  const recorder = recorderFor(project);
  recorder.beginTurn({ archiveIndex: 0, prompt: "first" });
  await recorder.beforeMutation();
  write(project.root, "a.txt", "one\n");
  write(project.root, "n1.txt", "n\n");
  recorder.beginTurn({ archiveIndex: 2, prompt: "second" });
  await recorder.beforeMutation();
  write(project.root, "src/b.ts", "changed\n");
  const listing = await recorder.describe();
  expect(listing.map((item) => item.prompt)).toEqual(["second", "first"]);
  expect(listing.map((item) => item.files)).toEqual([1, 2]);
  expect(listing[1]?.changed.sort()).toEqual(["a.txt", "n1.txt"]);
});

test("retention keeps only the newest snapshots and drops the oldest", async () => {
  const project = makeProject();
  const recorder = recorderFor(project, { maxSnapshots: 3 });
  for (let i = 0; i < 5; i += 1) {
    recorder.beginTurn({ archiveIndex: i * 2, prompt: `turn ${i}` });
    write(project.root, "a.txt", `v${i}\n`);
    await recorder.beforeMutation();
  }
  expect(recorder.entries().map((entry) => entry.prompt)).toEqual(["turn 2", "turn 3", "turn 4"]);
});

test("restoreFiles takes a pre-rewind snapshot first, so the rewind is undoable", async () => {
  const project = makeProject();
  const recorder = recorderFor(project);
  recorder.beginTurn({ archiveIndex: 0, prompt: "edit" });
  await recorder.beforeMutation();
  const target = recorder.entries()[0]!;
  write(project.root, "a.txt", "edited\n");
  const outcome = await recorder.restoreFiles(target.seq);
  expect(outcome.ok).toBe(true);
  expect(read(project.root, "a.txt")).toBe("alpha\n");
  const pre = recorder.entries().find((entry) => entry.kind === "pre-rewind");
  expect(pre).toBeDefined();
  const undo = await recorder.restoreFiles(pre!.seq);
  expect(undo.ok).toBe(true);
  expect(read(project.root, "a.txt")).toBe("edited\n");
});

test("restoreFiles refuses an unknown snapshot", async () => {
  const project = makeProject();
  const recorder = recorderFor(project);
  expect(await recorder.restoreFiles(99)).toEqual({ ok: false, reason: "Snapshot 99 no longer exists." });
});

test("retention never prunes the snapshot being restored before the restore ran", async () => {
  const project = makeProject();
  const recorder = recorderFor(project, { maxSnapshots: 2 });
  recorder.beginTurn({ archiveIndex: 0, prompt: "old" });
  await recorder.beforeMutation();
  write(project.root, "a.txt", "later\n");
  recorder.beginTurn({ archiveIndex: 2, prompt: "new" });
  await recorder.beforeMutation();
  const oldest = recorder.entries()[0]!;
  const outcome = await recorder.restoreFiles(oldest.seq);
  expect(outcome.ok).toBe(true);
  expect(read(project.root, "a.txt")).toBe("alpha\n");
});
