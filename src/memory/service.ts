import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { resolveCapability } from "../capability/seam";
import { loadMemoryConfig } from "./config";
import { checkMemory } from "./check";
import { findDuplicates, type Candidate } from "./dedup";
import { ingestMemory } from "./ingest";
import { candidatePool, renderSearchMarkdown, searchEntries } from "./search";
import { collectEntries, memoryRoot } from "./store";
import { supersedeEntry } from "./supersede";
import { renderMemoryEntry } from "./templates";
import { memoryEmbeddingSpec, type Embedder } from "./embedding/adapter";
import {
  buildEmbeddingIndex,
  embeddingsDir,
  loadEmbeddingIndex,
  rerankByEmbedding,
} from "./embedding/index";
import { MEMORY_TYPES } from "./types";
import type { MemoryConfig, MemoryEntry, ScoredEntry, SearchFilters } from "./types";
import type {
  MemoryCreateInput,
  MemoryCreateResult,
  MemoryIndexInput,
  MemoryIndexResult,
  MemoryIngestInput,
  MemoryIngestResult,
  MemorySearchInput,
  MemorySearchResult,
  MemoryService,
  MemorySupersedeInput,
  MemorySupersedeResult,
} from "./types";

function dataRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "memory");
}

export function createMemoryService(): MemoryService {
  return {
    async create(input: MemoryCreateInput): Promise<MemoryCreateResult> {
      const typeConfig = MEMORY_TYPES.find((t) => t.type === input.type);
      if (!typeConfig) {
        throw new Error(
          `Unsupported memory type: ${input.type}. Supported: ${MEMORY_TYPES.map((t) => t.type).join(", ")}`,
        );
      }

      const title = input.title ?? slugToTitle(input.slug ?? "untitled");
      const slug = input.slug ?? slugify(title);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        throw new Error(`Invalid slug: ${slug}. Use lowercase letters, digits, and hyphens.`);
      }

      const dir = path.join(memoryRoot(input.cwd), typeConfig.folder);
      const filePath = path.join(dir, `${slug}.md`);
      const relativePath = path.relative(input.cwd, filePath);
      if ((await pathExists(filePath)) && !input.force) {
        throw new Error(`Entry already exists: ${relativePath}. Use --force to overwrite.`);
      }

      const existing = await collectEntries(input.cwd);
      const candidate: Candidate = {
        title,
        summary: "",
        type: input.type,
        tags: [],
        scopes: { module: null, entity: null, files: [] },
      };
      const config = await loadMemoryConfig(input.cwd);
      const duplicates = findDuplicates(candidate, existing, config);

      await mkdir(dir, { recursive: true });
      await writeFile(
        filePath,
        renderMemoryEntry({
          title,
          type: input.type,
          date: new Date().toISOString().slice(0, 10),
          confidence: config.confidence.default,
        }),
        "utf8",
      );

      return { path: relativePath, type: input.type, duplicates };
    },

    async index(input: MemoryIndexInput): Promise<MemoryIndexResult> {
      const entries = await collectEntries(input.cwd);
      const generatedAt = new Date().toISOString();
      const indexDir = path.join(dataRoot(input.cwd), "index");
      await mkdir(indexDir, { recursive: true });
      const indexPath = path.join(indexDir, "index.json");
      await writeFile(
        indexPath,
        `${JSON.stringify(
          {
            generatedAt,
            entryCount: entries.length,
            entries: entries.map((e) => ({
              path: e.relativePath,
              type: e.type,
              status: e.status,
              confidence: e.confidence,
              title: e.title,
              updated: e.updated,
              tags: e.tags,
              scopes: e.scopes,
            })),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const result: MemoryIndexResult = {
        path: path.relative(input.cwd, indexPath),
        entryCount: entries.length,
        generatedAt,
      };

      // C1: optionally (re)build the derived, disposable embedding index. The
      // Markdown store above is untouched; this only writes the vector cache.
      if (input.embeddings) {
        const config = await loadMemoryConfig(input.cwd);
        const embedder = await resolveEmbedder(input.cwd, config);
        if (!embedder) {
          result.embeddings = { built: false };
        } else {
          const built = await buildEmbeddingIndex(
            input.cwd,
            entries,
            embedder.embed,
            embedder.model,
            new Date(),
          );
          result.embeddings = {
            built: true,
            path: path.relative(input.cwd, embeddingsDir(input.cwd)),
            vectorCount: built.meta.entryCount,
            model: built.meta.model,
          };
        }
      }

      return result;
    },

    async search(input: MemorySearchInput): Promise<MemorySearchResult> {
      const config = await loadMemoryConfig(input.cwd);
      const entries = await collectEntries(input.cwd);
      const filters = input.filters ?? {};
      const now = new Date();
      // The deterministic lexical candidate set is ALWAYS computed first — it is
      // both the default result and the fallback when embeddings are off/absent.
      let results = searchEntries(entries, input.query, filters, config, now);

      // C1: rerank only on the opt-in semantic path (explicit --semantic or
      // index.enabled). The default path never reaches the capability seam, so
      // no embedding runtime is imported and output is byte-identical (AC-C1).
      if (filters.semantic === true || config.index.enabled) {
        results = await semanticRerank(input.cwd, input.query, entries, filters, config, now, results);
      }

      const artifacts = path.join(dataRoot(input.cwd), "artifacts");
      await mkdir(artifacts, { recursive: true });
      const markdownPath = path.join(artifacts, "latest.md");
      const jsonPath = path.join(artifacts, "latest.json");
      const generatedAt = new Date().toISOString();

      await writeFile(markdownPath, renderSearchMarkdown(input.query, results), "utf8");
      await writeFile(
        jsonPath,
        `${JSON.stringify(
          { schemaVersion: config.schemaVersion, query: input.query, generatedAt, results },
          null,
          2,
        )}\n`,
        "utf8",
      );

      return {
        schemaVersion: config.schemaVersion,
        query: input.query,
        results,
        markdownPath: path.relative(input.cwd, markdownPath),
        jsonPath: path.relative(input.cwd, jsonPath),
      };
    },

    async ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
      const config = await loadMemoryConfig(input.cwd);
      return ingestMemory(input.cwd, input.source, input.path, config, new Date());
    },

    async supersede(input: MemorySupersedeInput): Promise<MemorySupersedeResult> {
      return supersedeEntry(input, new Date());
    },

    async check(input) {
      const config = await loadMemoryConfig(input.cwd);
      return checkMemory(input.cwd, config);
    },
  };
}

// Resolve the embedding capability to an `Embedder` (+ model id), or null when
// it must degrade. The capability seam emits the warn-once + returns null on any
// unsatisfied gate (disabled / dep missing / asset unverified). Never throws.
async function resolveEmbedder(
  cwd: string,
  config: MemoryConfig,
): Promise<{ embed: Embedder; model: string } | null> {
  const spec = memoryEmbeddingSpec(config.index.runtime, config.index.modelAssetId);
  const adapter = await resolveCapability(cwd, spec);
  if (!adapter) {
    return null;
  }
  return {
    embed: async (texts) => adapter.run({ texts }),
    model: config.index.modelAssetId,
  };
}

// C1 rerank: reorder the lexical candidate pool by embedding cosine similarity.
// The lexical result (`lexical`) is the fallback: when the capability is
// unavailable it is returned unchanged (warn-once already emitted by the seam).
async function semanticRerank(
  cwd: string,
  query: string,
  entries: MemoryEntry[],
  filters: SearchFilters,
  config: MemoryConfig,
  now: Date,
  lexical: ScoredEntry[],
): Promise<ScoredEntry[]> {
  try {
    const embedder = await resolveEmbedder(cwd, config);
    if (!embedder) {
      return lexical;
    }
    const pool = candidatePool(entries, query, filters, config, now, config.index.k);
    const index = await loadEmbeddingIndex(cwd);
    const reranked = await rerankByEmbedding(query, pool, embedder.embed, index);
    const limit = filters.limit ?? config.ranking.maxResults;
    return reranked.slice(0, limit);
  } catch {
    // Any embedding/adapter runtime error degrades to the deterministic lexical
    // result (AC-C4). The seam already emitted a warn-once on the failing gate.
    return lexical;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
