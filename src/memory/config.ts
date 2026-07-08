import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import type { MemoryConfig } from "./types";

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  schemaVersion: 1,
  ranking: {
    weights: { relevance: 1.0, recency: 0.5, confidence: 0.5, status: 0.5, scope: 0.5 },
    recencyDecayPerDay: 0.995,
    maxResults: 10,
  },
  confidence: { default: "medium", values: { low: 0.34, medium: 0.67, high: 1.0 } },
  statusBoost: {
    accepted: 1.0,
    draft: 0.4,
    conflict: 0.2,
    deprecated: 0.1,
    superseded: 0.1,
  },
  dedup: { titleSimilarity: 0.8, summaryJaccard: 0.6, minSharedScopeOrTags: 1 },
  ingest: { defaultStatus: "draft", allowAutoAccept: false },
  reflect: { minClusterSize: 3 },
  index: {
    enabled: false, // C1 default OFF ⇒ lexical only (C-2, AC-C1)
    runtime: "@xenova/transformers",
    modelAssetId: "memory-embed-default",
    k: 20,
    minScore: 0.0,
  },
  temporal: {
    enabled: true, // additive; a no-op on entries without validity fields
    defaultQuery: "current",
  },
  typing: {
    injectClasses: ["procedural"],
    injectLimit: 10,
  },
};

export function memoryConfigPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "memory.config.json");
}

export async function loadMemoryConfig(cwd: string): Promise<MemoryConfig> {
  const file = memoryConfigPath(cwd);
  if (!(await pathExists(file))) {
    return DEFAULT_MEMORY_CONFIG;
  }
  const parsed = await readJsonFileOr<Partial<MemoryConfig>>(file, {});
  const base = DEFAULT_MEMORY_CONFIG;
  return {
    schemaVersion: parsed.schemaVersion ?? base.schemaVersion,
    ranking: {
      ...base.ranking,
      ...(parsed.ranking ?? {}),
      weights: { ...base.ranking.weights, ...(parsed.ranking?.weights ?? {}) },
    },
    confidence: {
      ...base.confidence,
      ...(parsed.confidence ?? {}),
      values: { ...base.confidence.values, ...(parsed.confidence?.values ?? {}) },
    },
    statusBoost: { ...base.statusBoost, ...(parsed.statusBoost ?? {}) },
    dedup: { ...base.dedup, ...(parsed.dedup ?? {}) },
    ingest: { ...base.ingest, ...(parsed.ingest ?? {}) },
    reflect: { ...base.reflect, ...(parsed.reflect ?? {}) },
    index: { ...base.index, ...(parsed.index ?? {}) },
    temporal: { ...base.temporal, ...(parsed.temporal ?? {}) },
    typing: { ...base.typing, ...(parsed.typing ?? {}) },
  };
}

export function renderMemoryConfig(): string {
  return `${JSON.stringify(DEFAULT_MEMORY_CONFIG, null, 2)}\n`;
}
