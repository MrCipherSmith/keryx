import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  closeSlate,
  closeSlateSession,
  computeAnchors,
  ensureSlateOpened,
  isClosePhrase,
  isCourseDone,
  mintTimestampAttemptId,
  openSlate,
  recordSlateTouch,
  type SlateSessionRef,
} from "./slate-lifecycle";
import { readSlate, writeSlate, type Slate } from "./slate";
import type { CourseProjection } from "./slate-course";

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-slate-lifecycle-cwd-"));
}

async function tempSessionDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-slate-lifecycle-dir-"));
}

let idCounter = 0;
function fixedMinter(): () => string {
  idCounter = 0;
  return () => `attempt-${idCounter++}`;
}

test("computeAnchors resolves root from live cwd and starts with empty touched", async () => {
  const cwd = await tempCwd();
  const anchors = await computeAnchors({ cwd });
  expect(anchors.root.length).toBeGreaterThan(0);
  expect(anchors.touched).toEqual([]);
  expect(anchors.runtime).toBeUndefined();
});

test("computeAnchors includes runtime when provided", async () => {
  const cwd = await tempCwd();
  const anchors = await computeAnchors({ cwd, runtime: { provider: "anthropic", model: "claude" } });
  expect(anchors.runtime).toEqual({ provider: "anthropic", model: "claude" });
});

test("openSlate on a session dir with no prior slate.json writes a fresh slate with no archive", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  const mint = fixedMinter();
  const slate = await openSlate({ dir, cwd, mintAttemptId: mint });
  expect(slate.course).toEqual({});
  expect(slate.seeds).toEqual([]);
  expect(slate.anchors.touched).toEqual([]);
  const persisted = await readSlate(dir);
  expect(persisted).toEqual(slate);
});

test("AC1: openSlate against a session dir with a stale/wrong prior slate.json always recomputes Anchors fresh, never carries the stale value over", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  // Simulate a crash: a slate.json already exists with anchors from a
  // stale/different repo state (a bogus root, and touched files that were
  // never actually touched this attempt).
  await writeSlate(dir, () => ({
    anchors: { root: "/bogus/stale/root", touched: ["stale-file.ts"], tree: "stale-branch" },
    course: { flowRef: "999" },
    seeds: [{ id: "stale-seed", text: "from a dead attempt", ts: "2020-01-01T00:00:00.000Z" }],
  }));

  const mint = fixedMinter();
  const fresh = await openSlate({ dir, cwd, mintAttemptId: mint });

  // The fresh slate reflects a REAL computation from live repo state, not
  // the stale carried-over value.
  expect(fresh.anchors.root).not.toBe("/bogus/stale/root");
  expect(fresh.anchors.touched).toEqual([]);
  expect(fresh.anchors.tree).not.toBe("stale-branch");
  expect(fresh.course).toEqual({});
  expect(fresh.seeds).toEqual([]);

  // The stale slate was archived, not silently discarded.
  const archived = JSON.parse(await readFile(path.join(dir, "slate-archive", "attempt-0.json"), "utf8")) as Slate;
  expect(archived.anchors.root).toBe("/bogus/stale/root");
  expect(archived.seeds[0]?.id).toBe("stale-seed");

  const persisted = await readSlate(dir);
  expect(persisted).toEqual(fresh);
});

