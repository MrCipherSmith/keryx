import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chunkArchiveEvidence, archiveChunkId, isArchiveChunk, incrementalArchiveEvidence } from "./archive-chunks";
import type { ArchiveRecord } from "./sources";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const source = { sourceId: hash("source"), sourcePath: "session-archive:fixture", versionHash: hash("raw") };
const record = (text: string, startByte = 100): ArchiveRecord => ({
  text, startByte, endByte: startByte + 1000, recordId: `${startByte}:${hash("row")}`,
  role: "user", timestamp: null, redaction: "not-needed", trustedAsPolicy: false,
});
test("archive chunks never merge records and retain original record locators", () => {
  const chunks = chunkArchiveEvidence({ ...source, records: [record("α".repeat(300)), record("second", 1100)] });
  expect(chunks).toHaveLength(3);
  expect(chunks[0]?.locator).toEqual({ kind: "archive", recordId: record("").recordId, startByte: 0, endByte: 999 });
  expect(chunks[0]?.role).toBe("user");
  expect(chunks[0]?.timestamp).toBeNull();
  expect(chunks[0]?.redaction).toBe("not-needed");
  expect(chunks.map(chunk => chunk.text).join("")).toBe("α".repeat(300) + "second");
  expect(new Set(chunks.map(chunk => chunk.chunkId)).size).toBe(3);
});
test("redacted record citations describe original bytes, not replacement length", () => {
  const row = { ...record("[redacted]"), redaction: "applied" as const };
  const chunks = chunkArchiveEvidence({ ...source, records: [row] });
  expect(chunks[0]?.locator.endByte).toBe(999);
  expect(chunks[0]?.contentHash).toBe(hash("[redacted]"));
  expect(chunks[0]?.redaction).toBe("applied");
  expect(chunks[0]?.trustedAsPolicy).toBe(false);
  expect(chunks[0]?.chunkId).not.toBe(chunkArchiveEvidence({ ...source,
    records: [{ ...row, recordId: `100:${hash("other")}` }] })[0]?.chunkId);
});
test("archive chunk identities bind role, timestamp and version", () => {
  const row = record("same");
  const id = chunkArchiveEvidence({ ...source, records: [row] })[0]!.chunkId;
  for (const changed of [{ ...row, role: "assistant" }, { ...row, timestamp: "2026-01-01" },
    { ...row, redaction: "applied" as const }])
    expect(chunkArchiveEvidence({ ...source, records: [changed] })[0]!.chunkId).not.toBe(id);
  expect(chunkArchiveEvidence({ ...source, versionHash: hash("appended"), records: [row] })[0]!.chunkId).not.toBe(id);
});
test("archive projection refuses malformed records and whole-build chunk overflow", () => {
  const row = record("ok");
  for (const changed of [{ ...row, startByte: -1 }, { ...row, endByte: 100 },
    { ...row, recordId: "unstable" }, { ...row, trustedAsPolicy: true }, { ...row, redaction: "unknown" }])
    expect(() => chunkArchiveEvidence({ ...source, records: [changed as ArchiveRecord] })).toThrow();
  expect(() => chunkArchiveEvidence({ ...source, records: [row, row] })).toThrow();
  expect(() => chunkArchiveEvidence({ ...source, records: [record("x".repeat(801))] }, 2)).toThrow();
  expect(() => chunkArchiveEvidence({ ...source, records: [record("x".repeat(8 * 1024 * 1024 + 1))] })).toThrow();
  expect(chunkArchiveEvidence({ ...source, records: [] })).toEqual([]);
});

test("zero remaining chunk budget accepts only zero-output archives", () => {
  expect(chunkArchiveEvidence({ ...source, records: [] }, 0)).toEqual([]);
  expect(chunkArchiveEvidence({ ...source, records: [record("")] }, 0)).toEqual([]);
  expect(() => chunkArchiveEvidence({ ...source, records: [record("nonempty")] }, 0)).toThrow();
});

test("archive identities are independent of locator property insertion order", () => {
  const chunk = chunkArchiveEvidence({ ...source, records: [record("same")] })[0]!;
  const reordered = { ...chunk, locator: {
    endByte: chunk.locator.endByte, startByte: chunk.locator.startByte,
    recordId: chunk.locator.recordId, kind: chunk.locator.kind,
  } };
  expect(archiveChunkId(reordered)).toBe(chunk.chunkId);
  expect(isArchiveChunk(reordered)).toBe(true);
});

test("incremental archive append reuses complete records but rebinds source versions", () => {
  const first = record("x".repeat(800));
  const previous = chunkArchiveEvidence({ ...source, records: [first] });
  const input = { ...source, versionHash: hash("append"), records: [first, record("tail", 1100)] };
  const result = incrementalArchiveEvidence(input, previous);
  expect(result.reusedChunks).toBe(2);
  expect(result.chunks).toEqual(chunkArchiveEvidence(input));
  expect(result.chunks[0]!.chunkId).not.toBe(previous[0]!.chunkId);
  expect(previous[0]!.versionHash).toBe(source.versionHash);
});

test("incremental archive rewrite/delete never retain absent or changed record content", () => {
  const first = record("same"), second = record("old", 1100);
  const previous = chunkArchiveEvidence({ ...source, records: [first, second] });
  for (const records of [[first], [first, { ...second, text: "new" }], []]) {
    const input = { ...source, versionHash: hash("rewrite"), records };
    const result = incrementalArchiveEvidence(input, previous);
    expect(result.chunks).toEqual(chunkArchiveEvidence(input));
    expect(result.reusedChunks).toBe(records.length ? 1 : 0);
  }
});

test("incremental archive refuses cache substitution and incomplete record chunks", () => {
  const row = record("x".repeat(800));
  const previous = chunkArchiveEvidence({ ...source, records: [row] });
  const input = { ...source, versionHash: hash("append"), records: [row] };
  for (const cached of [previous.slice(0, 1), previous.slice().reverse(),
    previous.map(c => ({ ...c, sourcePath: "session-archive:other" })),
    previous.map(c => ({ ...c, contentHash: hash("tampered") })),
    previous.map(c => ({ ...c, role: "assistant" })),
    previous.map(c => ({ ...c, versionHash: hash("wrong"), chunkId: c.chunkId }))]) {
    const result = incrementalArchiveEvidence(input, cached);
    expect(result.reusedChunks).toBe(0);
    expect(result.chunks).toEqual(chunkArchiveEvidence(input));
  }
});

test("incremental archive validates input and global budgets even when all records cached", () => {
  const row = record("x".repeat(800));
  const previous = chunkArchiveEvidence({ ...source, records: [row] });
  expect(() => incrementalArchiveEvidence({ ...source, records: [row] }, previous, 1)).toThrow();
  expect(() => incrementalArchiveEvidence({ ...source, records: [row, row] }, previous)).toThrow();
  expect(() => incrementalArchiveEvidence({ ...source, records: [{ ...row, trustedAsPolicy: true } as unknown as ArchiveRecord] }, previous)).toThrow();
});

test("large multiline archive reuse preserves line offsets and full-build parity", () => {
  const text = ("π".repeat(199) + "\n").repeat(2048);
  const row = { ...record(text, 0), endByte: Buffer.byteLength(text) + 100 };
  const previous = chunkArchiveEvidence({ ...source, records: [row] });
  const input = { ...source, versionHash: hash("large-append"), records: [row] };
  const result = incrementalArchiveEvidence(input, previous);
  expect(result.reusedChunks).toBe(previous.length);
  expect(result.chunks).toEqual(chunkArchiveEvidence(input));
});
