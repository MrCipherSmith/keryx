import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NOTE_MAX_CHARS,
  NOTES_MAX_TOKENS,
  SlateNoteRefusedError,
  appendSeed,
  appendTrailEntry,
  estimateNotesTokens,
  readSlate,
  renderAnchorsBlock,
  writeNote,
  writeSlate,
  type Slate,
} from "./slate";
import { estimateMessageTokens } from "../harness/provider/context-guard";
import { FRAME_TRAIL_TOKENS, renderMemoryFrame } from "./slate-frame";
import { recordSlateSessionTrail, detachSlateSession, type SlateSessionRef } from "./slate-lifecycle";

const ts = "2026-10-02T00:00:00.000Z";

function baseSlate(overrides: Partial<Slate> = {}): Slate {
  return { anchors: { root: "/repo", touched: [] }, course: {}, seeds: [], ...overrides };
}

async function openedDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-slate-wm-"));
  await writeSlate(dir, () => baseSlate());
  return dir;
}

test("a legacy slate.json with no trail and no notes still loads and accepts the new shelves", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-slate-wm-"));
  await writeFile(
    path.join(dir, "slate.json"),
    JSON.stringify({ anchors: { root: "/repo", touched: ["a.ts"] }, course: {}, seeds: [{ id: "s1", text: "old", ts }] }),
  );
  const loaded = await readSlate(dir);
  expect(loaded?.trail).toBeUndefined();
  expect(loaded?.notes).toBeUndefined();
  expect(loaded?.seeds).toHaveLength(1);

  const entry = await appendTrailEntry(dir, { tool: "read_file", digest: "a.ts", outcome: "ok", ts });
  expect(entry?.step).toBe(1);
  const note = await writeNote(dir, "plan", "do the thing", ts);
  expect(note.stored?.text).toBe("do the thing");
  const after = await readSlate(dir);
  // the legacy fields survive both writes untouched
  expect(after?.seeds).toHaveLength(1);
  expect(after?.anchors.touched).toEqual(["a.ts"]);
});

test("Trail steps are assigned by the store, strictly increasing, and two concurrent appends never share a step", async () => {
  const dir = await openedDir();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => appendTrailEntry(dir, { tool: `t${i}`, digest: `d${i}`, outcome: "ok", ts })),
  );
  const steps = results.map((r) => r?.step ?? -1).sort((a, b) => a - b);
  expect(steps).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  const slate = await readSlate(dir);
  expect(slate?.trail?.map((e) => e.step)).toHaveLength(12);
});

test("Trail digests and file paths are redacted before they reach disk", async () => {
  const dir = await openedDir();
  await appendTrailEntry(dir, {
    tool: "shell_exec",
    digest: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789'",
    outcome: "ok",
    ts,
    files: ["/repo/.env.local"],
  });
  const raw = await readFile(path.join(dir, "slate.json"), "utf8");
  expect(raw).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
});

test("the stored Trail has no cap: past the old 1500 entries nothing is dropped and steps keep rising", async () => {
  const dir = await openedDir();
  const many = Array.from({ length: 1600 }, (_, i) => ({ step: i + 1, tool: "read_file", digest: "x", outcome: "ok" as const, ts }));
  await writeSlate(dir, (prev) => ({ ...(prev as Slate), trail: many }));
  const next = await appendTrailEntry(dir, { tool: "read_file", digest: "y", outcome: "ok", ts });
  expect(next?.step).toBe(1601);
  const slate = await readSlate(dir);
  expect(slate?.trail).toHaveLength(1601);
  expect(slate?.trail?.[0]?.step).toBe(1);
});

test("what the frame sends of a long Trail is bounded by its token budget, not by the entry count", () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ step: i + 1, tool: "read_file", digest: `path: src/dir/file-${i}.ts`, outcome: "ok" as const, ts }));
  const opts = { nonce: "N", scrub: (s: string) => s, ts };
  const tokens = (n: number): number => estimateMessageTokens({ content: renderMemoryFrame({ trail: entries(n) }, opts) ?? "" });
  const small = tokens(300);
  const huge = tokens(20_000);
  // Twenty thousand entries cost about what three hundred do, and sit near the 2,500-token Trail budget.
  expect(huge).toBeLessThan(small + 200);
  expect(huge).toBeLessThan(FRAME_TRAIL_TOKENS + 400);
  expect(renderMemoryFrame({ trail: entries(20_000) }, opts)).toContain("older ones via slate_trail");
});