test("F-001: two concurrent openSlate calls against the same session dir never silently lose data — the losing call's slate is archived, not clobbered", async () => {
  const dir = await tempSessionDir();
  const cwdA = await tempCwd();
  const cwdB = await tempCwd();
  let counter = 0;
  const mint = (): string => `attempt-${counter++}`;

  const [slateA, slateB] = await Promise.all([
    openSlate({ dir, cwd: cwdA, mintAttemptId: mint }),
    openSlate({ dir, cwd: cwdB, mintAttemptId: mint }),
  ]);

  // Both calls resolve with a distinct, genuinely-computed Slate (different
  // `anchors.root` since cwdA !== cwdB).
  expect(slateA.anchors.root).not.toBe(slateB.anchors.root);

  const live = await readSlate(dir);
  expect(live).toBeDefined();
  const liveSlate = live as Slate;
  // The live slate must be exactly one of the two calls' own results — never
  // a merged/corrupted hybrid.
  expect([slateA, slateB]).toContainEqual(liveSlate);

  const archiveDir = path.join(dir, "slate-archive");
  const archivedFiles = await readdir(archiveDir).catch(() => [] as string[]);
  // The LOSING call must have been archived, not silently discarded — this
  // is exactly what the old three-separate-lock-holds `openSlate` could
  // fail to do: both calls could see no prior slate.json (unlocked read
  // before either had written), so neither would archive, and the second
  // writer's `writeSlate` would clobber the first's write with no archive
  // step ever having observed it.
  expect(archivedFiles.length).toBe(1);
  const archived = JSON.parse(await readFile(path.join(archiveDir, archivedFiles[0] as string), "utf8")) as Slate;
  const loser = live?.anchors.root === slateA.anchors.root ? slateB : slateA;
  expect(archived.anchors.root).toBe(loser.anchors.root);
  expect(archived).toEqual(loser);
});

test("F-002: ensureSlateOpened re-opens when ref.opened is stale (a second process already closed the slate on disk)", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  const mint = fixedMinter();
  const ref: SlateSessionRef = { dir, cwd, opened: false };

  await ensureSlateOpened(ref, mint);
  expect(ref.opened).toBe(true);
  const firstOpen = await readSlate(dir);
  expect(firstOpen).toBeDefined();

  // Simulate a second process (sharing the same session dir) closing the
  // slate without this process's in-memory `ref` knowing about it.
  await closeSlate(dir, mint);
  expect(await readSlate(dir)).toBeUndefined();

  // `ref.opened` is now stale (still `true`) — a naive `if (ref.opened)
  // return` would permanently skip re-opening here, leaving `readSlate(dir)`
  // `undefined` for the rest of this attempt (nothing would ever write
  // `slate.json` back). The fix must actually perform a fresh open.
  await ensureSlateOpened(ref, mint);
  expect(ref.opened).toBe(true);
  const reopened = await readSlate(dir);
  expect(reopened).toBeDefined();
});

test("closeSlate archives the live slate and clears it; a no-op when nothing is open", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  const mint = fixedMinter();
  await openSlate({ dir, cwd, mintAttemptId: mint });
  expect(await readSlate(dir)).toBeDefined();

  await closeSlate(dir, mint);
  expect(await readSlate(dir)).toBeUndefined();

  // Closing again with nothing live is a no-op, not an error.
  await expect(closeSlate(dir, mint)).resolves.toBeUndefined();
});

test("ensureSlateOpened opens once per ref; a second call with opened already true does not re-archive/re-create", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  const mint = fixedMinter();
  const ref: SlateSessionRef = { dir, cwd, opened: false };

  await ensureSlateOpened(ref, mint);
  expect(ref.opened).toBe(true);
  const afterFirst = await readSlate(dir);
  expect(afterFirst).toBeDefined();

  // Simulate accumulated progress this attempt (a Seed written by the model).
  await writeSlate(dir, (prev) => ({ ...(prev as Slate), seeds: [{ id: "s1", text: "keep me", ts: "2026-08-16T00:00:00.000Z" }] }));

  await ensureSlateOpened(ref, mint);
  const afterSecond = await readSlate(dir);
  // Nothing was archived/reset — the accumulated Seed survives.
  expect(afterSecond?.seeds.map((s) => s.id)).toEqual(["s1"]);

  // No slate-archive/ dir was ever created — ensureSlateOpened's second call
  // truly never touched archiveSlate.
  const archived = await readFile(path.join(dir, "slate-archive", "attempt-0.json"), "utf8").catch(() => undefined);
  expect(archived).toBeUndefined();
});

test("ensureSlateOpened on a ref whose opened flag is false but a slate.json already exists (a fresh process resuming a crashed attempt) archives the stale slate first (AC3)", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await writeSlate(dir, () => ({ anchors: { root: "/stale", touched: [] }, course: {}, seeds: [] }));

  const mint = fixedMinter();
  const ref: SlateSessionRef = { dir, cwd, opened: false }; // fresh process: opened always starts false
  await ensureSlateOpened(ref, mint);

  const archived = await readFile(path.join(dir, "slate-archive", "attempt-0.json"), "utf8");
  expect(JSON.parse(archived).anchors.root).toBe("/stale");
  const live = await readSlate(dir);
  expect(live?.anchors.root).not.toBe("/stale");
});

