import { createHash } from "node:crypto";
import { chunkEvidence, type LexicalChunk } from "./search";
import type { ArchiveRecord } from "./sources";

export interface ArchiveChunk extends LexicalChunk {
  locator: { kind: "archive"; recordId: string; startByte: number; endByte: number };
  role: string; timestamp: string | null; redaction: "applied" | "not-needed";
}
export const ARCHIVE_CHUNKER_VERSION = "record-envelope-utf8-byte-v2";
export function archiveChunkId(chunk: ArchiveChunk): string {
  return createHash("sha256").update(JSON.stringify([ARCHIVE_CHUNKER_VERSION,
    chunk.sourceId, chunk.versionHash, [chunk.locator.kind, chunk.locator.recordId,
      chunk.locator.startByte, chunk.locator.endByte], chunk.startByte, chunk.endByte,
    chunk.startLine, chunk.endLine, chunk.contentHash, chunk.role, chunk.timestamp,
    chunk.redaction])).digest("hex");
}
/** Offsets on LexicalChunk address sanitized record text only. The citation
 * locator addresses the complete original JSON record (excluding its newline).
 * JSON escapes/redaction preclude inferring raw substring offsets from text.
 */
type ArchiveInput = {
  sourceId: string; sourcePath: string; versionHash: string; records: readonly ArchiveRecord[];
};
export function chunkArchiveEvidence(input: ArchiveInput, maxChunks = 100000): ArchiveChunk[] {
  return incrementalArchiveEvidence(input, [], maxChunks).chunks;
}

/** Reuse only complete, validated record projections. Always bind citations to
 * the newly scanned full source hash; never mutate the previous generation. */
export function incrementalArchiveEvidence(input: ArchiveInput,
  previous: readonly ArchiveChunk[], maxChunks = 100000): { chunks: ArchiveChunk[]; reusedChunks: number } {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 0 || maxChunks > 100000 ||
      !input || !Array.isArray(input.records) || input.records.length > 100000 ||
      !input.sourceId || !input.sourcePath || !/^[a-f0-9]{64}$/.test(input.versionHash))
    throw Error("invalid archive projection");
  let bytes = 0, previousEnd = 0;
  // Validate the entire input before allocating chunks; empty records count too.
  for (const record of input.records) {
    if (!record || typeof record.text !== "string" || !Number.isSafeInteger(record.startByte) ||
        !Number.isSafeInteger(record.endByte) || record.startByte < previousEnd ||
        record.endByte <= record.startByte + 1 || record.endByte > 8 * 1024 * 1024 ||
        typeof record.recordId !== "string" ||
        !new RegExp(`^${record.startByte}:[a-f0-9]{64}$`).test(record.recordId) ||
        typeof record.role !== "string" || !["user", "assistant", "tool"].includes(record.role) ||
        (record.timestamp !== null && (typeof record.timestamp !== "string" || record.timestamp.length > 128)) ||
        !["applied", "not-needed"].includes(record.redaction) || record.trustedAsPolicy !== false)
      throw Error("invalid archive record");
    previousEnd = record.endByte;
    bytes += Buffer.byteLength(record.text);
    if (bytes > 8 * 1024 * 1024) throw Error("archive source budget exceeded");
  }
  const cached = new Map<string, ArchiveChunk[]>();
  if (previous.length <= 100000) for (const chunk of previous) {
    if (!isArchiveChunk(chunk) || chunk.sourceId !== input.sourceId || chunk.sourcePath !== input.sourcePath) continue;
    const key = chunk.locator.recordId, group = cached.get(key) ?? [];
    group.push(chunk); cached.set(key, group);
  }
  const chunks: ArchiveChunk[] = [];
  let reusedChunks = 0;
  for (const record of input.records) {
    if (!record.text) continue;
    const remaining = maxChunks - chunks.length;
    if (!remaining) throw Error("archive chunk budget exceeded");
    const group = cached.get(record.recordId);
    if (group && reusableRecord(group, record)) {
      if (group.length > remaining) throw Error("archive chunk budget exceeded");
      for (const old of group) {
        const rebound = { ...old, versionHash: input.versionHash, locator: { ...old.locator } };
        rebound.chunkId = archiveChunkId(rebound); chunks.push(rebound);
      }
      reusedChunks += group.length;
      continue;
    }
    for (const base of chunkEvidence({ ...input, text: record.text }, 400, remaining)) {
      const chunk: ArchiveChunk = { ...base,
        locator: { kind: "archive", recordId: record.recordId, startByte: 0,
          endByte: record.endByte - record.startByte - 1 },
        role: record.role, timestamp: record.timestamp, redaction: record.redaction };
      chunk.chunkId = archiveChunkId(chunk);
      chunks.push(chunk);
    }
  }
  return { chunks, reusedChunks };
}

/** Closed persisted archive metadata contract. Common chunk fields are checked by the index. */
export function isArchiveChunk(chunk: LexicalChunk): chunk is ArchiveChunk {
  const c = chunk as ArchiveChunk, loc = c.locator;
  if (!loc || typeof loc !== "object" || Array.isArray(loc) ||
      Object.keys(loc).sort().join(",") !== "endByte,kind,recordId,startByte" ||
      loc.kind !== "archive" || loc.startByte !== 0 || !Number.isSafeInteger(loc.endByte) ||
      loc.endByte < 2 || loc.endByte >= 8 * 1024 * 1024 ||
      typeof loc.recordId !== "string" || !/^(0|[1-9][0-9]*):[a-f0-9]{64}$/.test(loc.recordId) ||
      Number(loc.recordId.split(":")[0]) + loc.endByte + 1 > 8 * 1024 * 1024 ||
      !["user", "assistant", "tool"].includes(c.role) ||
      (c.timestamp !== null && (typeof c.timestamp !== "string" || c.timestamp.length > 128)) ||
      !["applied", "not-needed"].includes(c.redaction)) return false;
  return c.chunkId === archiveChunkId(c);
}

/** Verify complete sanitized text coverage, including chunker-skipped newlines.
 * Raw record identity alone is insufficient: redaction policy can change text. */
function reusableRecord(chunks: readonly ArchiveChunk[], record: ArchiveRecord): boolean {
  const bytes = Buffer.from(record.text);
  let end = 0;
  for (const chunk of chunks) {
    if (chunk.role !== record.role || chunk.timestamp !== record.timestamp || chunk.redaction !== record.redaction ||
        chunk.trustedAsPolicy !== false || chunk.versionHash !== chunks[0]!.versionHash ||
        chunk.locator.endByte !== record.endByte - record.startByte - 1 ||
        !Number.isSafeInteger(chunk.startByte) || !Number.isSafeInteger(chunk.endByte) ||
        chunk.startByte < end || chunk.endByte <= chunk.startByte || chunk.endByte > bytes.length ||
        chunk.startByte - end > 1 || (chunk.startByte > end && bytes[end] !== 10) ||
        !chunk.text || Buffer.byteLength(chunk.text) > 400 ||
        chunk.contentHash !== createHash("sha256").update(chunk.text).digest("hex") ||
        !bytes.subarray(chunk.startByte, chunk.endByte).equals(Buffer.from(chunk.text)) ||
        chunk.startLine !== bytes.subarray(0, chunk.startByte).toString().split("\n").length ||
        chunk.endLine !== chunk.startLine + chunk.text.split("\n").length - 1) return false;
    end = chunk.endByte;
  }
  return end === bytes.length || (end === bytes.length - 1 && bytes[end] === 10);
}
