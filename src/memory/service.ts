import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { resolveCapability } from "../capability/seam";
import { loadMemoryConfig } from "./config";
import { checkMemory } from "./check";
import { findDuplicates, type Candidate } from "./dedup";
import { ingestMemory } from "./ingest";
import { candidatePool, searchEntries } from "./search";
import { createMemoryReportStore } from "./report";
import { collectEntries, memoryRoot } from "./store";
import { supersedeEntry } from "./supersede";
import { transitionMemoryStatus } from "./lifecycle";
import { resolveCanonicalEntryPath, writeCanonicalEntry } from "./write";
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
  MemoryTransitionInput,
  MemoryTransitionResult,
} from "./types";

function dataRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "memory");
}

export function createMemoryService(): MemoryService {
  const reportStore = createMemoryReportStore();
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

      const write = await writeCanonicalEntry({
        cwd: input.cwd,
        relativePath: `${typeConfig.folder}/${slug}.md`,
        content: renderMemoryEntry({
          title,
          type: input.type,
          date: new Date().toISOString().slice(0, 10),
          confidence: config.confidence.default,
        }),
      });
      if (write.status === "error") throw new Error(write.error.message);

      return write.status === "skipped"
        ? { path: relativePath, type: input.type, duplicates, securitySkipped: write.reason }
        : { path: relativePath, type: input.type, duplicates };
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
            // generatedAt remains a user-facing result field; the persisted
            // catalog itself is source-fingerprint based and reproducible.
            catalogVersion: 1,
            sourceFingerprint: createHash("sha256").update(JSON.stringify(entries.map((e) => ({
              path: e.relativePath,
              content: [e.title, e.type, e.status, e.confidence, e.summary, e.details, e.tags, e.scopes, e.validFrom, e.validTo].join("\u0000"),
            })))).digest("hex"),
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
      const now = input.now ?? new Date();
      // The deterministic lexical candidate set is ALWAYS computed first — it is
      // both the default result and the fallback when embeddings are off/absent.
      let results = searchEntries(entries, input.query, filters, config, now);

      // C1: rerank only on the opt-in semantic path (explicit --semantic or
      // index.enabled). The default path never reaches the capability seam, so
      // no embedding runtime is imported and output is byte-identical (AC-C1).
      if (filters.semantic === true || config.index.enabled) {
        results = await semanticRerank(input.cwd, input.query, entries, filters, config, now, results);
      }

      return {
        schemaVersion: config.schemaVersion,
        query: input.query,
        results,
      };
    },

    async writeReport(input) {
      return reportStore.writeReport(input);
    },

    async ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
      const config = await loadMemoryConfig(input.cwd);
      return ingestMemory(input.cwd, input.source, input.path, config, new Date());
    },

    async supersede(input: MemorySupersedeInput): Promise<MemorySupersedeResult> {
      return supersedeEntry(input, new Date());
    },

    async transition(input: MemoryTransitionInput): Promise<MemoryTransitionResult> {
      const resolved = await resolveCanonicalEntryPath(input.cwd, input.path);
      if (!resolved) {
        return { path: input.path, from: "draft", to: input.to, changed: false, error: { code: "not-found", message: "Memory entry path must be confined to the typed memory root." } };
      }
      let content: string;
      try { content = await readFile(resolved.absolutePath, "utf8"); } catch {
        return { path: resolved.relativePath, from: "draft", to: input.to, changed: false, error: { code: "not-found", message: `Memory entry not found: ${resolved.relativePath}` } };
      }
      const from = statusOf(content);
      const permitted = transitionMemoryStatus(from, input.to);
      if (!permitted.ok) return { path: resolved.relativePath, from, to: input.to, changed: false, error: permitted.error };
      if (!permitted.changed) return { path: resolved.relativePath, from, to: input.to, changed: false };
      const date = (input.now ?? new Date()).toISOString().slice(0, 10);
      let next = setHeader(content, "Status", input.to);
      if (!header(next, "Recorded-At")) next = setHeader(next, "Recorded-At", date);
      next = setProvenanceUpdated(next, date);
      next = appendChangelog(next, `- Lifecycle: ${from} -> ${input.to} on ${date}${input.reason ? `: ${input.reason}` : ""}.`);
      const write = await writeCanonicalEntry({ cwd: input.cwd, relativePath: resolved.relativePath, content: next });
      if (write.status === "skipped") return { path: resolved.relativePath, from, to: input.to, changed: false, securitySkipped: write.reason };
      if (write.status === "error") return { path: resolved.relativePath, from, to: input.to, changed: false, error: { code: "write-failed", message: write.error.message } };
      return { path: resolved.relativePath, from, to: input.to, changed: true };
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

function header(content: string, key: string): string | null { return content.match(new RegExp(`^${escapeRe(key)}:\\s*(.*)$`, "mi"))?.[1]?.trim() || null; }
function statusOf(content: string): import("./types").MemoryStatus { const value = header(content, "Status"); return value === "accepted" || value === "deprecated" || value === "conflict" || value === "superseded" ? value : "draft"; }
function setHeader(content: string, key: string, value: string): string { const re = new RegExp(`^${escapeRe(key)}:\\s*.*$`, "mi"); if (re.test(content)) return content.replace(re, `${key}: ${value}`); const lines = content.split("\n"); const index = lines.findIndex((line) => /^##\s/.test(line)); lines.splice(index < 0 ? 1 : index, 0, `${key}: ${value}`); return lines.join("\n"); }
function setProvenanceUpdated(content: string, date: string): string { return /^[-*]\s*Updated:/mi.test(content) ? content.replace(/^[-*]\s*Updated:.*$/mi, `- Updated: ${date}`) : content.replace(/(##\s+Provenance\s*\n)/i, `$1\n- Updated: ${date}\n`); }
function appendChangelog(content: string, note: string): string { if (content.includes(note)) return content; return /^##\s+Changelog\s*$/mi.test(content) ? content.replace(/^##\s+Changelog\s*$/mi, `## Changelog\n\n${note}`) : `${content.trimEnd()}\n\n## Changelog\n\n${note}\n`; }
function escapeRe(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
