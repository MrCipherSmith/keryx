import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNotFound } from "../lib/fs";
import {
  appendSeed,
  archiveSlate,
  dedupeSeeds,
  openSlateAtomic,
  readSlate,
  renderAnchorsBlock,
  writeSlate,
  type Slate,
  type SlateAnchors,
  type SlateSeed,
} from "./slate";

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

async function terminalStateExists(dir: string): Promise<boolean> {
  try {
    await readFile(path.join(dir, "terminal-state.json"), "utf8");
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

// --- F-002 review fix (flow 165): openSlateAtomic clears a stale sibling ---
// --- terminal-state.json on every (re-)open ---------------------------------

test("F-002 fix: openSlateAtomic removes a sibling terminal-state.json on a fresh (re-)open, since a re-open supersedes any prior stop record", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "terminal-state.json"), `${JSON.stringify({ status: "blocked", reason: "budget_exhausted" })}\n`);
  expect(await terminalStateExists(dir)).toBe(true);

  const fresh = await openSlateAtomic(dir, () => "resume-attempt-1", () => baseSlate({ seeds: [{ id: "seed-1", text: "fresh attempt", ts: time }] }));

  expect(await terminalStateExists(dir)).toBe(false);
  expect(await readSlate(dir)).toEqual(fresh);
});

test("F-002 fix: openSlateAtomic with no terminal-state.json on disk is unaffected — clearing is a no-op, not an error", async () => {
  const dir = await tempDir();
  expect(await terminalStateExists(dir)).toBe(false);
  await expect(openSlateAtomic(dir, () => "attempt-1", () => baseSlate())).resolves.toBeDefined();
  expect(await terminalStateExists(dir)).toBe(false);
});

test("F-002 fix: openSlateAtomic still archives an unclosed prior slate.json exactly as before, in addition to clearing terminal-state.json", async () => {
  const dir = await tempDir();
  await writeSlate(dir, () => baseSlate({ seeds: [{ id: "old-seed", text: "unclosed prior attempt", ts: time }] }));
  await writeFile(path.join(dir, "terminal-state.json"), `${JSON.stringify({ status: "blocked", reason: "ask_user_unanswerable" })}\n`);

  const fresh = await openSlateAtomic(dir, () => "attempt-archive-check", () => baseSlate({ seeds: [{ id: "new-seed", text: "fresh attempt", ts: time }] }));

  const archived = JSON.parse(await readFile(path.join(dir, "slate-archive", "attempt-archive-check.json"), "utf8"));
  expect((archived.seeds ?? []).map((seed: SlateSeed) => seed.id)).toEqual(["old-seed"]);
  expect((fresh.seeds ?? []).map((seed) => seed.id)).toEqual(["new-seed"]);
  expect(await terminalStateExists(dir)).toBe(false);
});

test("appendSeed appends to an already-open slate's seeds array, append-only", async () => {
  const dir = await tempDir();
  await writeSlate(dir, () => baseSlate({ seeds: [{ id: "seed-1", text: "first seed", ts: time }] }));
  const updated = await appendSeed(dir, { id: "seed-2", text: "second seed", ts: time });
  expect(updated.seeds.map((seed) => seed.id)).toEqual(["seed-1", "seed-2"]);
  const persisted = await readSlate(dir);
  expect(persisted?.seeds.map((seed) => seed.id)).toEqual(["seed-1", "seed-2"]);
});

test("appendSeed preserves an optional kind tag", async () => {
  const dir = await tempDir();
  await writeSlate(dir, () => baseSlate());
  const updated = await appendSeed(dir, { id: "seed-1", text: "tagged seed", ts: time, kind: "risk" });
  expect(updated.seeds[0]?.kind).toBe("risk");
});

test("appendSeed throws when no slate is open in the session dir (caller bug, not a runtime condition to swallow)", async () => {
  const dir = await tempDir();
  await expect(appendSeed(dir, { id: "seed-1", text: "orphan seed", ts: time })).rejects.toThrow();
  expect(await readSlate(dir)).toBeUndefined();
});

test("dedupeSeeds collapses two Seeds with identical trimmed text to one", () => {
  const seeds: SlateSeed[] = [
    { id: "a", text: "the cache invalidates too eagerly", ts: time },
    { id: "b", text: "the cache invalidates too eagerly", ts: time },
  ];
  const result = dedupeSeeds(seeds);
  expect(result.map((seed) => seed.id)).toEqual(["a"]);
});

test("dedupeSeeds keeps a Seed whose only difference from an existing one is leading/trailing whitespace, deduped to the first occurrence", () => {
  const seeds: SlateSeed[] = [
    { id: "a", text: "  the cache invalidates too eagerly  ", ts: time },
    { id: "b", text: "the cache invalidates too eagerly", ts: time },
  ];
  const result = dedupeSeeds(seeds);
  expect(result.map((seed) => seed.id)).toEqual(["a"]);
});