test("a Trail entry for a session with no open slate is a no-op that creates nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-slate-wm-"));
  expect(await appendTrailEntry(dir, { tool: "read_file", digest: "x", outcome: "ok", ts })).toBeUndefined();
  expect(await readSlate(dir)).toBeUndefined();
});

test("a detached slate session ref writes no Trail entry into the slate its successor holds", async () => {
  const dir = await openedDir();
  const ref: SlateSessionRef = { dir, cwd: "/repo", opened: true };
  expect((await recordSlateSessionTrail(ref, { tool: "a", digest: "a", outcome: "ok", ts }))?.step).toBe(1);
  detachSlateSession(ref);
  expect(await recordSlateSessionTrail(ref, { tool: "b", digest: "b", outcome: "ok", ts })).toBeUndefined();
  expect((await readSlate(dir))?.trail?.map((e) => e.tool)).toEqual(["a"]);
});

test("notes: set, replace and delete", async () => {
  const dir = await openedDir();
  await writeNote(dir, "goal", "first", ts);
  await writeNote(dir, "goal", "second", ts);
  await writeNote(dir, "other", "keep", ts);
  expect((await readSlate(dir))?.notes).toEqual({ goal: { text: "second", ts }, other: { text: "keep", ts } });
  const del = await writeNote(dir, "goal", undefined, ts);
  expect(del.deleted).toBe(true);
  expect(Object.keys((await readSlate(dir))?.notes ?? {})).toEqual(["other"]);
  expect((await writeNote(dir, "missing", undefined, ts)).deleted).toBe(false);
});

test("a note is redacted and cut to the per-note character cap", async () => {
  const dir = await openedDir();
  const r = await writeNote(dir, "big", `token sk-abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(NOTE_MAX_CHARS * 2)}`, ts);
  expect(r.truncated).toBe(true);
  expect(r.stored?.text.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
  expect(r.stored?.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
});

test("the notes shelf refuses a write past the token cap, says why, and stores nothing", async () => {
  const dir = await openedDir();
  const chunk = "alpha beta gamma delta ".repeat(80).slice(0, NOTE_MAX_CHARS);
  let i = 0;
  let refused: unknown;
  while (refused === undefined && i < 100) {
    try {
      await writeNote(dir, `n${i}`, chunk, ts);
      i += 1;
    } catch (error) {
      refused = error;
    }
  }
  expect(refused).toBeInstanceOf(SlateNoteRefusedError);
  expect((refused as Error).message).toContain(String(NOTES_MAX_TOKENS));
  expect((refused as Error).message).toContain("Delete");
  const slate = await readSlate(dir);
  expect(Object.keys(slate?.notes ?? {})).toHaveLength(i);
  expect(estimateNotesTokens(slate?.notes)).toBeLessThanOrEqual(NOTES_MAX_TOKENS);
  // replacing an existing note with a shorter one still works at the cap
  await writeNote(dir, "n0", "short", ts);
});

test("a note with an invalid key is refused", async () => {
  const dir = await openedDir();
  await expect(writeNote(dir, "../etc", "x", ts)).rejects.toBeInstanceOf(SlateNoteRefusedError);
});

test("a note write with no open slate is refused, not fabricated", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-slate-wm-"));
  await expect(writeNote(dir, "k", "v", ts)).rejects.toBeInstanceOf(SlateNoteRefusedError);
  expect(await readSlate(dir)).toBeUndefined();
});

test("Notes and Trail never leak into the Anchors block, and Seeds stay append-only beside them", async () => {
  const dir = await openedDir();
  await writeNote(dir, "secretplan", "NOTE-SENTINEL", ts);
  await appendTrailEntry(dir, { tool: "read_file", digest: "TRAIL-SENTINEL", outcome: "ok", ts });
  await appendSeed(dir, { id: "s1", text: "seed text", ts });
  const slate = (await readSlate(dir)) as Slate;
  const block = renderAnchorsBlock(slate.anchors);
  expect(block).not.toContain("NOTE-SENTINEL");
  expect(block).not.toContain("TRAIL-SENTINEL");
  expect(block.toLowerCase()).not.toContain("seeds");
  expect(slate.seeds.map((s) => s.id)).toEqual(["s1"]);
  expect(slate.notes?.secretplan?.text).toBe("NOTE-SENTINEL");
});
