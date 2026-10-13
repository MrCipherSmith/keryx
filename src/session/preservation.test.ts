import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_TRANSCRIPT_FILE_BYTES } from "../lib/config-dir";
import { commitHistoryCheckpoint, commitPreservation, queuePreservedWrapUp, readPendingHistory, readPreservation, restorePreservedHistory } from "./preservation";
const dirs: string[] = [];
const temp = (): string => { const dir = mkdtempSync(path.join(tmpdir(), "keryx-preserve-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("legacy absence is not corrupt storage", () => {
  const dir = temp(); expect(readPreservation(dir)).toBeUndefined();
  commitPreservation(dir, { "context.jsonl": "old" });
  writeFileSync(path.join(dir, "preservation", "CURRENT"), "../../escape");
  expect(() => readPreservation(dir)).toThrow("identity");
});
test("fault before selection keeps previous complete generation", () => {
  const dir = temp(); commitPreservation(dir, { "context.jsonl": "old", "archive.jsonl": "full-old" });
  expect(() => commitPreservation(dir, { "context.jsonl": "new", "archive.jsonl": "full-new" }, () => { throw new Error("crash"); })).toThrow("crash");
  expect(readPreservation(dir)?.files).toEqual({ "context.jsonl": "old", "archive.jsonl": "full-old" });
});
test("hash corruption is explicit, not an empty session", () => {
  const dir = temp(); const id = commitPreservation(dir, { "summary.json": "{}" });
  writeFileSync(path.join(dir, "preservation", "generations", `${id}.json`), "{}");
  expect(() => readPreservation(dir)).toThrow("hash mismatch");
});
test("restore history never writes preserved Slate over a new live attempt", () => {
  const dir = temp(); commitPreservation(dir, { "context.jsonl": "old", "slate.json": "old-slate" });
  writeFileSync(path.join(dir, "context.jsonl"), "partial"); writeFileSync(path.join(dir, "slate.json"), "successor");
  expect(restorePreservedHistory(dir)).toBe(true);
  expect(readFileSync(path.join(dir, "context.jsonl"), "utf8")).toBe("old");
  expect(readFileSync(path.join(dir, "slate.json"), "utf8")).toBe("successor");
});
test("zero Seeds retains Notes and outcomes, repeated capture converges", () => {
  const dir = temp(); const raw = JSON.stringify({ seeds: [], notes: { finding: { text: "important", ts: "now" } }, trail: [{ outcome: "error" }] });
  const first = queuePreservedWrapUp(dir, raw); const second = queuePreservedWrapUp(dir, raw);
  expect(first).toEqual(second); expect(first.state).toBe("pending-review");
  expect(first.inventory).toContain("Notes require review: 1");
  expect(first.inventory).toContain("Tool outcomes require review: 1");
  expect(readdirSync(path.join(dir, "preservation", "outbox"))).toHaveLength(1);
  expect(readPreservation(dir, first.snapshot)?.files["slate.json"]).toBe(raw);
});
test("snapshot is independent of later live files", () => {
  const dir = temp(); writeFileSync(path.join(dir, "archive.jsonl"), "original");
  const receipt = queuePreservedWrapUp(dir, JSON.stringify({ seeds: [] }));
  writeFileSync(path.join(dir, "archive.jsonl"), "changed");
  expect(readPreservation(dir, receipt.snapshot)?.files["archive.jsonl"]).toBe("original");
});
test("unsupported paths cannot escape the snapshot", () => {
  expect(() => commitPreservation(temp(), { "../escape": "bad" })).toThrow("unsupported");
});

// A killed writer must not expose the partially updated compatibility files.
test("interrupted history mirrors select a complete generation without touching Slate", async () => {
  const { commitHistoryCheckpoint, readPendingHistory } = await import("./preservation");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "history-generation-"));
  const files = { "context.jsonl": "new context", "archive.jsonl": "new archive", "transcript.jsonl": "new context", "summary.json": "new summary" };
  try {
    writeFileSync(path.join(dir, "slate.json"), "successor");
    expect(() => commitHistoryCheckpoint(dir, files, () => { throw new Error("killed"); })).toThrow("killed");
    writeFileSync(path.join(dir, "context.jsonl"), "partial mirror");
    expect(readPendingHistory(dir)?.files).toEqual(files);
    expect(readFileSync(path.join(dir, "slate.json"), "utf8")).toBe("successor");
    commitHistoryCheckpoint(dir, files);
    expect(readPendingHistory(dir)?.files).toEqual(files);
    expect(readFileSync(path.join(dir, "archive.jsonl"), "utf8")).toBe("new archive");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("completed history ignores corrupt mirrors and independent Slate selection", async () => {
  const { commitHistoryCheckpoint, readPendingHistory } = await import("./preservation");
  const dir = temp();
  const files = { "context.jsonl": "context", "archive.jsonl": "archive", "transcript.jsonl": "context", "summary.json": "summary" };
  const id = commitHistoryCheckpoint(dir, files);
  writeFileSync(path.join(dir, "context.jsonl"), "corrupt mirror");
  commitPreservation(dir, { "slate.json": "different Slate generation" });
  expect(readPendingHistory(dir)?.files).toEqual(files);
  writeFileSync(path.join(dir, "preservation", "generations", `${id}.json`), "{}");
  expect(() => readPendingHistory(dir)).toThrow("hash mismatch");
});
test("interruption before history selection retains previous complete history", async () => {
  const { commitHistoryCheckpoint, readPendingHistory } = await import("./preservation");
  const dir = temp();
  const old = { "context.jsonl": "old", "archive.jsonl": "old", "transcript.jsonl": "old", "summary.json": "old" };
  commitHistoryCheckpoint(dir, old);
  // Exact boundary: new CURRENT is durable, HISTORY has not been selected.
  commitPreservation(dir, { ...old, "context.jsonl": "new" });
  expect(readPendingHistory(dir)?.files).toEqual(old);
});

test("oversized escaped aggregate retains the readable checkpoint", () => {
  const dir = temp();
  const prior = commitPreservation(dir, { "context.jsonl": "old" });
  const content = '"'.repeat(Math.floor(MAX_TRANSCRIPT_FILE_BYTES / 3));
  expect(() => commitPreservation(dir, { "context.jsonl": content, "transcript.jsonl": content })).toThrow("size limit");
  expect(readFileSync(path.join(dir, "preservation", "CURRENT"), "utf8")).toBe(prior);
  expect(readPreservation(dir)?.files["context.jsonl"]).toBe("old");
});
test("history checkpoints prune old generations but keep current, previous and outbox-referenced ones", () => {
  const dir = temp();
  const base = { "context.jsonl": "c", "archive.jsonl": "a", "summary.json": "{}" };
  const ids = [1, 2, 3, 4].map((n) => commitHistoryCheckpoint(dir, { ...base, "transcript.jsonl": `t${n}` }));
  const queued = queuePreservedWrapUp(dir, JSON.stringify({ seeds: [], notes: {}, trail: [] })).snapshot;
  const more = commitHistoryCheckpoint(dir, { ...base, "transcript.jsonl": "t5" });
  const left = readdirSync(path.join(dir, "preservation", "generations")).map((f) => f.replace(".json", ""));
  expect(left).toContain(more);
  expect(left).toContain(ids[3]!);
  expect(left).toContain(queued);
  expect(left).not.toContain(ids[0]!);
  expect(left).not.toContain(ids[1]!);
  expect(readPendingHistory(dir)?.files["transcript.jsonl"]).toBe("t5");
});

// Failure after HISTORY selection must not downgrade evidence to compatibility mirrors.
test("wrap-up capture and immutable replay evidence select committed HISTORY after mirror failure", async () => {
  const { commitHistoryCheckpoint } = await import("./preservation");
  const dir = temp();
  const old = { "context.jsonl": "A", "archive.jsonl": "A", "transcript.jsonl": "A", "summary.json": "A" };
  commitHistoryCheckpoint(dir, old);
  const next = Object.fromEntries(Object.keys(old).map(name => [name, "B"]));
  expect(() => commitHistoryCheckpoint(dir, next, () => { throw new Error("mirror failed"); })).toThrow("mirror failed");
  expect(readFileSync(path.join(dir, "archive.jsonl"), "utf8")).toBe("A");
  const receipt = queuePreservedWrapUp(dir, JSON.stringify({ seeds: [], notes: {} }));
  expect(readPreservation(dir, receipt.snapshot)?.files["archive.jsonl"]).toBe("B");
  for (const name of Object.keys(old)) writeFileSync(path.join(dir, name), "later corrupt mirror");
  expect(readPreservation(dir, receipt.snapshot)?.files["context.jsonl"]).toBe("B");
});
test("wrap-up refuses corrupted authoritative HISTORY instead of silently using mirrors", async () => {
  const { commitHistoryCheckpoint } = await import("./preservation");
  const dir = temp();
  const id = commitHistoryCheckpoint(dir, { "context.jsonl": "B", "archive.jsonl": "B", "transcript.jsonl": "B", "summary.json": "B" });
  writeFileSync(path.join(dir, "preservation", "generations", `${id}.json`), "{}");
  expect(() => queuePreservedWrapUp(dir, "{}" )).toThrow("hash mismatch");
});
