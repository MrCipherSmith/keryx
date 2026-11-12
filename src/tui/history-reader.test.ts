import { expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedMessage } from "../harness/provider/types";
import { HistoryReader, historySnapshot } from "./history-reader";

test("search counts millions of hits and locates the last one without retaining each hit", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "keryx-history-reader-"));
  const content = "a ".repeat(2048);
  const messages: NormalizedMessage[] = Array.from({ length: 2048 }, () => ({ role: "assistant", content }));
  const file = path.join(directory, "archive.jsonl");
  writeFileSync(file, (JSON.stringify(messages[0]) + "\n").repeat(messages.length));
  const signal = new AbortController().signal;
  try {
    const reader = await HistoryReader.open(historySnapshot(messages, [], directory), signal);
    try {
      const cancelled = new AbortController();
      const interrupted = reader.search("a", cancelled.signal);
      setTimeout(() => cancelled.abort(), 5);
      await expect(interrupted).rejects.toThrow();

      const search = await reader.search("A", signal);
      expect(search.total).toBe(4_194_304);
      expect(await search.locate(search.total - 1, signal)).toEqual({ entry: 2047, fragment: 2047, start: 4094, end: 4095 });
      expect(await search.locate(1024, signal)).toEqual({ entry: 0, fragment: 0, start: 2048, end: 2049 });
    } finally {
      await reader.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test("uses the selected checkpoint and live tail when the disk mirror is stale or replaced", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "keryx-history-mirror-"));
  const archive: NormalizedMessage[] = [
    { role: "user", content: "Saved [literal]" },
    { role: "assistant", content: "Selected checkpoint" },
  ];
  const tail: NormalizedMessage = { role: "assistant", content: "Unflushed answer" };
  const file = path.join(directory, "archive.jsonl");
  writeFileSync(file, JSON.stringify(archive[0]) + "\n" + JSON.stringify({ ...archive[1], content: "Stale mirror" }) + "\n");
  const signal = new AbortController().signal;
  try {
    const snapshot = historySnapshot(archive, [tail], directory);
    tail.content += " changed";
    const reader = await HistoryReader.open(snapshot, signal);
    try {
      renameSync(file, path.join(directory, "old.jsonl"));
      writeFileSync(file, "");
      expect((await reader.page(0, reader.length, signal)).map((row) => row.text)).toEqual([
        "Saved [literal]", "Selected checkpoint", "Unflushed answer",
      ]);
      expect((await reader.search("[literal]", signal)).total).toBe(1);
      expect((await reader.search("stale", signal)).total).toBe(0);
    } finally {
      await reader.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("can page across a single large message and jump to a match spanning fragments", async () => {
  const content = "x".repeat(4095) + "Needle" + "🦊".repeat(3000);
  const signal = new AbortController().signal;
  const reader = await HistoryReader.open(historySnapshot([{ role: "assistant", content }]), signal);
  try {
    expect(reader.length).toBe(3);
    const page = await reader.page(0, reader.length, signal);
    expect(page.map((row) => row.text).join("")).toBe(content);
    expect(page.every((row) => row.text.length <= 4096)).toBe(true);
    const search = await reader.search("needle", signal);
    expect(await search.locate(0, signal)).toEqual({ entry: 0, fragment: 0, start: 4095, end: 4101 });
  } finally {
    await reader.close();
  }
});

test("finds the final fragment of a multi-megabyte line without requiring a newline", async () => {
  const prefix = "x".repeat(8 * 1024 * 1024);
  const signal = new AbortController().signal;
  const reader = await HistoryReader.open(historySnapshot([{ role: "assistant", content: prefix + "Last hit" }]), signal);
  try {
    const last = reader.length - 1;
    const page = await reader.page(last - 1, reader.length, signal);
    expect(page.map(({ start, text }) => [start, text.length])).toEqual([
      [prefix.length - 4096, 4096], [prefix.length, "Last hit".length],
    ]);
    const search = await reader.search("Last hit", signal);
    expect(await search.locate(0, signal)).toEqual({
      entry: 0, fragment: last, start: prefix.length, end: prefix.length + "Last hit".length,
    });
  } finally {
    await reader.close();
  }
});
