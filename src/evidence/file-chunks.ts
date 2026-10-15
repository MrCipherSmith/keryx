import { createHash } from "node:crypto";
import { chunkEvidence, type LexicalChunk } from "./search";
export interface FileProjection {
  redaction: "applied" | "not-needed"; originalByteLength: number; originalLineCount: number;
}
export interface FileChunk extends LexicalChunk {
  locator: { kind: "file"; startByte: number; endByte: number; startLine: number; endLine: number };
  role: null; timestamp: null; redaction: FileProjection["redaction"];
}
export const FILE_CHUNKER_VERSION = "file-original-envelope-v1";
export function fileChunkId(c: FileChunk) {
  return createHash("sha256").update(JSON.stringify([FILE_CHUNKER_VERSION, c.sourceId, c.versionHash,
    c.startByte, c.endByte, c.startLine, c.endLine, c.contentHash,
    c.locator.kind, c.locator.startByte, c.locator.endByte, c.locator.startLine, c.locator.endLine,
    c.role, c.timestamp, c.redaction])).digest("hex");
}
export function chunkFileEvidence(input: {
  sourceId: string; sourcePath: string; versionHash: string; text: string; fileProjection: FileProjection;
}, maxChunks = 100000): FileChunk[] {
  const p = input.fileProjection;
  if (!p || Object.keys(p).sort().join(",") !== "originalByteLength,originalLineCount,redaction" ||
      !["applied", "not-needed"].includes(p.redaction) ||
      !Number.isSafeInteger(p.originalByteLength) || p.originalByteLength < 1 || p.originalByteLength > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(p.originalLineCount) || p.originalLineCount < 1 || p.originalLineCount > p.originalByteLength + 1 ||
      (p.redaction === "not-needed" && (p.originalByteLength !== Buffer.byteLength(input.text) ||
        p.originalLineCount !== input.text.split("\n").length))) throw Error("invalid original file projection");
  return chunkEvidence(input, 400, maxChunks).map(base => {
    const chunk: FileChunk = { ...base, locator: p.redaction === "applied" ?
      { kind: "file", startByte: 0, endByte: p.originalByteLength, startLine: 1, endLine: p.originalLineCount } :
      { kind: "file", startByte: base.startByte, endByte: base.endByte, startLine: base.startLine, endLine: base.endLine },
      role: null, timestamp: null, redaction: p.redaction };
    chunk.chunkId = fileChunkId(chunk); return chunk;
  });
}
export function isFileChunk<T extends LexicalChunk>(chunk: T): chunk is T & FileChunk {
  const c = chunk as T & FileChunk, l = c.locator;
  if (!l || typeof l !== "object" || Array.isArray(l) ||
      Object.keys(l).sort().join(",") !== "endByte,endLine,kind,startByte,startLine" || l.kind !== "file" ||
      !Number.isSafeInteger(l.startByte) || !Number.isSafeInteger(l.endByte) || l.startByte < 0 ||
      l.endByte <= l.startByte || l.endByte > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(l.startLine) || !Number.isSafeInteger(l.endLine) || l.startLine < 1 ||
      l.endLine < l.startLine || l.endLine > 8 * 1024 * 1024 + 1 ||
      c.role !== null || c.timestamp !== null || !["applied", "not-needed"].includes(c.redaction)) return false;
  if (c.redaction === "not-needed" ?
      l.startByte !== c.startByte || l.endByte !== c.endByte || l.startLine !== c.startLine || l.endLine !== c.endLine :
      l.startByte !== 0 || l.startLine !== 1) return false;
  return c.chunkId === fileChunkId(c);
}
