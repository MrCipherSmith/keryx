import { freshnessReportPath, readWikiFreshnessMetric } from "../../health/metrics/wiki-freshness";
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
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isPathInside } from "../../lib/fs";
import { readContainedFile } from "../../lib/contained-read";
import { createGdgraphService, type GdgraphService } from "../../gdgraph/service";
import { findCandidates, type FindOutcome, type FindOptions } from "../../gdgraph/find";
import { normalizeRetrievalCode, RETRIEVAL_NEXT_ACTIONS } from "../../lib/retrieval-codes";
import { findPath } from "../../gdgraph/path";
import { querySymbol } from "../../gdgraph/symbol";
import { loadGraph } from "../../gdgraph/query";
import { loadGdgraphConfig } from "../../gdgraph/config";
import { checkGraphStaleness, type StalenessCheck } from "../../gdgraph/staleness";
import {
  computeRepomap,
  type RepomapOptions,
  type RepomapResult as GdgraphRepomapResult,
} from "../../gdgraph/repomap";
import { parseSkillFrontmatter } from "../../gdskills/skill-frontmatter";
import { createMemoryService } from "../../memory/service";
import { acceptedCurrentSearchFilters, clipAutomaticRecallText, MAX_AUTOMATIC_RECALL_RESULTS } from "../../memory/relevant";
import { MEMORY_CLASS_VALUES, type MemoryClass, type MemoryService, type SearchFilters } from "../../memory/types";
import { computeTestingContext, relatedTestsInContext } from "../../testing/service";
import type { TestingContext } from "../../testing/types";
import { createCodeHealthService } from "../../health/service";
import type { CodeHealthService } from "../../health/types";
import { createFlowService } from "../../flow/service";
import { githubAdapter } from "../../flow/tracker/github";
import { securityFlowGate } from "../../security/guard";
import type { FlowService } from "../../flow/types";
import { wikiAsk } from "../../wiki/ask";
import { wikiEvidence, wikiPagesForFile, type WikiEvidenceInput } from "../../wiki/service";
import type { EvidencePackage } from "../../wiki/evidence";
import type { WikiAskInput, WikiAskResult as WikiAskFacadeResult } from "../../wiki/types";
import type {
  ContextSummaryResult,
  FlowStatusResult,
  GraphAffectedResult,
  GraphFindResult,
  GraphStaleness,
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
  WikiEvidenceResult,
  WikiPageResult,
} from "./metaproject-port";

