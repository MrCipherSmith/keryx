// Reference MetaprojectPort adapter (flow 037 / MP-2).
//
// `createMetaprojectAdapter(cwd, deps?)` returns a `MetaprojectPort` backed by the
// existing in-process service facades:
//   - graphAffected / graphQuery → createGdgraphService() (affected / query / loadGraph)
//   - memorySearch                → createMemoryService()  (search, deterministic ranked)
//   - readWiki                    → a root-confined file read under .metaproject/wiki/
//   - describeContext             → gdgraph loadGraph counts + wiki index presence
//
// The service FACTORIES are INJECTABLE via `deps` (defaulting to the real
// factories) so unit tests substitute fakes — no real graph build, no subprocess,
// no network. The adapter is deterministic: it reads nothing from `Date.now` /
// `Math.random`, and every method returns a structured result INSTEAD of throwing
// (a backing error becomes a structured empty/error result).

import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createGdgraphService, type GdgraphService } from "../../gdgraph/service";
import { findPath } from "../../gdgraph/path";
import { createMemoryService } from "../../memory/service";
import type { MemoryService, MemoryStatus, SearchFilters } from "../../memory/types";
import { findRelatedTests } from "../../testing/service";
import { createCodeHealthService } from "../../health/service";
import type { CodeHealthService } from "../../health/types";
import type {
  ContextSummaryResult,
  GraphAffectedResult,
  GraphPathResult,
  GraphQueryResult,
  HealthStatusResult,
  MemorySearchResult,
  MetaprojectPort,
  SearchCodeResult,
  TestRelatedResult,
  WikiPageResult,
} from "./metaproject-port";

/** Injectable backing factories (default: the real in-process service facades). */
export interface MetaprojectAdapterDeps {
  createGdgraphService: () => GdgraphService;
  createMemoryService: () => MemoryService;
  /** Related-tests resolver (default: the real testing facade). Injectable for tests. */
  findRelatedTests: (cwd: string, target: string) => Promise<string[]>;
  /** Code-health facade factory (default: the real health service). Injectable for tests. */
  createCodeHealthService: () => CodeHealthService;
}

const DEFAULT_DEPS: MetaprojectAdapterDeps = {
  createGdgraphService,
  createMemoryService,
  findRelatedTests,
  createCodeHealthService,
};

/** Bounded excerpt/output cap so a structured result stays modest. */
const MAX_EXCERPT_BYTES = 400;
/** The subset of MemoryStatus values exposed as a `status` filter. */
const MEMORY_STATUS_VALUES: readonly MemoryStatus[] = [
  "draft",
  "accepted",
  "deprecated",
  "conflict",
  "superseded",
];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Confine `candidate` to the wiki root (`<cwd>/.metaproject/wiki`). Returns the
 * absolute path, or `null` when it escapes via `..` or an absolute path.
 */
function confineToWiki(cwd: string, candidate: string): string | null {
  const wikiRoot = join(cwd, ".metaproject", "wiki");
  const target = resolve(wikiRoot, candidate);
  const rel = relative(wikiRoot, target);
  if (rel === "") {
    return null; // the root dir itself is not a page
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null; // escapes the wiki root
  }
  return target;
}

