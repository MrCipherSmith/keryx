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
import { collectEntries, collectEntriesStrict, memoryRoot, memoryRootFor, type MemoryScanProblem } from "./store";
import { supersedeEntry } from "./supersede";
import { transitionMemoryStatus } from "./lifecycle";
import { resolveCanonicalEntryPath, writeCanonicalEntry } from "./write";
import { containsHarnessHeaderLine, renderMemoryEntry } from "./templates";
import { selectHandoffEntries } from "./handoff";
import { isMemoryHarnessId, MEMORY_HARNESS_IDS } from "./harness-identity";
import { memoryEmbeddingSpec, type Embedder } from "./embedding/adapter";
import {
  buildEmbeddingIndex,
  embeddingsDir,
  loadEmbeddingIndex,
  rerankByEmbedding,
} from "./embedding/index";
import { MEMORY_TYPES, MEMORY_TYPE_VALUES } from "./types";
import type { MemoryConfig, MemoryEntry, ScoredEntry, SearchFilters } from "./types";

// Flow 313 (W4): re-exported so `src/mcp/` (which may import only this
// facade, never `./harness-identity` directly — M-3 boundary test) can
// validate a harness id without a second cross-module import.
export { isMemoryHarnessId, MEMORY_HARNESS_IDS, MEMORY_TYPE_VALUES };

// Flow 313 (W4) review R3-F8, choke point d: re-exported for the same M-3
// reason — `src/mcp/tools.ts`'s `memory.propose` boundary check uses this
// SAME function (never a locally re-derived copy of the pattern).
export { containsHarnessHeaderLine };

export { selectHandoffEntries } from "./handoff";
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

// --- Flow 313 (W4 portability): docs/requirements/keryx-agent-platform-
// expansion/workstreams/W4-portability.md, "Cross-harness memory handoff".
// Standalone functions (not on the `MemoryService` interface) so `src/mcp/`
// tools can call them without importing `./store` / `./handoff` directly —
// this facade (`./service`) is the only memory module import the M-3
// boundary test allows into `src/mcp/`.

export type MemoryHandoffInput = { cwd: string; from: string; target: string; scope?: "project" | "user" };
export type MemoryHandoffEntrySummary = {
  path: string;
  title: string;
  sourceHarness: string | null;
  targetHarnesses: string[] | null;
};
export type MemoryHandoffResult = {
  status: "complete" | "incomplete";
  entries: MemoryHandoffEntrySummary[];
  problems: MemoryScanProblem[];
};

export async function memoryHandoff(input: MemoryHandoffInput): Promise<MemoryHandoffResult> {
  const root = memoryRootFor(input.scope ?? "project", input.cwd);
  const scan = await collectEntriesStrict(root);
  const selected = selectHandoffEntries(scan.entries, { from: input.from, target: input.target });
  return {
    status: scan.status,
    entries: selected.map((entry) => ({
      path: entry.relativePath,
      title: entry.title,
      sourceHarness: entry.sourceHarness ?? null,
      targetHarnesses: entry.targetHarnesses ?? null,
    })),
    problems: scan.problems,
  };
}

/**
 * Flow 313 (W4) review R1-F4/R1-F14: the ONE read primitive every MCP memory
 * read filters entries through before scoring/listing/citing them —
 * `memory.search`, `memory_search` (the metaproject-operations projection),
 * MCP `memory` resources (list + read), and `wiki.ask`/`wiki_ask`'s memory
 * citations. Before this, only `memory.search` and `memory.handoff` applied
 * any `target_harnesses` restriction at all — the other three surfaces read
 * `collectEntries`/`collectPages` directly and leaked every restricted
 * entry to every harness.
 *
 * `targetHarnessesInvalid` (set by `./store.ts#parseEntry`, R1-F14) hides the
 * entry from EVERY harness identity, bound or unbound — a malformed/
 * ambiguous restriction must never collapse to "unrestricted"; that is
 * exactly the fail-open bug this flag exists to close. An absent/empty
 * `targetHarnesses` (the back-compatible "no restriction" default) is
 * visible to everyone, including an unbound (`null`) caller. A present,
 * valid restriction is visible only to a bound identity it names — an
 * unbound caller never matches a named restriction, because there is no
 * caller identity a restricted entry could legitimately be shown to.
 */
export function filterEntriesForHarness<
  T extends {
    targetHarnesses?: string[] | null | undefined;
    targetHarnessesInvalid?: boolean | undefined;
  },