/** Injectable backing factories (default: the real in-process service facades). */
export interface MetaprojectAdapterDeps {
  createGdgraphService: () => GdgraphService;
  createMemoryService: () => MemoryService;
  /**
   * Pure testing-context computation — no disk write (default: the real
   * `computeTestingContext` facade). Injectable for tests. F-003 (flow 234
   * review, MAJOR): `testRelated` uses this PLUS `relatedTestsInContext`
   * below instead of the old `findRelatedTests` wrapper, so the context's
   * `status`/`incompleteReasons` are available to populate the result — and
   * so only ONE tree walk happens per call, not a second hidden one.
   */
  computeTestingContext: (cwd: string) => Promise<TestingContext>;
  /** Relatedness lookup over an already-computed context (default: the real `relatedTestsInContext` facade). Injectable for tests. */
  relatedTestsInContext: (cwd: string, context: TestingContext, target: string) => Promise<string[]>;
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
   * The gdwiki evidence envelope (default: the real `wikiEvidence` facade — the
   * same function `createGdWikiService().evidence` binds, so the agent boundary
   * and MCP answer from ONE implementation, not two). Injectable for tests.
   */
  wikiEvidence: (input: WikiEvidenceInput) => Promise<EvidencePackage>;
  /**
   * Explainable graph seed search (default: load the graph, then the pure
   * `findCandidates` — the same function `keryx gdgraph find` calls, so the
   * outcome CODE an agent reads is the code the command line prints, not a
   * second classification). Injectable for tests, which then build no graph.
   */
  graphFind: (cwd: string, query: string, options: FindOptions) => Promise<FindOutcome>;
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
   * Tri-state graph freshness (default: the real `checkGraphStaleness`). Every
   * graph-backed result carries it so an agent learns what the command line
   * already prints; a git failure reads as `unknown`, never as a confident
   * "the repo moved" claim and never as "fresh". Computed AT MOST ONCE per
   * adapter instance (see `staleness()` below) — it shells out to git, and a
   * per-call check would spend three subprocesses on every graph read.
   * Injectable so tests are deterministic and spawn nothing.
   */
  checkGraphStaleness: (cwd: string) => Promise<StalenessCheck>;
  /**
   * Run ripgrep with a FIXED argv and return its raw streams (default: a real
   * `Bun.spawn`). This is `searchCode`'s backing: before flow 235 T8 the
   * adapter's `searchCode` was a permanent stub, and only the interactive path
   * wrapped it with a subprocess fallback — so code search over MCP was dead
   * for every pattern, including ones with real matches. Injectable so tests
   * neither need ripgrep installed nor spawn anything.
   */
  runRipgrep: (
    cwd: string,
    argv: string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
  computeTestingContext,
  relatedTestsInContext,
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
  wikiEvidence,
  graphFind: async (cwd, query, options) => findCandidates(await loadGraph(cwd), query, options),
  wikiPagesForFile,
  now: () => new Date().toISOString(),
  checkGraphStaleness,
  runRipgrep: async (cwd, argv) => {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  },
  repomapCompute: async (cwd, options) => {
    const [graph, config] = await Promise.all([loadGraph(cwd), loadGdgraphConfig(cwd)]);
    return computeRepomap(graph, config, options);
  },
};

/** Bounded excerpt/output cap so a structured result stays modest. */
const MAX_EXCERPT_BYTES = 400;
const MAX_QUERY_BYTES = 4096;
// F-002 (flow 234 review, BLOCKER) / AFC-25: explicit sentinel for a
// provenance field never captured upstream. Mirrors memory/report.ts's own
// `UNKNOWN` constant (not exported there, so not importable — same literal,
// kept in sync deliberately) so an entry's version/source/link/author/
// confirmedBy reads identically at both the compressed-report boundary and
// this agent-facing one. Never an omitted key, never an empty string.
const UNKNOWN_PROVENANCE = "unknown";

/** Output cap for `searchCode` — the same bound the interactive fallback used. */
const MAX_SEARCH_OUTPUT_BYTES = 20_000;

/**
 * The model-facing diagnosis when ripgrep is missing. Deliberately keeps the
 * "ripgrep (rg) is not installed" prefix that `normalizeSearchResult`
 * (`./builtin/metaproject-tools.ts`) keys its detection on, so the interactive
 * path still recognises the condition after this adapter gained a real backing.
 */
export const SEARCH_CODE_RG_MISSING =
  "ripgrep (rg) is not installed or not on PATH, and search_code needs it. Install it " +
  "(`brew install ripgrep` / `apt install ripgrep`), or use read_file and list_dir to " +
  "inspect files directly instead of retrying search_code.";

/** True when an error is a "binary not found on PATH" spawn failure. */
function isMissingExecutable(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /Executable not found|\bENOENT\b|not found in \$?PATH/i.test(message);
}

/**
 * Confine a caller-supplied search path to the project root. `searchCode` is
 * classified `read` and auto-approved, so an unconfined `path` would be an
 * arbitrary read behind a read-only tool — the identical check the interactive
 * tools already apply (`confineToRoot`, `./builtin/interactive-tools.ts`),
 * re-derived here rather than imported so this pure adapter keeps no dependency
 * on the interactive tool layer.
 */
function confineToProject(cwd: string, candidate: string): string | null {
  const target = resolve(cwd, candidate);
  const rel = relative(cwd, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return target;
}

function boundOutput(raw: string): { output: string; truncated: boolean } {
  return raw.length > MAX_SEARCH_OUTPUT_BYTES
    ? { output: `${raw.slice(0, MAX_SEARCH_OUTPUT_BYTES)}\n…(truncated)`, truncated: true }
    : { output: raw, truncated: false };
}

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

/**
 * Parse `.metaproject/skills/catalog.md`'s `| Skill | Category | Purpose |
 * Entry |` table into `name -> purpose`, for `walkSkillCatalog`'s description
 * fallback (specification.md §3.1). Returns an empty map on any read/parse
 * failure — the fallback degrading to "" is acceptable, a thrown error is not.
 */
async function parseCatalogSummaries(cwd: string): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  let content: string;
  try {
    // catalog.md is a SIBLING of gdskills/ (both live under .metaproject/skills/),
    // not a descendant of it — the owner root here must be the shared parent, or
    // readContainedFile's containment check rejects every read as "outside its
    // owner root" and this fallback silently degrades to "" for every skill.
    const bytes = await readContainedFile(
      join(cwd, ".metaproject", "skills"),
      join(cwd, ".metaproject", "skills", "catalog.md"),
      { maxBytes: 512 * 1024, requireRegularFile: true },
    );
    content = bytes.toString("utf8");
  } catch {
    return summaries;
  }
  const rowPattern = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/;
  for (const line of content.split("\n")) {
    const match = rowPattern.exec(line);
    if (match === null) {
      continue;
    }
    const [, name, , purpose] = match;
    if (name === undefined || purpose === undefined || name === "Skill" || /^-+$/.test(name)) {
      continue; // header or separator row
    }
    summaries.set(name, purpose);
  }
  return summaries;
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
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return entries;
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return entries;
  let categoryDirs: Dirent[];
  try {
    categoryDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const catalogSummaries = await parseCatalogSummaries(cwd);
  for (const categoryDir of categoryDirs) {
    if (!categoryDir.isDirectory() && !categoryDir.isSymbolicLink()) continue;
    const categoryPath = join(root, categoryDir.name);
    const categoryReal = await realpath(categoryPath).catch(() => null);
    const categoryInfo = await stat(categoryPath).catch(() => null);
    if (!categoryReal || !categoryInfo?.isDirectory() || !isPathInside(rootReal, categoryReal)) continue;
    let skillDirs: Dirent[];
    try {
      skillDirs = await readdir(categoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const skillDir of skillDirs) {
      const skillPath = join(categoryPath, skillDir.name);
      const skillReal = await realpath(skillPath).catch(() => null);
      const skillInfo = await stat(skillPath).catch(() => null);
      if (!skillReal || !skillInfo?.isDirectory() || !isPathInside(rootReal, skillReal)) continue;
      const skillMdPath = join(skillPath, "SKILL.md");
      let content: string;
      try {
        const bytes = await readContainedFile(root, skillMdPath, { maxBytes: 512 * 1024, requireRegularFile: true });
        content = bytes.toString("utf8");
      } catch {
        continue; // no SKILL.md in this directory
      }
      const { description, triggers } = parseSkillFrontmatter(content);
      entries.push({
        name: skillDir.name,
        path: relative(cwd, skillMdPath),
        category: categoryDir.name,
        description: description ?? catalogSummaries.get(skillDir.name) ?? "",
        ...(triggers !== undefined ? { triggers } : {}),
      });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** A symbol reference as one display label, unresolved refs marked as the CLI marks them. */
function refLabel(ref: { label: string; resolved: boolean }): string {
  return ref.resolved ? ref.label : `${ref.label} (unresolved)`;
}

export function createMetaprojectAdapter(
  cwd: string,
  overrides: Partial<MetaprojectAdapterDeps> = {},
): MetaprojectPort {
  const deps: MetaprojectAdapterDeps = { ...DEFAULT_DEPS, ...overrides };
  const gdgraph = deps.createGdgraphService();
  const memory = deps.createMemoryService();
  const flow = deps.createFlowService();

  // One freshness check per adapter instance, shared by every graph-backed
  // result below. `checkGraphStaleness` shells out to git; recomputing it per
  // operation would put three subprocesses behind every graph read, and the
  // answer cannot meaningfully change within a single adapter's lifetime.
  let stalenessOnce: Promise<GraphStaleness> | undefined;
  function staleness(): Promise<GraphStaleness> {
    stalenessOnce ??= deps
      .checkGraphStaleness(cwd)
      .then((check) => ({ status: check.status, reasons: check.reasons }))
      // A freshness check that itself failed is `unknown` — the one thing it
      // must never become is `fresh`.
      .catch((cause: unknown) => ({
        status: "unknown" as const,
        reasons: [`the staleness check failed: ${errorMessage(cause)}`],
      }));
    return stalenessOnce;
  }

  return {
    /**
     * Real ripgrep, in-process-owned rather than delegated.
     *
     * The previous implementation returned a permanent "no in-process backing"
     * error. Only the interactive path wrapped the port with a subprocess
     * fallback, so MCP `search_code` — the tool this project's own routing
     * tells agents to use — was dead for every pattern.
     *
     * The argv is FIXED and the pattern is passed after `--`, so a pattern
     * that looks like an option (`--pre=/bin/sh`) can never be re-parsed as
     * one. Exit 1 is ripgrep's "no matches": a legitimate empty answer, NOT an
     * error — conflating the two is the same "failure indistinguishable from
     * empty success" defect from the other direction.
     */
    async searchCode(input): Promise<SearchCodeResult> {
      const echo = {
        pattern: input.pattern,
        ...(input.path !== undefined ? { path: input.path } : {}),
      };
      if (input.pattern.length === 0) {
        return { ...echo, output: "search_code requires a non-empty 'pattern'", isError: true };
      }
      const argv = [
        "rg",
        "--with-filename",
        "--line-number",
        "--column",
        "--no-heading",
        "--",
        input.pattern,
      ];
      if (input.path !== undefined && input.path.length > 0) {
        const confined = confineToProject(cwd, input.path);
        if (confined === null) {
          return {
            ...echo,
            output: `search_code: path escapes the project root: ${input.path}`,
            isError: true,
          };
        }
        argv.push(confined);
      }
      let run: { stdout: string; stderr: string; exitCode: number };
      try {
        run = await deps.runRipgrep(cwd, argv);
      } catch (cause) {
        return {
          ...echo,
          output: isMissingExecutable(cause) ? SEARCH_CODE_RG_MISSING : errorMessage(cause),
          isError: true,
        };
      }
      if (run.exitCode === 1 && run.stdout.trim().length === 0) {
        return {
          ...echo,
          output: `No matches for ${JSON.stringify(input.pattern)}${input.path !== undefined ? ` under ${input.path}` : ""}. The search ran and completed — this is a no-match, not a failure.`,
          isError: false,
        };
      }
      if (run.exitCode > 1) {
        const detail = run.stderr.trim().length > 0 ? run.stderr.trim() : run.stdout.trim();
        return {
          ...echo,
          output: /rg|ripgrep/i.test(detail) && isMissingExecutable(detail)
            ? SEARCH_CODE_RG_MISSING
            : `search_code failed (rg exit ${run.exitCode}): ${detail || "(no diagnostic)"}`,
          isError: true,
        };
      }
      const bounded = boundOutput(run.stdout.trimEnd());
      return {
        ...echo,
        output: bounded.output,
        isError: false,
        ...(bounded.truncated ? { truncated: true } : {}),
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
        return {
          target: result.target,
          depth: result.depth,
          ranked,
          affected,
          // The other half of the blast radius the CLI has always printed.
          dependencies: [...result.dependencies].sort(),
          staleness: await staleness(),
        };
      } catch (cause) {
        return {
          target: input.target,
          affected: [],
          staleness: await staleness(),
          error: errorMessage(cause),
        };
      }
    },

    async graphQuery(input): Promise<GraphQueryResult> {
      try {
        const result = await gdgraph.query(cwd, input.query);
        return input.query === "orphans"
          ? { query: "orphans", orphans: result as string[], staleness: await staleness() }
          : { query: "cycles", cycles: result as string[][], staleness: await staleness() };
      } catch (cause) {
        return { query: input.query, staleness: await staleness(), error: errorMessage(cause) };
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
                  // F-002 (flow 234 review, BLOCKER): carried through to the
                  // agent-facing boundary, bounded with the SAME clipping
                  // already applied to recalled text above — never a raw,
                  // unbounded field. Absent upstream -> the explicit
                  // "unknown" sentinel (never a dropped key); `caveat` alone
                  // stays nullable, distinct from "not captured".
                  version: clipAutomaticRecallText(scored.entry.version ?? UNKNOWN_PROVENANCE, MAX_EXCERPT_BYTES),
                  provenance: {
                    source: clipAutomaticRecallText(scored.entry.provenance.source ?? UNKNOWN_PROVENANCE, MAX_EXCERPT_BYTES),
                    link: clipAutomaticRecallText(scored.entry.provenance.link ?? UNKNOWN_PROVENANCE, MAX_EXCERPT_BYTES),
                  },
                  author: clipAutomaticRecallText(scored.entry.author ?? UNKNOWN_PROVENANCE, MAX_EXCERPT_BYTES),
                  confirmedBy: clipAutomaticRecallText(scored.entry.confirmedBy ?? UNKNOWN_PROVENANCE, MAX_EXCERPT_BYTES),
                  caveat: scored.entry.caveat ? clipAutomaticRecallText(scored.entry.caveat, MAX_EXCERPT_BYTES) : null,
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

    /**
     * LWG: the last freshness report, projected for a caller deciding whether to
     * trust a page. Reads ONE json file — never recomputes, because a traversal
     * behind a call the caller thinks is a read is a cost they did not agree to.
     *
     * A missing or damaged report yields a status and a reason, never an empty
     * `pages` list that reads as a clean wiki.
     */
    async wikiFreshness(input: { page?: string }) {
      const metric = await readWikiFreshnessMetric(cwd);
      if (metric.status !== "measured" && metric.status !== "stale-evidence") {
        return {
          status: metric.status,
          ...(metric.reason ? { reason: metric.reason } : {}),
          pages: [],
          limitations: [],
        };
      }
      try {
        const raw = await readFile(freshnessReportPath(cwd), "utf8");
        const report = JSON.parse(raw) as {
          generatedAt?: string;
          totals?: Record<string, number>;
          pages?: Array<{ path: string; category: string; confidence: string; commitsBehind: number; verifiedAt: string | null }>;
          limitations?: Array<{ code: string; detail: string }>;
        };
        const pages = (report.pages ?? []).filter(
          (entry) => input.page === undefined || entry.path === input.page,
        );
        return {
          status: metric.status,
          ...(metric.reason ? { reason: metric.reason } : {}),
          ...(report.generatedAt ? { generatedAt: report.generatedAt } : {}),
          ...(report.totals ? { totals: report.totals } : {}),
          pages,
          limitations: report.limitations ?? [],
        };
      } catch (cause) {
        return {
          status: "unreadable-report",
          reason: errorMessage(cause),
          pages: [],
          limitations: [],
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
          error: "wiki path is outside its root",
        };
      }
      try {
        const content = (await readContainedFile(join(cwd, ".metaproject", "wiki"), target, {
          maxBytes: 8 * 1024 * 1024,
          requireRegularFile: true,
        })).toString("utf8");
        return { path: input.path, content, isError: false };
      } catch {
        return { path: input.path, content: "", isError: true, error: "wiki page is unavailable" };
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
      let hasWikiIndex: boolean;
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
        staleness: await staleness(),
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
          staleness: await staleness(),
        };
      } catch (cause) {
        return {
          from: input.from,
          to: input.to,
          nodes: [],
          staleness: await staleness(),
          error: errorMessage(cause),
        };
      }
    },

    async testRelated(input): Promise<TestRelatedResult> {
      try {
        // F-003 (flow 234 review, MAJOR) / AC2: the pure computation plus the
        // relatedness lookup over it (both already exported by
        // testing/service.ts) instead of the old `findRelatedTests` wrapper —
        // that wrapper computed the SAME context internally but only
        // returned `tests`, discarding `status`/`incompleteReasons` and,
        // when a caller separately needed the context, forcing a second
        // tree walk. One walk, and the incomplete status now reaches this
        // boundary instead of silently reading as a clean empty result.
        const context = await deps.computeTestingContext(cwd);
        const tests = await deps.relatedTestsInContext(cwd, context, input.file);
        return {
          file: input.file,
          tests: [...tests].sort(),
          context: { status: context.status, incompleteReasons: context.incompleteReasons },
        };
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
          // The two real counters. `regressions` alone is the DEPRECATED alias
          // and used to be all this boundary carried.
          decliningScopes: status.decliningScopes,
          regressedScopes: status.regressedScopes,
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
            slug: f.slug,
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
          // The marker travels with the label, because the port declares these
          // as DISPLAY LABELS and an unresolved callee displayed identically to
          // a resolved one is a claim the graph never made. `CYRILLIC_RE.test`
          // is a call to a RegExp method the index cannot attribute to any
          // project symbol; dropping the flag here made it read, at the agent
          // boundary only, as a resolved call to a project function named
          // `test`. The CLI has always rendered it this way — this is the same
          // rendering, not a second spelling of it.
          callers: result.callers.map(refLabel),
          callees: result.callees.map(refLabel),
          staleness: await staleness(),
        };
      } catch (cause) {
        return {
          name: input.name,
          definitions: [],
          callers: [],
          callees: [],
          staleness: await staleness(),
          error: errorMessage(cause),
        };
      }
    },

    async repomap(input): Promise<RepomapResult> {
      const seed = input.seed?.filter((entry) => typeof entry === "string" && entry.length > 0);
      try {
        // Read-only: compute the map in-process (never writeRepomap → no artifact).
        const result = await deps.repomapCompute(cwd, {
          ...(input.budget !== undefined ? { budget: input.budget } : {}),
          // The seed is the whole point for a change intent; it used to be
          // unreachable because the port's input had no such field at all.
          ...(seed !== undefined && seed.length > 0 ? { seed } : {}),
        });
        return {
          budget: input.budget ?? result.tokens,
          files: result.entries.map((entry) => ({
            path: entry.path,
            score: entry.score,
            symbols: entry.symbols,
            // Which entry the budget protected, not just which scored highest.
            required: entry.required,
          })),
          tokens: result.tokens,
          omitted: result.omitted,
          ...(seed !== undefined && seed.length > 0 ? { seed } : {}),
          // AFC-12's honest markers, all four of them. Without these a dropped
          // required seed and a trimmed tail were the same `ok` result with a
          // bigger `omitted` count.
          omittedOptional: result.omittedOptional,
          partial: result.partial,
          ...(result.overflow !== undefined ? { overflow: result.overflow } : {}),
          staleness: await staleness(),
        };
      } catch (cause) {
        return {
          budget: input.budget ?? 0,
          files: [],
          tokens: 0,
          omitted: 0,
          staleness: await staleness(),
          error: errorMessage(cause),
        };
      }
    },

    async wikiAsk(input): Promise<WikiAskResult> {
      try {
        const result = await deps.wikiAsk({
          cwd,
          question: input.question,
          ...(input.k !== undefined ? { k: input.k } : {}),
        });
        return {
          question: result.question,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          // Pass through what `wikiAsk` computed. The previous five-field
          // re-map silently dropped the retrieval status, the section address,
          // the match reason and — worst — the HISTORICAL lifecycle marks the
          // CLI renders, so an agent could not tell current guidance from
          // superseded guidance.
          citations: result.citations.map((citation) => ({
            path: citation.path,
            title: citation.title,
            excerpt: citation.excerpt,
            score: citation.score,
            source: citation.source,
            ...(citation.matched !== undefined ? { matched: citation.matched } : {}),
            ...(citation.sectionId !== undefined ? { sectionId: citation.sectionId } : {}),
            ...(citation.sectionRef !== undefined ? { sectionRef: citation.sectionRef } : {}),
            ...(citation.sectionTitle !== undefined ? { sectionTitle: citation.sectionTitle } : {}),
            ...(citation.sectionStability !== undefined
              ? { sectionStability: citation.sectionStability }
              : {}),
            ...(citation.contentClass !== undefined ? { contentClass: citation.contentClass } : {}),
            ...(citation.domain !== undefined ? { domain: citation.domain } : {}),
            ...(citation.startLine !== undefined ? { startLine: citation.startLine } : {}),
            ...(citation.endLine !== undefined ? { endLine: citation.endLine } : {}),
            ...(citation.historical !== undefined ? { historical: citation.historical } : {}),
            ...(citation.lifecycleState !== undefined
              ? { lifecycleState: citation.lifecycleState }
              : {}),
            ...(citation.lifecycleReasons !== undefined
              ? { lifecycleReasons: citation.lifecycleReasons }
              : {}),
          })),
          answer: result.answerMarkdown,
        };
      } catch (cause) {
        return { question: input.question, citations: [], answer: "", error: errorMessage(cause) };
      }
    },

    /**
     * `keryx gdgraph find`, at the boundary an agent actually reads.
     *
     * The outcome is passed through WHOLE — code, reason, nextActions,
     * per-candidate `matched`/`discriminating`, and the ubiquitous terms that
     * explain an `insufficient-evidence`. `normalizeRetrievalCode` is applied
     * here rather than trusted from the type: `findCandidates` is the current
     * producer, but this is the transport hop the specification names
     * ("Нормализатор транспорта сохраняет коды"), and a code that is not in the
     * shared vocabulary must collapse to `capability-unavailable` instead of
     * being forwarded as a private spelling the next hop cannot branch on.
     *
     * A failure to LOAD the graph is `index-incomplete`, not `no-match`: "the
     * index could not answer" and "the corpus contains nothing" are the two
     * situations this whole operation exists to keep apart, and an unreadable
     * graph has no standing to make a claim about the corpus.
     */
    async graphFind(input): Promise<GraphFindResult> {
      const options: FindOptions = {
        ...(input.fileLimit !== undefined ? { fileLimit: input.fileLimit } : {}),
        ...(input.symbolLimit !== undefined ? { symbolLimit: input.symbolLimit } : {}),
      };
      try {
        const outcome = await deps.graphFind(cwd, input.query, options);
        return {
          query: input.query,
          code: normalizeRetrievalCode(outcome.code),
          reason: outcome.reason,
          nextActions: [...outcome.nextActions],
          files: outcome.files.map((file) => ({
            path: file.path,
            score: file.score,
            matched: [...file.matched],
            discriminating: [...file.discriminating],
            dependents: file.dependents,
            reason: file.reason,
          })),
          symbols: outcome.symbols.map((symbol) => ({
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            path: symbol.path,
            startLine: symbol.startLine,
            score: symbol.score,
            matched: [...symbol.matched],
            discriminating: [...symbol.discriminating],
            reason: symbol.reason,
          })),
          queryTerms: [...outcome.queryTerms],
          ubiquitousTerms: [...outcome.ubiquitousTerms],
          staleness: await staleness(),
        };
      } catch (cause) {
        return {
          query: input.query,
          code: "index-incomplete",
          reason:
            `the code graph could not be read here (${errorMessage(cause)}). This says nothing ` +
            "about whether the code exists — run `keryx gdgraph build` and retry.",
          nextActions: [...RETRIEVAL_NEXT_ACTIONS["index-incomplete"]],
          files: [],
          symbols: [],
          queryTerms: [],
          ubiquitousTerms: [],
          staleness: await staleness(),
          error: errorMessage(cause),
        };
      }
    },

    /**
     * The wiki evidence envelope, carried WHOLE.
     *
     * There is no field re-map here on purpose. The measured defect this closes
     * is a boundary that re-listed an owner's fields by hand and dropped
     * thirteen of them; the structural answer is that the envelope crosses as
     * one value, so no field CAN be dropped in transit. Rendering is a separate
     * concern and is guarded separately (see `formatWikiEvidence`,
     * `./metaproject-operations.ts`).
     */
    async wikiEvidence(input): Promise<WikiEvidenceResult> {
      try {
        const envelope = await deps.wikiEvidence({
          cwd,
          question: input.question,
          ...(input.k !== undefined ? { k: input.k } : {}),
          ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
          ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
        });
        return { question: input.question, envelope };
      } catch (cause) {
        // No empty envelope on failure: a zero-item `no-match` is a CLAIM about
        // the wiki, and a call that never completed has no standing to make it.
        return { question: input.question, error: errorMessage(cause) };
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
      // walkSkillCatalog is internally defensive (every fs op is try/catched;
      // a missing root or unreadable directory yields fewer entries, never a
      // throw) — no outer try/catch needed. Unlike most other MetaprojectPort
      // results, skills-catalog-result.schema.json declares no `error` field
      // (additionalProperties: false), so there is nowhere to put one anyway.
      const skills = await walkSkillCatalog(cwd);
      return { skills, generatedAt: deps.now() };
    },

    async loadSkill(input): Promise<SkillLoadResult> {
      const catalog = await walkSkillCatalog(cwd);
      const byName = catalog.find((entry) => entry.name === input.name);
      if (byName !== undefined) {
        try {
          const content = (await readContainedFile(join(cwd, ".metaproject", "skills", "gdskills"), join(cwd, byName.path), {
            maxBytes: 512 * 1024,
            requireRegularFile: true,
          })).toString("utf8");
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
        const content = (await readContainedFile(join(cwd, ".metaproject", "skills", "gdskills"), confined, {
          maxBytes: 512 * 1024,
          requireRegularFile: true,
        })).toString("utf8");
        return { name: input.name, path: byPath.path, content, found: true };
      } catch {
        return { name: input.name, path: "", content: "", found: false };
      }
    },
  };
}
