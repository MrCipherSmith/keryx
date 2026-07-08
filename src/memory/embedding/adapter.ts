// Embedding adapter (C1 — spec §7.1; C0-2, AC-C4). A Block 0 `CapabilitySpec`:
// the optional embedding runtime (`@xenova/transformers`) is imported ONLY via
// the seam's lazy `await import()` — this file never imports it statically. The
// seam passes the imported module in as `dep` and the resolved+verified model
// path as `asset`; `isAvailable()` is true only when BOTH resolved. `run()`
// never throws out (the seam catches it) so a failure degrades to lexical.
//
// The Markdown store is never the source of truth here: the adapter only turns
// text into vectors; ranking always starts from `collectEntries()`.

import type { CapabilityAdapter, CapabilitySpec } from "../../capability/seam";

export const MEMORY_EMBEDDING_ID = "memory.embedding";
export const DEFAULT_EMBED_DIMS = 96;

export type EmbedInput = { texts: string[] };
export type EmbedOutput = Float32Array[];

// The interface named in the spec; the index/rerank consume this shape. An
// adapter obtained from the seam is bridged into an `Embedder` (below).
export interface EmbeddingAdapter {
  readonly name: typeof MEMORY_EMBEDDING_ID;
  isAvailable(): Promise<boolean>;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// A plain vectorizer function — what the index + rerank actually call.
export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

// Deterministic, dependency-free, seeded vectorizer. Bag-of-token term-frequency
// hashed into a fixed-dim vector, L2-normalized ⇒ cosine == TF cosine. This is
// NOT the shipped model: it exists so the rerank + recall + adapter contract are
// provable OFFLINE (no download). The real semantic runtime, when present and
// its model asset verified, replaces it via the production path below.
export function deterministicEmbed(text: string, dims = DEFAULT_EMBED_DIMS): Float32Array {
  const vector = new Float32Array(dims);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
  for (const token of tokens) {
    const slot = hashToken(token) % dims;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  return l2normalize(vector);
}

export function deterministicEmbedder(dims = DEFAULT_EMBED_DIMS): Embedder {
  return async (texts) => texts.map((text) => deterministicEmbed(text, dims));
}

function hashToken(token: string): number {
  // FNV-1a — stable across processes/platforms (no Math.random, no time).
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function l2normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return vector;
  }
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = (vector[i] ?? 0) / norm;
  }
  return vector;
}

export interface MakeEmbeddingSpecOptions {
  optionalDependency?: string | undefined;
  asset?: string | undefined;
  // Inject a deterministic embedder (tests / offline). When set, the production
  // runtime path is bypassed and availability follows dep/asset resolution.
  embedder?: Embedder | undefined;
  dims?: number | undefined;
}

// Build the CapabilitySpec the seam resolves. Availability mirrors the reference
// capability: available only when whatever this spec declared actually resolved.
export function makeEmbeddingSpec(
  opts: MakeEmbeddingSpecOptions = {},
): CapabilitySpec<EmbedInput, EmbedOutput> {
  const dims = opts.dims ?? DEFAULT_EMBED_DIMS;
  return {
    id: MEMORY_EMBEDDING_ID,
    ...(opts.optionalDependency !== undefined
      ? { optionalDependency: opts.optionalDependency }
      : {}),
    ...(opts.asset !== undefined ? { asset: opts.asset } : {}),
    load({ dep, asset }): CapabilityAdapter<EmbedInput, EmbedOutput> {
      return {
        id: MEMORY_EMBEDDING_ID,
        async isAvailable() {
          const depOk = opts.optionalDependency === undefined || dep !== undefined;
          const assetOk = opts.asset === undefined || asset !== null;
          return depOk && assetOk;
        },
        async run(input) {
          if (opts.embedder) {
            return opts.embedder(input.texts);
          }
          // Production path: use the lazily-imported runtime + verified model
          // asset. Best-effort and guarded by the seam (a throw ⇒ lexical
          // fallback). Kept minimal because it is only reachable when the
          // optional dep imports AND the model asset passes sha256 verification.
          return runRuntimeEmbedder(dep, asset, input.texts, dims);
        },
      };
    },
  };
}

// The default shipped spec: the reference embedding runtime + pinned model asset
// (both resolved through Block 0). With nothing installed / no verified asset it
// resolves to `null` and the service runs lexical-only (the golden-rule path).
export function memoryEmbeddingSpec(
  runtime: string,
  modelAssetId: string,
): CapabilitySpec<EmbedInput, EmbedOutput> {
  return makeEmbeddingSpec({ optionalDependency: runtime, asset: modelAssetId });
}

// Minimal runtime bridge to `@xenova/transformers`'s feature-extraction
// pipeline. Typed structurally so this file never imports the package. Throws
// when the runtime shape is unexpected (caught by the seam ⇒ lexical fallback).
async function runRuntimeEmbedder(
  dep: unknown,
  asset: { path: string } | null,
  texts: string[],
  dims: number,
): Promise<Float32Array[]> {
  const mod = dep as { pipeline?: unknown } | undefined;
  if (!mod || typeof mod.pipeline !== "function" || !asset) {
    throw new Error("embedding runtime unavailable");
  }
  const pipeline = mod.pipeline as (
    task: string,
    model: string,
  ) => Promise<(input: string, opts: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>>;
  const extractor = await pipeline("feature-extraction", asset.path);
  const out: Float32Array[] = [];
  for (const text of texts) {
    const result = await extractor(text, { pooling: "mean", normalize: true });
    const vector = new Float32Array(dims);
    const data = result.data;
    for (let i = 0; i < dims && i < data.length; i += 1) {
      vector[i] = data[i] ?? 0;
    }
    out.push(vector);
  }
  return out;
}
