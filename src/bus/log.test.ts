import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBusRefusal } from "./errors";
import {
  appendEvent,
  countRecent,
  cursorAtEnd,
  cursorAtStart,
  type EventDraft,
  pruneRotatedSegments,
  readEvents,
  readHead,
} from "./log";
import { eventsPath, headPath, rotatedSegmentPath } from "./paths";
import type { BusEvent } from "./schema";

// AC3 (reader tolerance), AC5 (rotation), seq recovery (the unit half of AC4;
// the 8-process and killed-writer tests belong to T9).

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function busRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-log-"));
  ROOTS.push(dir);
  return path.join(dir, "bus");
}

const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const T0 = Date.parse("2026-09-19T10:00:00.000Z");

function draft(body = "hello", overrides: Partial<EventDraft> = {}): EventDraft {
  return { from: { instanceId: A, name: "cli", origin: "cli" }, to: ["*"], toLabel: "@all", kind: "notice", body, ...overrides };
}

function validLine(seq: number): string {
  const event: BusEvent = {
    schemaVersion: 1,
    seq,
    id: B,
    ts: new Date(T0).toISOString(),
    from: { instanceId: A, name: "cli", origin: "cli" },
    to: ["*"],
    toLabel: "@all",
    kind: "notice",
    body: `manual ${seq}`,
  };
  return `${JSON.stringify(event)}\n`;
}

const seqs = (events: readonly BusEvent[]): number[] => events.map((event) => event.seq);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

async function readAll(root: string): Promise<BusEvent[]> {
  return (await readEvents(root, await cursorAtStart(root))).events;
}