test("closeSlateSession archives and resets ref.opened to false; safe on undefined", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  const mint = fixedMinter();
  const ref: SlateSessionRef = { dir, cwd, opened: false };
  await ensureSlateOpened(ref, mint);
  expect(ref.opened).toBe(true);

  await closeSlateSession(ref, mint);
  expect(ref.opened).toBe(false);
  expect(await readSlate(dir)).toBeUndefined();

  await expect(closeSlateSession(undefined, mint)).resolves.toBeUndefined();
});

test("isCourseDone is true only for a bound Course whose flow snapshot is done", () => {
  const unbound: CourseProjection = { state: "unbound" };
  expect(isCourseDone(unbound)).toBe(false);

  const inProgress: CourseProjection = {
    state: "bound",
    flowRef: { uri: "001", snapshot: "in-progress", revision: "r1" },
    completed: [],
    next: ["T1"],
    blocked: [],
  };
  expect(isCourseDone(inProgress)).toBe(false);

  const done: CourseProjection = {
    state: "bound",
    flowRef: { uri: "001", snapshot: "done", revision: "r2" },
    completed: ["T1"],
    next: [],
    blocked: [],
  };
  expect(isCourseDone(done)).toBe(true);
});

test("isClosePhrase recognizes canonical multi-word close phrases, case-insensitively and whitespace-robustly", () => {
  expect(isClosePhrase("close slate")).toBe(true);
  expect(isClosePhrase("CLOSE THE SLATE please")).toBe(true);
  expect(isClosePhrase("ok let's wrap up now")).toBe(true);
  expect(isClosePhrase("task   is    done")).toBe(true);
  expect(isClosePhrase("I'm done, thanks")).toBe(true);
});

test("isClosePhrase does not fire on an incidental lone 'done' inside an unrelated sentence", () => {
  expect(isClosePhrase("let me know when the tests are done running")).toBe(false);
  expect(isClosePhrase("run the build")).toBe(false);
  expect(isClosePhrase("")).toBe(false);
});

test("F-007: isClosePhrase does not fire when a close phrase is embedded in a subordinate/conditional clause of a longer instruction", () => {
  // A close-phrase substring appearing anywhere used to be enough to
  // false-positive-close the slate, even when the sentence is asking for a
  // FUTURE, conditional action rather than declaring the session done now.
  expect(isClosePhrase("mark this task complete once tests pass")).toBe(false);
  expect(isClosePhrase("wrap up when you get a chance")).toBe(false);
  expect(isClosePhrase("close the slate if the review comes back clean")).toBe(false);
});

test("F-007: isClosePhrase still fires when the close phrase is not part of a conditional clause (regression guard)", () => {
  expect(isClosePhrase("close slate")).toBe(true);
  expect(isClosePhrase("ok let's wrap up now")).toBe(true);
  expect(isClosePhrase("task complete, thanks")).toBe(true);
});

test("review finding: isClosePhrase does not fire when a close phrase introduces a direct object (an instruction, not a declaration)", () => {
  expect(isClosePhrase("can you wrap up the leftover code review notes into one summary")).toBe(false);
  expect(isClosePhrase("wrap up this section before moving on")).toBe(false);
  expect(isClosePhrase("wrap up your notes and send them over")).toBe(false);
});

test("review finding: isClosePhrase scans the whole remainder for a subordinating word, not just the immediate next word", () => {
  expect(isClosePhrase("wrap up, but only after tests pass")).toBe(false);
  expect(isClosePhrase("task complete, well, once you confirm it")).toBe(false);
});