export function createMetaprojectAdapter(
  cwd: string,
  overrides: Partial<MetaprojectAdapterDeps> = {},
): MetaprojectPort {
  const deps: MetaprojectAdapterDeps = { ...DEFAULT_DEPS, ...overrides };
  const gdgraph = deps.createGdgraphService();
  const memory = deps.createMemoryService();

  return {
    // searchCode has no in-process facade (gdctx is CLI-only); return a structured
    // "unavailable" result so a caller without a subprocess fallback degrades
    // gracefully rather than throwing. The agent tool keeps the subprocess path.
    async searchCode(input): Promise<SearchCodeResult> {
      return {
        pattern: input.pattern,
        ...(input.path !== undefined ? { path: input.path } : {}),
        output: "search_code has no in-process backing (use the subprocess runner).",
        isError: true,
      };
    },

    async graphAffected(input): Promise<GraphAffectedResult> {
      const ranked = input.ranked ?? true;
      try {
        const result = await gdgraph.affected(cwd, input.target, {
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ranked,
        });
        const affected = ranked
          ? result.ranked.map((node) => ({ id: node.path, path: node.path, hop: node.hop, fanIn: node.fanIn }))
          : result.dependents.map((path) => ({ id: path, path, hop: 1 }));
        return { target: result.target, depth: result.depth, ranked, affected };
      } catch (cause) {
        return { target: input.target, affected: [], error: errorMessage(cause) };
      }
    },

    async graphQuery(input): Promise<GraphQueryResult> {
      try {
        const result = await gdgraph.query(cwd, input.query);
        return input.query === "orphans"
          ? { query: "orphans", orphans: result as string[] }
          : { query: "cycles", cycles: result as string[][] };
      } catch (cause) {
        return { query: input.query, error: errorMessage(cause) };
      }
    },

    async memorySearch(input): Promise<MemorySearchResult> {
      const filters: SearchFilters = {};
      if (input.module !== undefined) {
        filters.module = input.module;
      }
      if (input.status !== undefined && (MEMORY_STATUS_VALUES as readonly string[]).includes(input.status)) {
        filters.status = input.status as MemoryStatus;
      }
      if (input.limit !== undefined) {
        filters.limit = input.limit;
      }
      const appliedFilters = {
        ...(input.module !== undefined ? { module: input.module } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      };
      try {
        const result = await memory.search({ cwd, query: input.query, filters });
        const hits = result.results.map((scored) => ({
          path: scored.entry.relativePath,
          title: scored.entry.title,
          type: scored.entry.type,
          status: scored.entry.status,
          score: scored.score,
          excerpt: clip(scored.entry.summary, MAX_EXCERPT_BYTES),
        }));
        return {
          query: input.query,
          ...(Object.keys(appliedFilters).length > 0 ? { filters: appliedFilters } : {}),
          hits,
        };
      } catch (cause) {
        return {
          query: input.query,
          ...(Object.keys(appliedFilters).length > 0 ? { filters: appliedFilters } : {}),
          hits: [],
          error: errorMessage(cause),
        };
      }
    },

    async readWiki(input): Promise<WikiPageResult> {
      const target = confineToWiki(cwd, input.path);
      if (target === null) {
        return {
          path: input.path,
          content: "",
          isError: true,
          error: `wiki path escapes the wiki root: ${input.path}`,
        };
      }
      try {
        const content = await readFile(target, "utf8");
        return { path: input.path, content, isError: false };
      } catch (cause) {
        return { path: input.path, content: "", isError: true, error: errorMessage(cause) };
      }
    },

    async describeContext(): Promise<ContextSummaryResult> {
      let graphNodes = 0;
      let graphEdges = 0;
      let graphError: string | undefined;
      try {
        const graph = await gdgraph.loadGraph(cwd);
        graphNodes = graph.nodes.length;
        graphEdges = graph.edges.length;
      } catch (cause) {
        graphError = errorMessage(cause);
      }
      let hasWikiIndex = false;
      try {
        await readFile(join(cwd, ".metaproject", "wiki", "index.md"), "utf8");
        hasWikiIndex = true;
      } catch {
        hasWikiIndex = false;
      }
      return {
        root: cwd,
        graphNodes,
        graphEdges,
        hasWikiIndex,
        ...(graphError !== undefined ? { error: graphError } : {}),
      };
    },

    // --- flow 043: additive read operations over gdgraph / testing / health -----

    async graphPath(input): Promise<GraphPathResult> {
      try {
        const graph = await gdgraph.loadGraph(cwd);
        const result = findPath(graph, input.from, input.to);
        const unresolved = result.fromResolved.length === 0 || result.toResolved.length === 0;
        return {
          from: input.from,
          to: input.to,
          nodes: result.nodes,
          ...(unresolved ? { unresolved: true } : {}),
        };
      } catch (cause) {
        return { from: input.from, to: input.to, nodes: [], error: errorMessage(cause) };
      }
    },

    async testRelated(input): Promise<TestRelatedResult> {
      try {
        const tests = await deps.findRelatedTests(cwd, input.file);
        return { file: input.file, tests: [...tests].sort() };
      } catch (cause) {
        return { file: input.file, tests: [], error: errorMessage(cause) };
      }
    },

    async healthStatus(): Promise<HealthStatusResult> {
      try {
        const status = await deps.createCodeHealthService().status({ cwd });
        return {
          enabled: status.enabled,
          lastRunAt: status.lastRunAt,
          gate: status.gate,
          sources: status.sources,
          projectScore: status.projectScore,
          regressions: status.regressions,
        };
      } catch (cause) {
        return {
          enabled: false,
          lastRunAt: null,
          gate: null,
          sources: [],
          projectScore: null,
          regressions: 0,
          error: errorMessage(cause),
        };
      }
    },
  };
}
