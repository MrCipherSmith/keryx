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

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createGdgraphService, type GdgraphService } from "../../gdgraph/service";
import { findPath } from "../../gdgraph/path";
import { querySymbol } from "../../gdgraph/symbol";
import { loadGraph } from "../../gdgraph/query";
import { loadGdgraphConfig } from "../../gdgraph/config";
import {
  computeRepomap,
  type RepomapOptions,
  type RepomapResult as GdgraphRepomapResult,
} from "../../gdgraph/repomap";
import { createMemoryService } from "../../memory/service";
import { acceptedCurrentSearchFilters, clipAutomaticRecallText, MAX_AUTOMATIC_RECALL_RESULTS } from "../../memory/relevant";
import { MEMORY_CLASS_VALUES, type MemoryClass, type MemoryService, type SearchFilters } from "../../memory/types";
import { findRelatedTests } from "../../testing/service";
import { createCodeHealthService } from "../../health/service";
import type { CodeHealthService } from "../../health/types";
import { createFlowService } from "../../flow/service";
import { githubAdapter } from "../../flow/tracker/github";
import { securityFlowGate } from "../../security/guard";
import type { FlowService } from "../../flow/types";
import { wikiAsk } from "../../wiki/ask";
import { wikiPagesForFile } from "../../wiki/service";
import type { WikiAskInput, WikiAskResult as WikiAskFacadeResult } from "../../wiki/types";
import type {
  ContextSummaryResult,
  FlowStatusResult,
  GraphAffectedResult,
  GraphPathResult,
  GraphQueryResult,
  GraphSymbolResult,
  HealthStatusResult,
  MemorySearchResult,
  MetaprojectPort,
  RepomapResult,
  SearchCodeResult,
  SkillLoadResult,
  SkillsCatalogEntry,
  SkillsCatalogResult,
  TestRelatedResult,
  WikiAskResult,
  WikiBacklinksResult,
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
  /**
   * Task Manager flow-service factory (default: the real service, same wiring
   * as `commands/flow.ts`'s own `getService()`). Injectable for tests.
   */
  createFlowService: () => FlowService;
  /** Wiki Q&A resolver (default: the real gdwiki `ask` facade). Injectable for tests. */
  wikiAsk: (input: WikiAskInput) => Promise<WikiAskFacadeResult>;
  /**
   * Reverse "documented in" lookup: wiki pages referencing a repo file (default:
   * the real gdwiki `wikiPagesForFile` facade, which builds the backlink index
   * and delegates to `backlinksFor`). Injectable for tests.
   */
  wikiPagesForFile: (cwd: string, targetRepoPath: string) => Promise<string[]>;
  /**
   * NON-WRITING repomap compute (default: load graph + config + pure
   * `computeRepomap`). It never persists the repomap artifact, so the `repomap`
   * tool is truly read-only. Injectable for tests.
   */
  repomapCompute: (cwd: string, options: RepomapOptions) => Promise<GdgraphRepomapResult>;
  /**
   * Clock for `skillsCatalog`'s `generatedAt` (default: real wall-clock ISO
   * time). Injectable for tests — the only concession to this file's stated
   * "reads nothing from Date.now" determinism, kept isolated to this one
   * field rather than threading a clock through every method.
   */
  now: () => string;
}

const DEFAULT_DEPS: MetaprojectAdapterDeps = {
  createGdgraphService,
  createMemoryService,
  findRelatedTests,
  createCodeHealthService,
  createFlowService: () =>
    createFlowService({
      tracker: githubAdapter,
      healthGate: async (cwd) => {
        const result = await createCodeHealthService().gate({ cwd });
        return { status: result.status, reasons: result.reasons };
      },
      securityGate: (cwd) => securityFlowGate(cwd),
      now: () => new Date(),
    }),
  wikiAsk,
  wikiPagesForFile,
  now: () => new Date().toISOString(),
  repomapCompute: async (cwd, options) => {
    const [graph, config] = await Promise.all([loadGraph(cwd), loadGdgraphConfig(cwd)]);
    return computeRepomap(graph, config, options);
  },
};

