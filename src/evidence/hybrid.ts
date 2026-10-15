import { createHash } from "node:crypto";
import { searchLexicalRanked, type LexicalChunk } from "./search";

/** Scoped cache identity; never a capability or remote-consent grant. */
export interface EvidenceVectorIdentity {
  project: string; adapter: string; model: string; revision: string;
  dimensions: number; sanitizer: string;
}
export interface EvidenceSemanticPool {
  identity: EvidenceVectorIdentity;
  /** Current approved identity, independent of loaded cache metadata. */
  expectedIdentity: EvidenceVectorIdentity;
  query: readonly number[];
  vectors: readonly { key: string; values: readonly number[] }[];
}
const MAX_DIMENSIONS = 4096, MAX_VECTOR_BYTES = 256 * 1024 * 1024;
function identityParts(identity: EvidenceVectorIdentity): readonly (string | number)[] {
  if (!identity || !Number.isSafeInteger(identity.dimensions) || identity.dimensions < 1 ||
      identity.dimensions > MAX_DIMENSIONS) throw Error("invalid evidence vector identity");
  const fields = [identity.project, identity.adapter, identity.model, identity.revision, identity.sanitizer];
  if (fields.some(field => typeof field !== "string" || !field || Buffer.byteLength(field) > 4096))
    throw Error("invalid evidence vector identity");
  return [...fields, identity.dimensions];
}
/** Full SHA-256 over sanitized content and project/model/sanitizer identity. */
export function evidenceVectorKey(identity: EvidenceVectorIdentity, contentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw Error("invalid evidence content hash");
  return createHash("sha256").update(JSON.stringify(["erl-vector-key-v1", ...identityParts(identity), contentHash])).digest("hex");
}
function unitVector(values: readonly number[], dimensions: number): number[] {
  if (!Array.isArray(values) || values.length !== dimensions || values.some(value => !Number.isFinite(value)))
    throw Error("invalid evidence vector");
  // Scale first: avoid overflow for very large finite values.
  let scale = 0;
  for (const value of values) scale = Math.max(scale, Math.abs(value));
  if (!scale) throw Error("invalid evidence vector");
  const scaled = values.map(value => value / scale);
  let sum = 0;
  for (const value of scaled) sum += value * value;
  const norm = Math.sqrt(sum);
  return scaled.map(value => value / norm);
}
function tie<T extends LexicalChunk>(a: T, b: T): number {
  return a.sourceId.localeCompare(b.sourceId) || a.startByte - b.startByte || a.chunkId.localeCompare(b.chunkId);
}
/** Pure read-only ranking. Caller owns source/lifecycle validation before and
 * after ranking. No disk, embedder, model load, network or query cache writes.
 * Independent pools <=100; pinned reciprocal rank fusion constant 60.
 */
export function rankEvidenceHybrid<T extends LexicalChunk>(
  chunks: readonly T[], query: string, semantic: EvidenceSemanticPool | null, limit = 10,
): { items: { chunk: T; score: number }[]; diagnostics: ("semantic-fallback")[] } {
  const lexical = searchLexicalRanked(chunks, query, 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error("invalid evidence result limit");
  const fallback = () => ({ items: lexical.slice(0, limit), diagnostics: ["semantic-fallback" as const] });
  if (!semantic) return fallback();
  let cosine: { chunk: T; score: number }[];
  try {
    if (JSON.stringify(identityParts(semantic.identity)) !== JSON.stringify(identityParts(semantic.expectedIdentity)))
      throw Error("evidence model identity mismatch");
    const dimensions = semantic.identity.dimensions;
    const queryVector = unitVector(semantic.query, dimensions);
    if (!Array.isArray(semantic.vectors) || semantic.vectors.length > chunks.length ||
        semantic.vectors.length * dimensions * 8 > MAX_VECTOR_BYTES)
      throw Error("evidence vector budget exceeded");
    const vectors = new Map<string, number[]>();
    const expectedKeys = new Set(chunks.map(chunk => evidenceVectorKey(semantic.identity, chunk.contentHash)));
    for (const record of semantic.vectors) {
      if (!record || !expectedKeys.has(record.key) || vectors.has(record.key)) throw Error("invalid evidence vector key");
      vectors.set(record.key, unitVector(record.values, dimensions));
    }
    if (vectors.size !== expectedKeys.size) throw Error("missing evidence vector");
    cosine = chunks.map(chunk => {
      const values = vectors.get(evidenceVectorKey(semantic.identity, chunk.contentHash))!;
      let score = 0;
      for (let i = 0; i < dimensions; i++) score += queryVector[i]! * values[i]!;
      if (!Number.isFinite(score)) throw Error("invalid evidence cosine score");
      return { chunk, score };
    }).sort((a, b) => b.score - a.score || tie(a.chunk, b.chunk)).slice(0, 100);
  } catch { return fallback(); }
  const union = new Map<string, { chunk: T; score: number }>();
  for (const pool of [lexical, cosine]) {
    for (let i = 0; i < pool.length; i++) {
      const { chunk } = pool[i]!;
      const prior = union.get(chunk.chunkId), score = 1 / (60 + i + 1);
      if (prior) prior.score += score;
      else union.set(chunk.chunkId, { chunk, score });
    }
  }
  return { items: [...union.values()].sort((a, b) => b.score - a.score || tie(a.chunk, b.chunk)).slice(0, limit), diagnostics: [] };
}