>(entries: readonly T[], harnessIdentity: string | null): T[] {
  return entries.filter((entry) => {
    if (entry.targetHarnessesInvalid) {
      return false;
    }
    const targets = entry.targetHarnesses;
    if (!targets || targets.length === 0) {
      return true;
    }
    return harnessIdentity !== null && targets.includes(harnessIdentity);
  });
}

/**
 * The set of project-scope memory `relativePath`s a given (or unbound)
 * harness identity may read, per `filterEntriesForHarness` above. For a
 * caller that lists/reads relativePaths taken DIRECTLY from the same memory
 * root (MCP `memory` resources, `./store.ts` output) — every such path
 * necessarily corresponds to a real, filtered-or-not entry, so absence from
 * this set always means "restricted for this harness", never "unknown path".
 */
export async function memoryAllowedRelativePaths(
  cwd: string,
  harnessIdentity: string | null,
): Promise<Set<string>> {
  const entries = await collectEntries(cwd);
  return new Set(filterEntriesForHarness(entries, harnessIdentity).map((entry) => entry.relativePath));
}

/**
 * `relativePath -> visible?` for every ON-DISK entry, for a caller that
 * cross-references a SEPARATELY computed hit list (`memory.search`,
 * `memory_search`) by path rather than reading `relativePath`s straight off
 * the memory root. A hit whose path has NO matching on-disk entry — never
 * true in production, where the ranking and this map read the identical
 * store, but possible with a decoupled/fake `MetaprojectPort` in tests — is
 * treated as "unknown, not this filter's concern" (visible), exactly
 * mirroring the pre-fix behaviour for that case; a hit backed by a real
 * entry is filtered exactly as `filterEntriesForHarness` decides.
 *
 * Flow 313 (W4) review round 2, R2-I1 evaluated this default and left it as
 * "visible": flipping it to fail-closed excludes every fixture hit in a
 * decoupled-port test (no on-disk store to match against — see
 * `src/mcp/memory-p0.test.ts`'s "MCP fake port fixture" purity test) for no
 * production security gain, since real callers' hit paths and this map
 * always read the identical store. The finding is info-severity with no
 * demonstrated impact; both call sites document this same reasoning.
 */
export async function memoryHarnessVisibilityByPath(
  cwd: string,
  harnessIdentity: string | null,
): Promise<Map<string, boolean>> {
  const entries = await collectEntries(cwd);
  const allowed = new Set(filterEntriesForHarness(entries, harnessIdentity).map((entry) => entry.relativePath));
  const visibility = new Map<string, boolean>();
  for (const entry of entries) {
    visibility.set(entry.relativePath, allowed.has(entry.relativePath));
  }
  return visibility;
}

export type MemoryProposeInput = {
  cwd: string;
  title: string;
  type: string;
  summary: string;
  details?: string;
  sourceHarness?: string | null;
  targetHarnesses?: string[];
};
export type MemoryProposeResult =
  | { status: "written"; path: string }
  | { status: "skipped"; path: string; securitySkipped: string }
  | { status: "invalid-type"; message: string };

export async function memoryPropose(input: MemoryProposeInput): Promise<MemoryProposeResult> {
  const typeConfig = MEMORY_TYPES.find((t) => t.type === input.type);
  if (!typeConfig) {
    return { status: "invalid-type", message: `Unknown memory type: ${input.type}. Supported: ${MEMORY_TYPE_VALUES.join(", ")}` };
  }
  const slug = proposalSlug(input.title);
  const date = new Date().toISOString().slice(0, 10);
  const content = renderMemoryEntry({
    title: input.title,
    type: input.type,
    date,
    summary: input.summary,
    ...(input.details && input.details.length > 0 ? { details: input.details } : {}),
    ...(input.sourceHarness ? { sourceHarness: input.sourceHarness } : {}),
    ...(input.targetHarnesses && input.targetHarnesses.length > 0 ? { targetHarnesses: input.targetHarnesses } : {}),
  });
  const write = await writeCanonicalEntry({
    cwd: input.cwd,
    relativePath: `${typeConfig.folder}/${slug}.md`,
    content,
  });
  if (write.status === "error") {
    throw new Error(write.error.message);
  }
  return write.status === "skipped"
    ? { status: "skipped", path: write.path, securitySkipped: write.reason }
    : { status: "written", path: write.path };
}

function proposalSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${base.length > 0 ? base : "proposal"}-${suffix}`;
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