/** Bounded excerpt/output cap so a structured result stays modest. */
const MAX_EXCERPT_BYTES = 400;
const MAX_QUERY_BYTES = 4096;
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function portableMemoryPath(candidate: string): string | null {
  const normalized = candidate.replaceAll("\\", "/");
  return !isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../") ? normalized : null;
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

/**
 * Confine `candidate` to the gdskills root (`<cwd>/.metaproject/skills/gdskills`).
 * Unlike `confineToWiki` (whose `candidate` is wiki-root-relative), `candidate`
 * here is PROJECT-root-relative — matching `SkillsCatalogEntry.path`'s own
 * contract (specification.md §3.2: `skill_load`'s `name` accepts either a bare
 * name or "an exact project-relative path", the same string `skills_catalog`
 * returns) — so it resolves against `cwd`, then verifies the result still
 * falls inside the gdskills root. Returns the absolute path, or `null` when it
 * resolves outside the gdskills root (whether via `..`, an absolute path, or
 * simply pointing elsewhere in the project).
 */
function confineToSkills(cwd: string, candidate: string): string | null {
  const skillsRoot = join(cwd, ".metaproject", "skills", "gdskills");
  const target = resolve(cwd, candidate);
  const rel = relative(skillsRoot, target);
  if (rel === "") {
    return null; // the root dir itself is not a skill
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null; // escapes the gdskills root
  }
  return target;
}

/** Strip a single layer of matching `"`/`'` quotes, if present. */
function stripSkillFieldQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Forgiving frontmatter parse for a SKILL.md's `description`/`triggers` fields.
 * Never throws: a malformed or absent frontmatter block yields `{}`, degrading
 * that one catalog entry rather than failing the whole `skillsCatalog` call.
 */
function parseSkillFrontmatter(content: string): { description?: string; triggers?: string[] } {
  if (!content.startsWith("---")) {
    return {};
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  const lines = content.slice(3, end).split("\n");
  let description: string | undefined;
  const triggers: string[] = [];
  let inTriggers = false;
  for (const line of lines) {
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch !== null && descMatch[1] !== undefined) {
      description = stripSkillFieldQuotes(descMatch[1].trim());
      inTriggers = false;
      continue;
    }
    if (/^triggers:\s*$/.test(line)) {
      inTriggers = true;
      continue;
    }
    if (inTriggers) {
      const itemMatch = /^\s+-\s*(.+)$/.exec(line);
      if (itemMatch !== null && itemMatch[1] !== undefined) {
        triggers.push(stripSkillFieldQuotes(itemMatch[1].trim()));
        continue;
      }
      inTriggers = false;
    }
  }
  return { ...(description !== undefined ? { description } : {}), ...(triggers.length > 0 ? { triggers } : {}) };
}

/**
 * Walk `.metaproject/skills/gdskills/<category>/<name>/SKILL.md` (exact
 * basename only — per-assistant variants like SKILL.opencode.md are not
 * catalog entries) and return every discovered skill, sorted by path. Never
 * throws: a missing gdskills root or an unreadable category/skill directory
 * yields fewer entries, not a failure.
 */
async function walkSkillCatalog(cwd: string): Promise<SkillsCatalogEntry[]> {
  const root = join(cwd, ".metaproject", "skills", "gdskills");
  const entries: SkillsCatalogEntry[] = [];
  let categoryDirs: Dirent[];
  try {
    categoryDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const categoryDir of categoryDirs) {
    if (!categoryDir.isDirectory()) {
      continue;
    }
    const categoryPath = join(root, categoryDir.name);
    let skillDirs: Dirent[];
    try {
      skillDirs = await readdir(categoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const skillDir of skillDirs) {
      if (!skillDir.isDirectory()) {
        continue;
      }
      const skillMdPath = join(categoryPath, skillDir.name, "SKILL.md");
      let content: string;
      try {
        content = await readFile(skillMdPath, "utf8");
      } catch {
        continue; // no SKILL.md in this directory
      }
      const { description, triggers } = parseSkillFrontmatter(content);
      entries.push({
        name: skillDir.name,
        path: relative(cwd, skillMdPath),
        category: categoryDir.name,
        description: description ?? "",
        ...(triggers !== undefined ? { triggers } : {}),
      });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function createMetaprojectAdapter(
  cwd: string,
  overrides: Partial<MetaprojectAdapterDeps> = {},
): MetaprojectPort {
  const deps: MetaprojectAdapterDeps = { ...DEFAULT_DEPS, ...overrides };
  const gdgraph = deps.createGdgraphService();
  const memory = deps.createMemoryService();
  const flow = deps.createFlowService();

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
      if (input.query.trim().length === 0 || Buffer.byteLength(input.query, "utf8") > MAX_QUERY_BYTES) {
        return { query: input.query, hits: [], error: "memory query must be non-empty and at most 4096 UTF-8 bytes" };
      }
      if (input.status !== undefined && input.status !== "accepted") {
        return { query: input.query, hits: [], error: "automatic memory search only accepts status accepted" };
      }
      if (input.class !== undefined && !(MEMORY_CLASS_VALUES as readonly string[]).includes(input.class)) {
        return { query: input.query, hits: [], error: "memory class is invalid" };
      }
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
        return { query: input.query, hits: [], error: "memory limit must be a positive integer" };
      }
      const requested: Pick<SearchFilters, "module" | "class" | "limit"> = {};
      if (input.module !== undefined) {
        requested.module = input.module;
      }
      if (input.class !== undefined) {
        requested.class = input.class as MemoryClass;
      }
      if (input.limit !== undefined) {
        requested.limit = Math.min(input.limit, MAX_AUTOMATIC_RECALL_RESULTS);
      }
      const filters = acceptedCurrentSearchFilters(new Date(), requested);
      const appliedFilters = {
        ...(input.module !== undefined ? { module: input.module } : {}),
        status: filters.status ?? "accepted",
        ...(input.class !== undefined ? { class: input.class } : {}),
      };
      try {
        const result = await memory.search({ cwd, query: input.query, filters });
        const hits = result.results
          .map((scored) => {
            const path = portableMemoryPath(scored.entry.relativePath);
            return path === null
              ? null
              : {
                  path,
                  title: clipAutomaticRecallText(scored.entry.title, 200),
                  type: scored.entry.type,
                  status: scored.entry.status,
                  score: scored.score,
                  excerpt: clipAutomaticRecallText(scored.entry.summary, MAX_EXCERPT_BYTES),
                };
          })
          .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
          .slice(0, MAX_AUTOMATIC_RECALL_RESULTS);
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

    async flowStatus(input): Promise<FlowStatusResult> {
      try {
        const flows = await flow.list({ cwd });
        const filtered =
          input.id !== undefined && input.id.length > 0 ? flows.filter((f) => f.id === input.id) : flows;
        return {
          flows: filtered.map((f) => ({
            id: f.id,
            status: f.status,
            title: f.title,
            tasksDone: f.tasksDone,
            tasksTotal: f.tasksTotal,
            dir: f.dir,
          })),
        };
      } catch (cause) {
        return { flows: [], error: errorMessage(cause) };
      }
    },

    // --- flow 044: additive read operations over gdgraph / gdwiki (batch 2) ----

    async graphSymbol(input): Promise<GraphSymbolResult> {
      try {
        const graph = await gdgraph.loadGraph(cwd);
        const result = querySymbol(graph, input.name);
        return {
          name: input.name,
          definitions: result.definitions.map((symbol) => ({
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            path: symbol.path,
            startLine: symbol.startLine,
            container: symbol.container,
          })),
          callers: result.callers.map((ref) => ref.label),
          callees: result.callees.map((ref) => ref.label),
        };
      } catch (cause) {
        return { name: input.name, definitions: [], callers: [], callees: [], error: errorMessage(cause) };
      }
    },

    async repomap(input): Promise<RepomapResult> {
      try {
        // Read-only: compute the map in-process (never writeRepomap → no artifact).
        const result = await deps.repomapCompute(
          cwd,
          input.budget !== undefined ? { budget: input.budget } : {},
        );
        return {
          budget: input.budget ?? result.tokens,
          files: result.entries.map((entry) => ({
            path: entry.path,
            score: entry.score,
            symbols: entry.symbols,
          })),
          tokens: result.tokens,
          omitted: result.omitted,
        };
      } catch (cause) {
        return {
          budget: input.budget ?? 0,
          files: [],
          tokens: 0,
          omitted: 0,
          error: errorMessage(cause),
        };
      }
    },

    async wikiAsk(input): Promise<WikiAskResult> {
      try {
        const result = await deps.wikiAsk({ cwd, question: input.question });
        return {
          question: result.question,
          citations: result.citations.map((citation) => ({
            path: citation.path,
            title: citation.title,
            excerpt: citation.excerpt,
            score: citation.score,
            source: citation.source,
          })),
          answer: result.answerMarkdown,
        };
      } catch (cause) {
        return { question: input.question, citations: [], answer: "", error: errorMessage(cause) };
      }
    },

    // --- flow 122: reverse "documented in" lookup over the wiki (MP-5a) --------

    async wikiBacklinks(input): Promise<WikiBacklinksResult> {
      try {
        const backlinks = await deps.wikiPagesForFile(cwd, input.file);
        return { file: input.file, backlinks: [...backlinks].sort() };
      } catch (cause) {
        return { file: input.file, backlinks: [], error: errorMessage(cause) };
      }
    },

    // --- gdskills runtime discovery (docs/requirements/keryx-skills-runtime-tools) --

    async skillsCatalog(): Promise<SkillsCatalogResult> {
      try {
        const skills = await walkSkillCatalog(cwd);
        return { skills, generatedAt: deps.now() };
      } catch (cause) {
        return { skills: [], generatedAt: deps.now(), error: errorMessage(cause) };
      }
    },

    async loadSkill(input): Promise<SkillLoadResult> {
      const catalog = await walkSkillCatalog(cwd);
      const byName = catalog.find((entry) => entry.name === input.name);
      if (byName !== undefined) {
        try {
          const content = await readFile(join(cwd, byName.path), "utf8");
          return { name: input.name, path: byName.path, content, found: true };
        } catch {
          return { name: input.name, path: "", content: "", found: false };
        }
      }
      // Not a bare name — try it as an exact path, confined to the gdskills
      // root, and require it to match a real catalog entry (never opens an
      // arbitrary file the walk itself did not already discover).
      const confined = confineToSkills(cwd, input.name);
      if (confined === null) {
        return { name: input.name, path: "", content: "", found: false };
      }
      const byPath = catalog.find((entry) => join(cwd, entry.path) === confined);
      if (byPath === undefined) {
        return { name: input.name, path: "", content: "", found: false };
      }
      try {
        const content = await readFile(confined, "utf8");
        return { name: input.name, path: byPath.path, content, found: true };
      } catch {
        return { name: input.name, path: "", content: "", found: false };
      }
    },
  };
}
