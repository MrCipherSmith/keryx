import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveSlate, readSlate, writeSlate, type Slate } from "./slate";

const time = "2026-08-15T00:00:00.000Z";

function baseSlate(overrides: Partial<Slate> = {}): Slate {
  return { anchors: { root: ".", touched: [] }, course: {}, seeds: [], ...overrides };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-slate-"));
}

test("two overlapping writeSlate calls against the same session dir never lose data to a read-modify-write race", async () => {
  const dir = await tempDir();
  await writeSlate(dir, () => baseSlate());
  const [a, b] = await Promise.all([
    writeSlate(dir, (prev) => ({ ...baseSlate(), seeds: [...(prev?.seeds ?? []), { id: "seed-a", text: "writer a", ts: time }] })),
    writeSlate(dir, (prev) => ({ ...baseSlate(), seeds: [...(prev?.seeds ?? []), { id: "seed-b", text: "writer b", ts: time }] })),
  ]);
  expect(a.seeds.length + b.seeds.length).toBeGreaterThanOrEqual(2);
  const final = await readSlate(dir);
  expect(final).toBeDefined();
  const ids = (final?.seeds ?? []).map((seed) => seed.id).sort();
  expect(ids).toEqual(["seed-a", "seed-b"]);
});

test("writeSlate's update function is applied to the already-committed value, not a stale pre-lock read", async () => {
  const dir = await tempDir();
  const seen: Array<string[]> = [];
  await Promise.all([
    writeSlate(dir, (prev) => {
      const priorIds = (prev?.seeds ?? []).map((seed) => seed.id);
      seen.push(priorIds);
      return { ...baseSlate(), seeds: [...(prev?.seeds ?? []), { id: "first", text: "first", ts: time }] };
    }),
    writeSlate(dir, (prev) => {
      const priorIds = (prev?.seeds ?? []).map((seed) => seed.id);
      seen.push(priorIds);
      return { ...baseSlate(), seeds: [...(prev?.seeds ?? []), { id: "second", text: "second", ts: time }] };
    }),
  ]);
  // One of the two writers must have observed the other's already-committed
  // seed — a naive read-before-both-locks API could never produce this.
  expect(seen.some((ids) => ids.includes("first") || ids.includes("second"))).toBe(true);
  const final = await readSlate(dir);
  expect((final?.seeds ?? []).map((seed) => seed.id).sort()).toEqual(["first", "second"]);
});

test("readSlate returns undefined when no slate.json exists yet", async () => {
  const dir = await tempDir();
  expect(await readSlate(dir)).toBeUndefined();
});

test("archiveSlate moves the prior slate.json to slate-archive/<attemptId>.json before a fresh write establishes a new one", async () => {
  const dir = await tempDir();
  const preArchive = await writeSlate(dir, () => baseSlate({ seeds: [{ id: "old-seed", text: "from the prior attempt", ts: time }] }));
  await archiveSlate(dir, "attempt-1");

  const archived = JSON.parse(await readFile(path.join(dir, "slate-archive", "attempt-1.json"), "utf8"));
  expect(archived).toEqual(preArchive);

  const liveAfterArchive = await readSlate(dir);
  expect(liveAfterArchive).toBeUndefined();

  const fresh = await writeSlate(dir, () => baseSlate({ seeds: [{ id: "new-seed", text: "from the fresh attempt", ts: time }] }));
  const liveAfterFreshWrite = await readSlate(dir);
  expect(liveAfterFreshWrite).toEqual(fresh);
  expect((liveAfterFreshWrite?.seeds ?? []).map((seed) => seed.id)).toEqual(["new-seed"]);
  expect((liveAfterFreshWrite?.seeds ?? []).map((seed) => seed.id)).not.toContain("old-seed");

  // The archived copy is untouched by the fresh write — no merge occurred.
  const archivedAfterFreshWrite = JSON.parse(await readFile(path.join(dir, "slate-archive", "attempt-1.json"), "utf8"));
  expect(archivedAfterFreshWrite).toEqual(preArchive);
});

test("a second archiveSlate call against a session dir whose slate.json was never removed archives the prior slate under its own attemptId", async () => {
  const dir = await tempDir();
  const firstAttempt = await writeSlate(dir, () => baseSlate({ seeds: [{ id: "seed-attempt-1", text: "attempt 1", ts: time }] }));
  await archiveSlate(dir, "attempt-1");
  const secondAttempt = await writeSlate(dir, () => baseSlate({ seeds: [{ id: "seed-attempt-2", text: "attempt 2", ts: time }] }));
  await archiveSlate(dir, "attempt-2");

  const archivedFirst = JSON.parse(await readFile(path.join(dir, "slate-archive", "attempt-1.json"), "utf8"));
  const archivedSecond = JSON.parse(await readFile(path.join(dir, "slate-archive", "attempt-2.json"), "utf8"));
  expect(archivedFirst).toEqual(firstAttempt);
  expect(archivedSecond).toEqual(secondAttempt);
  expect(await readSlate(dir)).toBeUndefined();
});

test("archiveSlate on a session dir with no slate.json yet is a no-op, not an error", async () => {
  const dir = await tempDir();
  await expect(archiveSlate(dir, "attempt-never-written")).resolves.toBeUndefined();
  expect(await readSlate(dir)).toBeUndefined();
});
