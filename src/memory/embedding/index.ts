// Derived embedding index (C1 — spec §7.1, §9.3; AC-C3, AC-C11). A DISPOSABLE,
// content-hash-keyed vector cache under `.metaproject/data/memory/embeddings/`.
// The Markdown store is NEVER mutated by indexing: this module only READS
// entries and WRITES the derived cache. Deleting the cache and rebuilding for
// the same model yields identical vectors (deterministic embedder + stable
// content hash), hence identical rankings.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";
import type { MemoryEntry, ScoredEntry } from "../types";
import type { Embedder } from "./adapter";

export interface EmbeddingIndexMeta {
  model: string;
  dims: number;
  generatedAt: string;
  entryCount: number;
}

export interface EmbeddingVectorRecord {
  entryPath: string;
  contentHash: string;
  vector: number[];
}

export interface EmbeddingIndex {
  meta: EmbeddingIndexMeta;
  // entryPath -> { contentHash, vector }
  byPath: Map<string, { contentHash: string; vector: Float32Array }>;
}

export function embeddingsDir(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "memory", "embeddings");
}

// The stable text an entry embeds to. Derived purely from Markdown fields so the
// content hash changes iff the meaningful content changes.
export function entryText(entry: MemoryEntry): string {
  return `${entry.title}\n${entry.summary}\n${entry.tags.join(" ")}\n${entry.details}`.trim();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Build + persist the derived index from Markdown entries. Returns the built
// index. Never mutates the store. Vectors are written in a stable (path-sorted)
// order so the on-disk file is byte-stable for a given corpus + model.
export async function buildEmbeddingIndex(
  cwd: string,
  entries: MemoryEntry[],
  embedder: Embedder,
  model: string,
  now: Date,
): Promise<EmbeddingIndex> {
  const sorted = [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const texts = sorted.map(entryText);
  const vectors = await embedder(texts);
  const dims = vectors[0]?.length ?? 0;

  const records: EmbeddingVectorRecord[] = sorted.map((entry, i) => ({
    entryPath: entry.relativePath,
    contentHash: contentHash(texts[i] ?? ""),
    vector: Array.from(vectors[i] ?? new Float32Array(dims)),
  }));

  const meta: EmbeddingIndexMeta = {
    model,
    dims,
    generatedAt: now.toISOString(),
    entryCount: records.length,
  };

  const dir = embeddingsDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(dir, "vectors.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""),
    "utf8",
  );

  return toIndex(meta, records);
}

// Load the derived index from disk, or null when absent/corrupt (⇒ caller
// embeds on the fly or falls back to lexical). Reads local files only.
export async function loadEmbeddingIndex(cwd: string): Promise<EmbeddingIndex | null> {
  const dir = embeddingsDir(cwd);
  const metaPath = path.join(dir, "index.meta.json");
  const vectorsPath = path.join(dir, "vectors.jsonl");
  if (!(await pathExists(metaPath)) || !(await pathExists(vectorsPath))) {
    return null;
  }
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as EmbeddingIndexMeta;
    const records: EmbeddingVectorRecord[] = [];
    for (const line of (await readFile(vectorsPath, "utf8")).split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      records.push(JSON.parse(line) as EmbeddingVectorRecord);
    }
    return toIndex(meta, records);
  } catch {
    return null;
  }
}

function toIndex(meta: EmbeddingIndexMeta, records: EmbeddingVectorRecord[]): EmbeddingIndex {
  const byPath = new Map<string, { contentHash: string; vector: Float32Array }>();
  for (const record of records) {
    byPath.set(record.entryPath, {
      contentHash: record.contentHash,
      vector: Float32Array.from(record.vector),
    });
  }
  return { meta, byPath };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Rerank a lexical candidate pool by cosine similarity to the query. NEVER
// introduces entries absent from `pool` (all pool entries came from Markdown).
// A stale content hash ⇒ re-embed that entry on the fly (Markdown wins over the
// index; XP4). Ties fall back to the original lexical order (stable sort).
export async function rerankByEmbedding(
  query: string,
  pool: ScoredEntry[],
  embedder: Embedder,
  index: EmbeddingIndex | null,
): Promise<ScoredEntry[]> {
  if (pool.length === 0) {
    return pool;
  }

  const [queryVector] = await embedder([query]);
  if (!queryVector) {
    return pool;
  }

  // Determine which entries need on-the-fly embedding (missing or stale hash).
  const needsEmbed: { poolIndex: number; text: string }[] = [];
  const vectors: (Float32Array | null)[] = pool.map((scored, i) => {
    const text = entryText(scored.entry);
    const cached = index?.byPath.get(scored.entry.relativePath);
    if (cached && cached.contentHash === contentHash(text)) {
      return cached.vector;
    }
    needsEmbed.push({ poolIndex: i, text });
    return null;
  });

  if (needsEmbed.length > 0) {
    const fresh = await embedder(needsEmbed.map((item) => item.text));
    needsEmbed.forEach((item, i) => {
      vectors[item.poolIndex] = fresh[i] ?? null;
    });
  }

  return pool
    .map((scored, i) => ({
      scored,
      order: i,
      sim: vectors[i] ? cosine(queryVector, vectors[i] as Float32Array) : -1,
    }))
    .sort((a, b) => (b.sim - a.sim) || (a.order - b.order))
    .map((item) => item.scored);
}