// --- SLATE-2a: recordSlateTouch (touched-tracking + change-detection, AC4) ---
//
// Contract under test (not yet implemented — T7 builds this):
//   recordSlateTouch(
//     dir: string,
//     touched: readonly string[],
//     extra?: { tree?: string; runtime?: { provider: string; model: string } },
//   ): Promise<{ changed: boolean; slate: Slate }>
// A locked read-modify-write against slate.json (via `writeSlate` — never a
// second/ad hoc lock) that appends only genuinely-new entries to
// anchors.touched (append-only, deduped against what's already there) and
// reports whether anything actually changed (touched growth OR tree/runtime
// diverging from what's stored), so callers only inject an Anchors-block
// message when there is a real change.

test("recordSlateTouch: a first call with new paths appends them to anchors.touched and reports changed", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await writeSlate(dir, () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }));

  const result = await recordSlateTouch(dir, ["src/a.ts", "src/b.ts"]);

  expect(result.changed).toBe(true);
  expect(result.slate.anchors.touched).toEqual(["src/a.ts", "src/b.ts"]);
  const persisted = await readSlate(dir);
  expect(persisted?.anchors.touched).toEqual(["src/a.ts", "src/b.ts"]);
});

test("recordSlateTouch: a second call with the SAME paths appends nothing and reports unchanged", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await writeSlate(dir, () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }));
  await recordSlateTouch(dir, ["src/a.ts", "src/b.ts"]);

  const second = await recordSlateTouch(dir, ["src/a.ts", "src/b.ts"]);

  expect(second.changed).toBe(false);
  expect(second.slate.anchors.touched).toEqual(["src/a.ts", "src/b.ts"]);
  const persisted = await readSlate(dir);
  expect(persisted?.anchors.touched).toEqual(["src/a.ts", "src/b.ts"]);
});

test("recordSlateTouch: a call that also changes runtime reports changed even when touched did not grow", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await writeSlate(dir, () => ({ anchors: { root: cwd, touched: ["src/a.ts"] }, course: {}, seeds: [] }));

  const result = await recordSlateTouch(dir, ["src/a.ts"], { runtime: { provider: "anthropic", model: "claude" } });

  expect(result.changed).toBe(true);
  expect(result.slate.anchors.touched).toEqual(["src/a.ts"]);
  expect(result.slate.anchors.runtime).toEqual({ provider: "anthropic", model: "claude" });
});

test("recordSlateTouch: a repeat call with an unchanged runtime AND no new touched paths reports unchanged", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await writeSlate(dir, () => ({
    anchors: { root: cwd, touched: ["src/a.ts"], runtime: { provider: "anthropic", model: "claude" } },
    course: {},
    seeds: [],
  }));

  const result = await recordSlateTouch(dir, ["src/a.ts"], { runtime: { provider: "anthropic", model: "claude" } });

  expect(result.changed).toBe(false);
});

test("recordSlateTouch: touched stays append-only across multiple calls — nothing is ever removed", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await writeSlate(dir, () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }));

  await recordSlateTouch(dir, ["src/a.ts"]);
  await recordSlateTouch(dir, ["src/b.ts"]);
  // "src/a.ts" is already present (must be deduped, not re-appended); "src/c.ts" is genuinely new.
  const third = await recordSlateTouch(dir, ["src/a.ts", "src/c.ts"]);

  expect(third.slate.anchors.touched).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  const persisted = await readSlate(dir);
  expect(persisted?.anchors.touched).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("recordSlateTouch: throws when no slate is open in the session dir (caller bug, mirrors appendSeed's contract — never fabricates a slate)", async () => {
  const dir = await tempSessionDir();
  await expect(recordSlateTouch(dir, ["src/a.ts"])).rejects.toThrow();
  expect(await readSlate(dir)).toBeUndefined();
});

test("mintTimestampAttemptId produces archiveSlate-safe tokens that never collide across immediate successive calls", () => {
  const a = mintTimestampAttemptId(new Date("2026-08-16T00:00:00.000Z"));
  const b = mintTimestampAttemptId(new Date("2026-08-16T00:00:00.000Z"));
  expect(a).not.toBe(b);
  expect(/^[A-Za-z0-9._-]+$/.test(a)).toBe(true);
  expect(/^[A-Za-z0-9._-]+$/.test(b)).toBe(true);
});