test("dedupeSeeds keeps two Seeds whose texts differ only by internal whitespace, since trim() does not normalize internal whitespace", () => {
  const seeds: SlateSeed[] = [
    { id: "a", text: "foo  bar", ts: time },
    { id: "b", text: "foo bar", ts: time },
  ];
  const result = dedupeSeeds(seeds);
  expect(result.map((seed) => seed.id).sort()).toEqual(["a", "b"]);
});

test("dedupeSeeds keeps two Seeds with genuinely different text", () => {
  const seeds: SlateSeed[] = [
    { id: "a", text: "first distinct seed", ts: time },
    { id: "b", text: "second distinct seed", ts: time },
  ];
  const result = dedupeSeeds(seeds);
  expect(result.map((seed) => seed.id).sort()).toEqual(["a", "b"]);
});

test("dedupeSeeds on an empty array returns an empty array", () => {
  expect(dedupeSeeds([])).toEqual([]);
});

test("dedupeSeeds does not mutate its input array", () => {
  const seeds: SlateSeed[] = [
    { id: "a", text: "same text", ts: time },
    { id: "b", text: "same text", ts: time },
  ];
  const snapshot = JSON.parse(JSON.stringify(seeds));
  dedupeSeeds(seeds);
  expect(seeds).toEqual(snapshot);
});

// --- SLATE-2a: renderAnchorsBlock (Anchors auto-inject, AC4/AC5) ---
//
// Contract under test (not yet implemented — T7 builds this):
//   renderAnchorsBlock(anchors: SlateAnchors, opts?: { maxTokens?: number }): string
// Renders root/tree/runtime/touched (most-recent-touched-entry-first) as a
// text block, bounded via `assembleContext` (src/ctx/assembly.ts) so the
// render never exceeds the token budget — trimming drops the OLDEST touched
// entries, not the newest. `root` is always a required candidate.

test("renderAnchorsBlock renders root/tree/runtime/touched fully when everything fits the budget", () => {
  const anchors: SlateAnchors = {
    root: "/project/root",
    tree: "feature/slate-phase3",
    runtime: { provider: "anthropic", model: "claude-sonnet" },
    touched: ["src/a.ts", "src/b.ts"],
  };
  const block = renderAnchorsBlock(anchors);
  expect(block).toContain("/project/root");
  expect(block).toContain("feature/slate-phase3");
  expect(block).toContain("anthropic");
  expect(block).toContain("claude-sonnet");
  expect(block).toContain("src/a.ts");
  expect(block).toContain("src/b.ts");
});

test("renderAnchorsBlock trims touched entries under a small maxTokens budget, keeping the MOST RECENTLY touched entries and dropping the oldest", () => {
  const touched = Array.from(
    { length: 30 },
    (_, i) => `src/module-${String(i).padStart(2, "0")}-quite-a-long-descriptive-file-name.ts`,
  );
  const anchors: SlateAnchors = { root: "/project/root", touched };

  const block = renderAnchorsBlock(anchors, { maxTokens: 60 });

  // The most recently touched entry (end of the append-only array) survives.
  expect(block).toContain(touched[touched.length - 1] as string);
  // The oldest entry (start of the array) is dropped by the trim.
  expect(block).not.toContain(touched[0] as string);
});

test("renderAnchorsBlock always includes root even under a very small maxTokens budget (root is a required candidate)", () => {
  const touched = Array.from({ length: 20 }, (_, i) => `src/file-${i}-with-a-long-enough-name-to-cost-tokens.ts`);
  const anchors: SlateAnchors = { root: "/project/root", touched };

  const block = renderAnchorsBlock(anchors, { maxTokens: 20 });

  expect(block).toContain("/project/root");
});

test("review finding 1: renderAnchorsBlock redacts a secret-shaped touched entry before it ever reaches the rendered block (mirrors slate-terminal-state.test.ts's own F-004 redaction test)", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const anchors: SlateAnchors = { root: "/project/root", touched: [`src/config-with-token=${token}.ts`] };

  const block = renderAnchorsBlock(anchors);

  expect(block).not.toContain(token);
  expect(block).toContain("[REDACTED:");
});

test("review finding 1: renderAnchorsBlock still redacts a secret-shaped touched entry that survives a tight maxTokens budget", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const anchors: SlateAnchors = {
    root: "/project/root",
    touched: ["src/old-file.ts", `src/config-with-token=${token}.ts`],
  };

  // Tight enough to drop the older entry but keep the most-recent one.
  const block = renderAnchorsBlock(anchors, { maxTokens: 30 });

  expect(block).not.toContain(token);
  expect(block).toContain("[REDACTED:");
});

test("renderAnchorsBlock never contains the literal substrings 'course' or 'seeds' (case-insensitive) — defensive structural guard for AC5", () => {
  const anchors: SlateAnchors = {
    root: "/project/root",
    tree: "main",
    runtime: { provider: "openai", model: "gpt-4" },
    touched: ["src/a.ts", "src/b.ts", "src/c.ts"],
  };
  const block = renderAnchorsBlock(anchors).toLowerCase();
  expect(block).not.toContain("course");
  expect(block).not.toContain("seeds");
});