describe("appendEvent", () => {
  test("assigns 1, 2, 3, writes one line each and head.json { seq, segment, segmentInode }", async () => {
    const root = await busRoot();
    const written = [await appendEvent(root, draft("a")), await appendEvent(root, draft("b")), await appendEvent(root, draft("c"))];

    expect(seqs(written)).toEqual([1, 2, 3]);
    const lines = (await readFile(eventsPath(root), "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as BusEvent).body)).toEqual(["a", "b", "c"]);
    const ino = (await stat(eventsPath(root))).ino;
    expect(await readHead(root)).toEqual({ seq: 3, segment: 1, segmentInode: ino });
    if (process.platform !== "win32") {
      expect((await stat(eventsPath(root))).mode & 0o777).toBe(0o600);
      expect((await stat(headPath(root))).mode & 0o777).toBe(0o600);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }
    // The lock is released and no temp file is left behind.
    expect((await readdir(root)).sort()).toEqual(["events.jsonl", "head.json"]);
  });

  test("seq recovery: a line written without its head update is not reused", async () => {
    const root = await busRoot();
    await appendEvent(root, draft());
    await appendEvent(root, draft());
    // A writer that died between its line and its head update.
    await appendFile(eventsPath(root), validLine(3), "utf8");
    expect((await readHead(root))?.seq).toBe(2);

    const next = await appendEvent(root, draft());

    expect(next.seq).toBe(4);
    expect(seqs(await readAll(root))).toEqual([1, 2, 3, 4]);
  });

  test("seq recovery: head ahead of the lines wins too", async () => {
    const root = await busRoot();
    await appendEvent(root, draft());
    const head = await readHead(root);
    await writeFile(headPath(root), JSON.stringify({ ...head, seq: 10 }), "utf8");

    expect((await appendEvent(root, draft())).seq).toBe(11);
  });

  test("a torn tail left by a crashed writer is terminated, skipped by readers, and never glued to the next line", async () => {
    const root = await busRoot();
    await appendEvent(root, draft("first"));
    await appendFile(eventsPath(root), '{"schemaVersion":1,"seq":2,"id":"', "utf8");

    const next = await appendEvent(root, draft("second"));

    expect(next.seq).toBe(2);
    expect((await readAll(root)).map((event) => event.body)).toEqual(["first", "second"]);
  });

  test("the body is redacted before it is written", async () => {
    const root = await busRoot();
    const secret = "ghp_" + "b".repeat(36);
    const event = await appendEvent(root, draft(`use ${secret} please`));

    expect(event.body).not.toContain(secret);
    expect(await readFile(eventsPath(root), "utf8")).not.toContain(secret);
  });

  test("refuses body-too-large above 2048 UTF-8 bytes and writes nothing", async () => {
    const root = await busRoot();
    await appendEvent(root, draft("x".repeat(2048)));
    let caught: unknown;
    try {
      await appendEvent(root, draft("é".repeat(1025)));
    } catch (error) {
      caught = error;
    }
    expect(isBusRefusal(caught, "body-too-large")).toBe(true);
    expect(seqs(await readAll(root))).toEqual([1]);
    expect((await readHead(root))?.seq).toBe(1);
  });

  test("refuses an invalid event (reply without replyTo, non-UUID recipient) with invalid-event", async () => {
    const root = await busRoot();
    await expect(appendEvent(root, draft("x", { kind: "reply" }))).rejects.toThrow(/invalid-event/);
    await expect(appendEvent(root, draft("x", { to: ["../../etc"], toLabel: "@x" }))).rejects.toThrow(/invalid-event/);
    expect(await readAll(root)).toEqual([]);
  });

  test("underLock runs before the seq is taken and can refuse the append", async () => {
    const root = await busRoot();
    await expect(
      appendEvent(root, draft(), {
        underLock: () => {
          throw new Error("rate-limited: test");
        },
      }),
    ).rejects.toThrow(/rate-limited/);
    expect(await readAll(root)).toEqual([]);
    expect((await appendEvent(root, draft())).seq).toBe(1);
  });
});

describe("rotation", () => {
  const small = { maxSegmentBytes: 1200 };

  test("rotates past the bound, keeps at most two rotated segments, and seq continues", async () => {
    const root = await busRoot();
    for (let i = 0; i < 40; i += 1) await appendEvent(root, draft(`m${i}`), small);

    const names = (await readdir(root)).filter((name) => name.startsWith("events.")).sort();
    const rotated = names.filter((name) => name !== "events.jsonl");
    expect(rotated.length).toBe(2);
    const head = await readHead(root);
    expect(head?.seq).toBe(40);
    expect(head?.segment).toBeGreaterThan(3);
    for (const name of names) {
      expect((await stat(path.join(root, name))).size).toBeLessThanOrEqual(1200);
    }
    // Every retained event, gap-free, ending at 40.
    const retained = seqs(await readAll(root));
    expect(retained).toEqual(range(retained[0] as number, 40));
  });

  test("a cursor whose offset is beyond the new segment's size reads every event exactly once", async () => {
    const root = await busRoot();
    for (let i = 0; i < 4; i += 1) await appendEvent(root, draft(`before ${i} ${"x".repeat(150)}`), small);
    const cursor = await cursorAtEnd(root);
    expect(cursor.offset).toBeGreaterThan(600);

    // One append rotates; the new segment then holds one short line — far
    // smaller than the old cursor offset.
    await appendEvent(root, draft(`big ${"y".repeat(400)}`), small);
    expect((await readHead(root))?.segment).toBe(cursor.segment + 1);
    expect((await stat(eventsPath(root))).size).toBeLessThan(cursor.offset);
    await appendEvent(root, draft("after"), small);

    const first = await readEvents(root, cursor);
    expect(seqs(first.events)).toEqual([5, 6]);
    const second = await readEvents(root, first.cursor);
    expect(second.events).toEqual([]);
    await appendEvent(root, draft("later"), small);
    expect(seqs((await readEvents(root, second.cursor)).events)).toEqual([7]);
  });

  test("a reader two rotations behind finishes its segment, then the one between, then the current", async () => {
    const root = await busRoot();
    await appendEvent(root, draft("one"), small);
    const cursor = await cursorAtEnd(root);
    for (let i = 0; i < 12; i += 1) await appendEvent(root, draft(`m ${"z".repeat(200)}`), small);
    expect((await readHead(root))?.segment).toBeGreaterThanOrEqual(3);

    const read = await readEvents(root, cursor);
    const retained = seqs(read.events);
    // Nothing duplicated, nothing out of order, and the tail is complete.
    expect(retained).toEqual(range(retained[0] as number, 13));
  });

  test("a reader mid-rotation (renamed, head not yet updated) finishes the old segment first", async () => {
    const root = await busRoot();
    await appendEvent(root, draft("one"));
    await appendEvent(root, draft("two"));
    const cursor = await readEvents(root, await cursorAtStart(root));
    expect(seqs(cursor.events)).toEqual([1, 2]);
    await appendEvent(root, draft("three"));
    // A rotating writer that has renamed and written its line but not head.json.
    await rename(eventsPath(root), rotatedSegmentPath(root, 1));
    await writeFile(eventsPath(root), validLine(4), "utf8");

    const read = await readEvents(root, cursor.cursor);

    expect(seqs(read.events)).toEqual([3, 4]);
    expect(read.cursor.segment).toBe(2);
  });

  test("an appender recovers a crash between the rename and the first line of the new segment", async () => {
    const root = await busRoot();
    await appendEvent(root, draft());
    await appendEvent(root, draft());
    await rename(eventsPath(root), rotatedSegmentPath(root, 1));

    const next = await appendEvent(root, draft());

    expect(next.seq).toBe(3);
    expect((await readHead(root))?.segment).toBe(2);
    expect(seqs(await readAll(root))).toEqual([1, 2, 3]);
  });

  test("rotated segments older than 7 days are deleted at the next rotation or prune", async () => {
    const root = await busRoot();
    await mkdir(root, { recursive: true });
    await writeFile(rotatedSegmentPath(root, 1), validLine(1), "utf8");
    await writeFile(rotatedSegmentPath(root, 2), validLine(2), "utf8");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(rotatedSegmentPath(root, 1), eightDaysAgo, eightDaysAgo);

    const removed = await pruneRotatedSegments(root);

    expect(removed).toEqual([rotatedSegmentPath(root, 1)]);
    expect((await readdir(root)).sort()).toEqual(["events.2.jsonl"]);
  });
});

describe("readers", () => {
  test("skip torn, invalid and unknown-version lines without throwing", async () => {
    const root = await busRoot();
    await appendEvent(root, draft("ok 1"));
    const bad = [
      "not json at all",
      JSON.stringify({ ...(JSON.parse(validLine(90)) as object), schemaVersion: 2 }),
      JSON.stringify({ ...(JSON.parse(validLine(91)) as object), id: "../x" }),
      JSON.stringify({ seq: 92 }),
      "",
    ];
    await appendFile(eventsPath(root), `${bad.join("\n")}\n`, "utf8");
    const next = await appendEvent(root, draft("ok 2"));

    // The lenient seq-recovery read sees seq 92 claimed and moves past it.
    expect(next.seq).toBe(93);
    expect((await readAll(root)).map((event) => event.body)).toEqual(["ok 1", "ok 2"]);
  });

  test("a trailing partial line stays unread until it is complete", async () => {
    const root = await busRoot();
    await appendEvent(root, draft());
    const start = await readEvents(root, await cursorAtStart(root));
    const line = validLine(2);
    await appendFile(eventsPath(root), line.slice(0, 40), "utf8");

    const partial = await readEvents(root, start.cursor);
    expect(partial.events).toEqual([]);
    expect(partial.cursor.offset).toBe(start.cursor.offset);

    await appendFile(eventsPath(root), line.slice(40), "utf8");
    expect(seqs((await readEvents(root, partial.cursor)).events)).toEqual([2]);
  });

  test("cursorAtEnd skips history; a missing log reads as empty", async () => {
    const root = await busRoot();
    expect(await readEvents(root, await cursorAtEnd(root))).toEqual({
      events: [],
      cursor: { segment: 1, inode: 0, offset: 0, seq: 0 },
    });
    await appendEvent(root, draft());
    await appendEvent(root, draft());
    const end = await cursorAtEnd(root);
    expect((await readEvents(root, end)).events).toEqual([]);
    await appendEvent(root, draft("new"));
    expect((await readEvents(root, end)).events.map((event) => event.body)).toEqual(["new"]);
  });

  test("a cursor taken before the log existed sees the first events", async () => {
    const root = await busRoot();
    const before = await cursorAtEnd(root);
    await appendEvent(root, draft("first"));
    expect(seqs((await readEvents(root, before)).events)).toEqual([1]);
  });
});

describe("countRecent", () => {
  test("counts one origin inside the window", async () => {
    const root = await busRoot();
    let now = T0;
    const clock = { now: () => now };
    await appendEvent(root, draft("old"), clock);
    now = T0 + 61_000;
    await appendEvent(root, draft("cli 1"), clock);
    await appendEvent(root, draft("cli 2"), clock);
    await appendEvent(root, draft("agent", { from: { instanceId: B, name: "release", origin: "agent" } }), clock);

    expect(await countRecent(root, { origin: "cli", sinceMs: 60_000, now: () => now })).toBe(2);
    expect(await countRecent(root, { origin: "agent", sinceMs: 60_000, now: () => now })).toBe(1);
    expect(await countRecent(root, { origin: "cli", sinceMs: 120_000, now: () => now })).toBe(3);
  });
});
