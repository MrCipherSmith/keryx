import { createHash } from "node:crypto";

export interface LexicalChunk {
  sourceId: string; sourcePath: string; versionHash: string; chunkId: string; contentHash: string;
  text: string; startByte: number; endByte: number; startLine: number; endLine: number; trustedAsPolicy: false;
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenize = (value: string): string[] => value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}_-]+/gu) ?? [];

/** UTF-8-byte-v1 is a conservative estimator (one token per encoded byte).
 * Target 400 estimated tokens, hard cap 600; zero overlap. The estimator and
 * locator are part of identity so incompatible cached generations fail closed.
 */
export const EVIDENCE_CHUNKER_VERSION = "paragraph-utf8-byte-v2-target400-overlap0";
export function evidenceChunkId(chunk: Pick<LexicalChunk, "sourceId" | "versionHash" | "startByte" | "endByte" | "startLine" | "endLine" | "contentHash">): string {
  return sha256(JSON.stringify([EVIDENCE_CHUNKER_VERSION, chunk.sourceId, chunk.versionHash,
    chunk.startByte, chunk.endByte, chunk.startLine, chunk.endLine, chunk.contentHash]));
}

/** Paragraph-aware packing; oversized paragraphs fall back to lines/scalars. */
export function chunkEvidence(input: { sourceId: string; sourcePath: string; versionHash: string; text: string }, maxBytes = 2048, maxChunks = 100000): LexicalChunk[] {
  if (!input.sourceId || !input.sourcePath || !/^[a-f0-9]{64}$/.test(input.versionHash) || !input.text ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > 16384) throw new Error("invalid evidence document");
  if (Buffer.byteLength(input.text) > 8 * 1024 * 1024) throw new Error("evidence source budget exceeded");
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 100000) throw new Error("evidence chunk budget exceeded");
  const bound = Math.min(maxBytes, 400), chunks: LexicalChunk[] = [];
  let text = "", bytes = 0, offset = 0, startByte = 0, startLine = 1, endLine = 1;
  const flush = () => {
    if (!bytes) return;
    if (chunks.length >= maxChunks) throw new Error("evidence chunk budget exceeded");
    const chunk = { sourceId: input.sourceId, sourcePath: input.sourcePath, versionHash: input.versionHash,
      chunkId: "", contentHash: sha256(text), text, startByte, endByte: offset,
      startLine, endLine, trustedAsPolicy: false as const };
    chunk.chunkId = evidenceChunkId(chunk); chunks.push(chunk); text = ""; bytes = 0;
  };
  const lines = input.text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, lineBytes = Buffer.byteLength(line);
    const blank = (value: string) => /^\s*$/.test(value);
    if (i > 0 && !blank(line) && blank(lines[i - 1]!)) {
      let paragraphBytes = lineBytes;
      for (let j = i + 1; j < lines.length && paragraphBytes <= bound && !blank(lines[j]!); j++)
        paragraphBytes += 1 + Buffer.byteLength(lines[j]!);
      if (bytes && paragraphBytes <= bound && bytes + 1 + paragraphBytes > bound) flush();
    }
    if (i > 0) {
      // Keep normal lines whole where possible; a separating newline is not
      // included in either excerpt when it cannot fit with the next line.
      if (bytes && bytes + 1 + lineBytes <= bound) {
        text += "\n"; bytes++; offset++; endLine = i + 1;
      } else { flush(); offset++; }
    }
    for (const scalar of line) {
      const size = Buffer.byteLength(scalar);
      if (bytes + size > bound) flush();
      if (!bytes) { startByte = offset; startLine = i + 1; }
      text += scalar; bytes += size; offset += size; endLine = i + 1;
    }
  }
  flush(); return chunks;
}

/** Deterministic bounded lexical ranking; lifecycle validation is the caller's responsibility. */
export function searchLexical<T extends LexicalChunk>(chunks: readonly T[], query: string, limit = 10): T[] {
  return searchLexicalRanked(chunks, query, limit).map(item => item.chunk);
}
export function searchLexicalRanked<T extends LexicalChunk>(chunks: readonly T[], query: string, limit = 10): { chunk: T; score: number }[] {
  if (typeof query !== "string" || Buffer.byteLength(query) > 8192 || !query.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid evidence query");
  if (!Array.isArray(chunks) || chunks.length > 100000) throw new Error("evidence corpus budget exceeded");
  let corpusBytes = 0;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.text !== "string") throw new Error("invalid evidence chunk");
    const bytes = Buffer.byteLength(chunk.text);
    corpusBytes += bytes;
    if (bytes > 16384 || corpusBytes > 256 * 1024 * 1024) throw new Error("evidence corpus budget exceeded");
  }
  const queryTerms = new Set(tokenize(query));
  if (!queryTerms.size) return [];
  const documentFrequency = new Map<string, number>();
  let totalWords = 0;
  // Only query-term counts survive this pass. Never rescan the corpus per hit.
  const docs = chunks.map(chunk => {
    const words = tokenize(chunk.text), frequencies = new Map<string, number>();
    totalWords += words.length;
    for (const word of words) {
      if (queryTerms.has(word)) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
    for (const term of frequencies.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    return { chunk, length: words.length, frequencies };
  });
  const averageLength = docs.length ? totalWords / docs.length : 0;
  const idfs = new Map<string, number>();
  for (const [term, df] of documentFrequency) idfs.set(term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)));
  return docs.map(({ chunk, length, frequencies }) => {
    let score = 0;
    for (const [term, tf] of frequencies) {
      score += idfs.get(term)! * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length / Math.max(1, averageLength)));
    }
    return { chunk, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.chunk.sourceId.localeCompare(b.chunk.sourceId) || a.chunk.startByte - b.chunk.startByte || a.chunk.chunkId.localeCompare(b.chunk.chunkId)).slice(0, limit);
}
