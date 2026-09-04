// LWG-9 freshness queue (flow 226): AC14, plus the rotation and ordering the
// drain depends on.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendEntry,
  clearQueue,
  drainQueue,
  earliestRev,
  queuePath,
  rotatedQueuePath,
  type QueueEntry,
} from "./queue";

const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);

function entry(rev: string, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    schemaVersion: 1,
    event: "post-commit",
    rev,
    recordedAt: "2026-09-04T00:00:00Z",
    paths: ["src/a.ts"],
    ...overrides,
  };
}

async function project(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lwg-queue-"));
  await mkdir(path.join(cwd, ".metaproject", "data", "wiki"), { recursive: true });
  return cwd;
}

describe("append and drain", () => {
  test("entries round-trip in order", async () => {
    const cwd = await project();
    await appendEntry(cwd, entry(REV_A));
    await appendEntry(cwd, entry(REV_B, { paths: ["src/b.ts"] }));

    const drained = await drainQueue(cwd);
    expect(drained.entries.map((e) => e.rev)).toEqual([REV_A, REV_B]);
    expect(drained.corruptLines).toBe(0);
  });

  test("the rotated file is read before the live one, oldest first", async () => {
    const cwd = await project();
    await writeFile(rotatedQueuePath(cwd), `${JSON.stringify(entry(REV_A))}\n`);
    await writeFile(queuePath(cwd), `${JSON.stringify(entry(REV_B))}\n`);

    const drained = await drainQueue(cwd);
    expect(drained.entries.map((e) => e.rev)).toEqual([REV_A, REV_B]);
  });

  test("an absent queue drains to nothing rather than throwing", async () => {
    const cwd = await project();
    expect(await drainQueue(cwd)).toEqual({ entries: [], corruptLines: 0, truncated: false });
  });

  test("clearing removes both files", async () => {
    const cwd = await project();
    await writeFile(rotatedQueuePath(cwd), `${JSON.stringify(entry(REV_A))}\n`);
    await appendEntry(cwd, entry(REV_B));
    await clearQueue(cwd);
    expect(await drainQueue(cwd)).toEqual({ entries: [], corruptLines: 0, truncated: false });
  });
});

describe("damage tolerance (AC14)", () => {
  test("a corrupt line is skipped and counted, and the rest still drain", async () => {
    const cwd = await project();
    await writeFile(
      queuePath(cwd),
      [
        JSON.stringify(entry(REV_A)),
        '{"schemaVersion":1,"rev":"truncated mid-writ', // killed mid-append
        JSON.stringify(entry(REV_B)),
        "",
      ].join("\n"),
    );

    const drained = await drainQueue(cwd);
    // The surviving revisions must still be reported: a half-written line
    // costs one revision, never the whole report.
    expect(drained.entries.map((e) => e.rev)).toEqual([REV_A, REV_B]);
    expect(drained.corruptLines).toBe(1);
  });

  test("valid JSON that is not a queue entry is corrupt, not accepted", async () => {
    const cwd = await project();
    await writeFile(
      queuePath(cwd),
      [
        JSON.stringify({ schemaVersion: 2, rev: REV_A, recordedAt: "x", paths: [] }),
        JSON.stringify({ schemaVersion: 1, rev: "short", recordedAt: "x", paths: [] }),
        JSON.stringify({ schemaVersion: 1, rev: REV_A, recordedAt: "x" }),
        "",
      ].join("\n"),
    );
    const drained = await drainQueue(cwd);
    expect(drained.entries).toEqual([]);
    expect(drained.corruptLines).toBe(3);
  });

  test("a truncated entry is surfaced so the drain can re-read that revision", async () => {
    const cwd = await project();
    await appendEntry(cwd, entry(REV_A, { truncated: true, paths: [] }));
    const drained = await drainQueue(cwd);
    expect(drained.truncated).toBe(true);
  });

  test("non-string path elements are dropped rather than poisoning the entry", async () => {
    const cwd = await project();
    await writeFile(
      queuePath(cwd),
      `${JSON.stringify({ ...entry(REV_A), paths: ["src/a.ts", 42, null] })}\n`,
    );
    const drained = await drainQueue(cwd);
    expect(drained.entries[0]?.paths).toEqual(["src/a.ts"]);
  });
});

describe("rotation", () => {
  test("crossing the byte ceiling moves the live file aside, losing nothing", async () => {
    const cwd = await project();
    const filler = JSON.stringify(entry(REV_A, { paths: ["x".repeat(6 * 1024 * 1024)] }));
    await writeFile(queuePath(cwd), `${filler}\n`);

    await appendEntry(cwd, entry(REV_B));

    expect((await readFile(rotatedQueuePath(cwd), "utf8")).length).toBeGreaterThan(0);
    const drained = await drainQueue(cwd);
    expect(drained.entries.map((e) => e.rev)).toEqual([REV_A, REV_B]);
  });
});

describe("earliestRev", () => {
  test("prefers the first entry's parent, which is the true base of the range", () => {
    expect(earliestRev([entry(REV_B, { previousRev: REV_A })])).toBe(REV_A);
  });

  test("falls back to the revision itself when no parent was recorded", () => {
    expect(earliestRev([entry(REV_B)])).toBe(REV_B);
  });

  test("an empty drain yields no base, so the caller picks its own default", () => {
    expect(earliestRev([])).toBeUndefined();
  });
});
