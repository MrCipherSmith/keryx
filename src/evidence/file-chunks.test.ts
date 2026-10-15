import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { chunkFileEvidence, isFileChunk } from "./file-chunks";
const base = { sourceId: "source", sourcePath: "docs/file.md", versionHash: createHash("sha256").update("original").digest("hex") };
test("unchanged UTF8 file citations address exact original bytes", () => {
  const text = "Я".repeat(250) + "\nend";
  const chunks = chunkFileEvidence({ ...base, text, fileProjection: { redaction: "not-needed", originalByteLength: Buffer.byteLength(text), originalLineCount: 2 } });
  for (const chunk of chunks) {
    expect(Buffer.from(text).subarray(chunk.locator.startByte, chunk.locator.endByte).toString()).toBe(chunk.text);
    expect(isFileChunk(chunk)).toBe(true);
    expect(chunk.role).toBeNull();
  }
});
test("redacted citations bind the whole original file rather than sanitized offsets", () => {
  const chunks = chunkFileEvidence({ ...base, text: "safe ".repeat(100), fileProjection: { redaction: "applied", originalByteLength: 900, originalLineCount: 10 } });
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.locator).toEqual({ kind: "file", startByte: 0, endByte: 900, startLine: 1, endLine: 10 });
  const chunk = chunks[0]!;
  expect(isFileChunk({ ...chunk, locator: { ...chunk.locator, endByte: 901 } })).toBe(false);
  expect(isFileChunk({ ...chunk, redaction: "not-needed" })).toBe(false);
});
test("invalid original projection is refused", () => {
  for (const fileProjection of [
    { redaction: "not-needed" as const, originalByteLength: 9, originalLineCount: 1 },
    { redaction: "applied" as const, originalByteLength: 0, originalLineCount: 1 },
    { redaction: "applied" as const, originalByteLength: 900, originalLineCount: 0 },
  ]) expect(() => chunkFileEvidence({ ...base, text: "safe", fileProjection })).toThrow();
});
