// Typed, in-process MetaprojectPort (flow 037 / MP-1).
//
// A content-returning, DETERMINISTIC read port over keryx's metaproject layer:
// code search, graph blast-radius + queries, project memory, wiki pages, and a
// context summary. It is a PURE type/interface module — no imports with side
// effects, no runtime logic — so it can be depended on from anywhere (the harness
// tool factory, the agent, MCP) without pulling in a backing implementation.
//
// Result shapes are aligned with the docpack schemas under
// docs/requirements/keryx-metaproject-native/schemas/ (graph-affected-result and
// memory-search-result in particular). A reference implementation lives in
// metaproject-adapter.ts (`createMetaprojectAdapter`); consumers depend only on
// the interface here.
//
// The two imports below are TYPE-ONLY and therefore erased: this module still
// emits nothing at runtime. They exist because the alternative — re-spelling a
// vocabulary and an envelope by hand at the boundary — is the exact defect this
// programme keeps measuring. `WikiAskCitation` below was hand-copied from
// `src/wiki/types.ts` and a five-field re-map silently dropped thirteen of its
// fields at this boundary; a hand-copied `EvidenceItem` would do it again, and a
// hand-copied retrieval-code union would let a transport fork the vocabulary
// that `src/lib/retrieval-codes.ts` exists to keep single.

import type { RetrievalCode } from "../../lib/retrieval-codes";
import type { EvidencePackage } from "../../wiki/evidence";

/**
 * Tri-state graph freshness, carried to the agent-facing boundary.
 *
 * Mirrors `StalenessCheck` (`src/gdgraph/staleness.ts`) field for field rather
 * than inventing a second vocabulary. `unknown` is the load-bearing member: a
 * git failure means staleness could not be determined, which is NOT evidence
 * the repo moved. The command line has routed onto this tri-state since flow
 * 237; before flow 235 T8 no graph-backed tool result carried freshness at
 * all — not the tri-state, not even the old boolean — so an agent asking the
 * same question through a tool learned nothing.
 */
export interface GraphStaleness {
  status: "fresh" | "stale" | "unknown";
  /** One per trigger/failure that fired. Empty only when `status` is `fresh`. */
  reasons: string[];
}

/** One transitive dependent (blast-radius) node — graph-affected-result.schema.json. */
export interface GraphAffectedNode {
  /** Node id (file path or symbol id). */
  id: string;
  /** File path when the node is a file. */
  path?: string;
  /** Distance in dependency hops from the target (>= 1). */
  hop: number;
  /** Incoming edge count (used for ranking). */
  fanIn?: number;
}

/** Structured result of `graphAffected` — graph-affected-result.schema.json. */
export interface GraphAffectedResult {
  /** The file or symbol whose dependents were computed. */
  target: string;
  /** Max hop depth traversed. */
  depth?: number;
  /** Whether entries are ranked (hop asc, then fanIn desc, then path asc). */
  ranked?: boolean;
  /** Dependent nodes. */
  affected: GraphAffectedNode[];
  /**
   * The other half of the blast radius: what the target itself imports.
   * `AffectedResult.dependencies` has always been computed and both the CLI
   * (`keryx gdgraph affected`) and the bespoke MCP `gdgraph.affected` tool
   * print it; this boundary used to drop it.
   */
  dependencies?: string[];
  /** True when the result was capped by an output bound. */
  truncated?: boolean;
  /** Freshness of the graph this answer came from (never recomputed here). */
  staleness?: GraphStaleness;
  /** Set when the backing service failed — the result is structured-empty, not thrown. */
  error?: string;
}

/** Structured result of `graphQuery` (cycles or orphans). */
export interface GraphQueryResult {
  /** Which query was run. */
  query: "cycles" | "orphans";
  /** Orphan file paths (present when `query === "orphans"`). */
  orphans?: string[];
  /** Cycles as ordered path lists (present when `query === "cycles"`). */
  cycles?: string[][];
  /** Freshness of the graph this answer came from (never recomputed here). */
  staleness?: GraphStaleness;
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** One ranked project-memory hit — memory-search-result.schema.json. */
export interface MemorySearchHit {
  /** Memory entry file path under .metaproject/memory/. */
  path: string;
  title: string;
  /** Memory type (lesson, decision, constraint, known-mistake, …). */
  type?: string;
  /** Entry status. */
  status?: string;
  /** Deterministic rank score (higher = more relevant). */
  score: number;
  /** Bounded snippet of the entry body. */
  excerpt?: string;
  // --- F-002 (flow 234 review, BLOCKER) / AFC-25 / AC6: knowledge provenance
  // carried into the hit, mirroring the compressed-report shape memory/report.ts
  // already produces (renderMemorySearchReport) rather than a second one. A
  // council-confirmed, sourced, versioned decision must not arrive
  // byte-identical to a completely unsourced entry at THIS boundary — the one
  // an agent actually reads (both the interactive tool and the MCP tool
  // project through the same adapter). Optional at the TYPE level only so a
  // hit literal built before this fix (e.g. an out-of-scope test fixture)
  // still type-checks; `createMetaprojectAdapter().memorySearch` always
  // populates every field below, falling back to the literal "unknown"
  // sentinel exactly like memory/report.ts does — never an omitted key.
  /** Exact source fragment/version. Absent upstream -> "unknown". */
  version?: string;
  /** Exact source fragment + link. Absent upstream -> "unknown" for each. */
  provenance?: { source: string; link: string };
  /** Who wrote/proposed the claim. Absent upstream -> "unknown". */
  author?: string;
  /** The confirming participant / acceptance basis. Absent upstream -> "unknown". */
  confirmedBy?: string;
  /** A deferral/qualification caveat. `null` -> not captured upstream — distinct from an omitted field. */
  caveat?: string | null;
}

/** Applied memory-search filters (all optional) — memory-search-result.schema.json. */
export interface MemorySearchFilters {
  module?: string;
  status?: string;
  class?: string;
}

/** Structured result of `memorySearch` — memory-search-result.schema.json. */
export interface MemorySearchResult {
  /** The search query. */
  query: string;
  /** Applied filters (all optional). */
  filters?: MemorySearchFilters;
  /** Ranked memory entries. */
  hits: MemorySearchHit[];
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** Structured result of `searchCode`. */
export interface SearchCodeResult {
  /** The search pattern. */
  pattern: string;
  /** The path scope (relative to the project root), when provided. */
  path?: string;
  /** Bounded, rendered search output (compact ripgrep text). */
  output: string;
  /** True when the search itself failed. */
  isError: boolean;
  /** True when the result was capped by an output bound. */
  truncated?: boolean;
}

/** Structured result of `readWiki`. */
export interface WikiPageResult {
  /** The requested wiki path (relative to .metaproject/wiki/). */
  path: string;
  /** The page content, or "" when unavailable. */
  content: string;
  /** True when the path escaped the wiki root or the file could not be read. */
  isError: boolean;
  /** Set with a human-readable reason when `isError` is true. */
  error?: string;
}

/** Structured result of `graphPath` — the connection between two graph endpoints. */
export interface GraphPathResult {
  /** The requested `from` endpoint token (file path or symbol name). */
  from: string;
  /** The requested `to` endpoint token (file path or symbol name). */
  to: string;
  /**
   * Ordered node-id chain from a `from` endpoint to a `to` endpoint, or `[]`
   * when the endpoints are unconnected (or either could not be resolved).
   */
  nodes: string[];
  /** True when either endpoint resolved to no graph node. */
  unresolved?: boolean;
  /** Freshness of the graph this answer came from (never recomputed here). */
  staleness?: GraphStaleness;
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** Structured result of `testRelated` — the tests related to a file. */
export interface TestRelatedResult {
  /** The file whose related tests were computed (relative to the project root). */
  file: string;
  /** Related test file paths (naming + directory heuristic), sorted. */
  tests: string[];
  // F-003 (flow 234 review, MAJOR) / AC2: the testing-context refresh status
  // behind this answer, mirroring TestingReport.context. An inability to fully
  // walk the tree (e.g. a permission-denied subdirectory) must read as
  // `incomplete`, never as an indistinguishable "there are no related tests"
  // empty success. Optional only because a `MetaprojectPort` implementation
  // predating this field would not set it; the reference adapter always does.
  context?: {
    status: "complete" | "incomplete";
    incompleteReasons: string[];
  };
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** Structured result of `healthStatus` — the latest code-health snapshot. */
export interface HealthStatusResult {
  /** Whether the health capability is enabled (health.config.json present). */
  enabled: boolean;
  /** ISO timestamp of the last health run, or null when none exists. */
  lastRunAt: string | null;
  /** Latest gate status (pass/warn/incomplete/fail), or null when no report exists. */
  gate: "pass" | "warn" | "incomplete" | "fail" | null;
  /** Per-source availability status from the latest report. */
  sources: Array<{ source: string; status: string }>;
  /** Latest project-level health score, or null when unavailable. */
  projectScore: number | null;
  /**
   * DEPRECATED compatibility alias for `decliningScopes` (see
   * `HealthStatusResult`, `src/health/types.ts`). Until flow 235 T8 this was
   * the ONLY count that reached this boundary, so an agent read the deprecated
   * alias while `health.status` and `keryx health status` both showed the two
   * real counters below.
   */
  regressions: number;
  /** Scopes whose score is declining. */
  decliningScopes?: number;
  /** Scopes with a confirmed regression. */
  regressedScopes?: number;
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** One resolved symbol definition — graphSymbol result. */
export interface SymbolDefinition {
  /** Stable symbol id ("<path>#<Container>.<name>"). */
  id: string;
  /** Symbol name. */
  name: string;
  /** Symbol kind (function, class, method, interface). */
  kind: string;
  /** Owning file path. */
  path: string;
  /** 1-based start line. */
  startLine: number;
  /** Enclosing class/namespace, or null. */
  container: string | null;
}

/** Structured result of `graphSymbol` — where a symbol is defined + who calls it / what it calls. */
export interface GraphSymbolResult {
  /** The requested symbol name/token. */
  name: string;
  /** Resolved definitions of the symbol (empty when unresolved or no symbol layer). */
  definitions: SymbolDefinition[];
  /** Display labels of the symbols that call the resolved symbol(s), sorted. */
  callers: string[];
  /** Display labels of the symbols the resolved symbol(s) call, sorted. */
  callees: string[];
  /** Freshness of the graph this answer came from (never recomputed here). */
  staleness?: GraphStaleness;
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** One flow's summary — status/progress row from `keryx flow list`. */
export interface FlowSummaryResult {
  /** Stable flow id. */
  id: string;
  /** The flow's slug — half of its directory name, and how humans name it. */
  slug?: string;
  /** Current lifecycle status. */
  status: string;
  /** Flow title. */
  title: string;
  /** Completed task count. */
  tasksDone: number;
  /** Total task count. */
  tasksTotal: number;
  /** Flow directory (relative to `.metaproject/flows`). */
  dir: string;
}

/** Structured result of `flowStatus` — Task Manager flows and their progress. */
export interface FlowStatusResult {
  /** Matching flows (all flows, or the single flow named by `id`). */
  flows: FlowSummaryResult[];
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** One ranked repomap entry — the file plus its top rendered symbols. */
export interface RepomapFile {
  /** File path (graph node id). */
  path: string;
  /** Deterministic PageRank score. */
  score: number;
  /** Rendered top symbols/signatures for the file. */
  symbols: string[];
  /**
   * AFC-12: a matched seed, or a direct consumer/test of one — protected from
   * budget/rank eviction rather than being another ranked candidate. Mirrors
   * `RepomapEntry.required` (`src/gdgraph/repomap.ts`).
   */
  required?: boolean;
}

/** Structured result of `repomap` — a ranked, token-budgeted repo map. */
export interface RepomapResult {
  /** Token budget applied to the map. */
  budget: number;
  /** Ranked, budget-fitted file entries. */
  files: RepomapFile[];
  /** Estimated token count of the rendered map. */
  tokens: number;
  /** Number of ranked entries dropped to fit the budget. */
  omitted: number;
  /** The seeds the caller asked to protect, echoed back. */
  seed?: string[];
  /** AFC-12: paths of OPTIONAL entries dropped for budget — named, not just counted. */
  omittedOptional?: string[];
  /** AFC-12: true when an optional-entry loss occurred. */
  partial?: boolean;
  /**
   * AFC-12: present only when the REQUIRED set does not fit as a whole. When
   * set, `files` is empty: a truncated required set is never an ordinary
   * success. Same vocabulary as `ContextOverflow` (`src/ctx/assembly.ts`).
   */
  overflow?: { code: "context_overflow"; requiredId: string };
  /** Freshness of the graph this map came from (never recomputed here). */
  staleness?: GraphStaleness;
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** One ranked file candidate from `graphFind` — mirrors `FindResult` (`src/gdgraph/find.ts`). */
export interface GraphFindFile {
  path: string;
  /** A RANKING score. Never a probability, never a percentage (specification.md §3). */
  score: number;
  /** Which query terms hit this path. */
  matched: string[];
  /** The subset of `matched` that actually narrows the corpus — the evidence. */
  discriminating: string[];
  /** Fan-in (dependents). A TIE-BREAK, never evidence that this answers the question. */
  dependents: number;
  /** Why this candidate is here, in one line. */
  reason: string;
}

/** One ranked symbol candidate from `graphFind` — mirrors `SymbolFindResult`. */
export interface GraphFindSymbol {
  id: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  score: number;
  matched: string[];
  discriminating: string[];
  reason: string;
}

/**
 * Structured result of `graphFind` — the explainable seed-file search.
 *
 * `code` is the load-bearing field and the reason this result type exists at
 * all. `findCandidates` (`src/gdgraph/find.ts`) already distinguishes a genuine
 * no-match from an unbuilt index from a query whose every term is corpus-wide,
 * and `keryx gdgraph find` already prints the distinction — but the whole
 * classification was CLI-only: no agent or MCP tool could ask this question,
 * so an agent's only route to the same answer was `search_code`, which cannot
 * tell those four situations apart.
 *
 * The `RetrievalCode` type is imported rather than re-spelled as a string
 * union: `src/lib/retrieval-codes.ts` exists precisely so a transport cannot
 * fork the vocabulary, and `normalizeRetrievalCode` is what enforces it at the
 * hop (see `formatFind`, `./metaproject-operations.ts`). Type-only, so this
 * module stays runtime-free.
 */
export interface GraphFindResult {
  /** The query, echoed back. */
  query: string;
  /** The AC5 outcome code, from the one shared closed vocabulary. */
  code: RetrievalCode;
  /** Safe prose saying what happened. Never a stack, never a secret. */
  reason: string;
  /** At most `MAX_NEXT_ACTIONS` bounded continuations — never a full layer tour. */
  nextActions: string[];
  /** Ranked file candidates (may be empty even when `code` is `ok`-adjacent). */
  files: GraphFindFile[];
  /** Ranked symbol candidates. */
  symbols: GraphFindSymbol[];
  /** The content terms the query reduced to, after stop-word removal. */
  queryTerms: string[];
  /** The query terms that appear across this corpus and therefore discriminate nothing. */
  ubiquitousTerms: string[];
  /** Freshness of the graph this answer came from (never recomputed here). */
  staleness?: GraphStaleness;
  /** Set when the backing service failed — structured, not thrown. */
  error?: string;
}

/** One wiki/memory citation backing a wiki answer — wikiAsk result. */
export interface WikiAskCitation {
  /** Citation path (wiki/<page> or memory/<entry>). */
  path: string;
  title: string;
  /** Bounded excerpt of the cited page/entry. */
  excerpt: string;
  /** Deterministic lexical relevance score (a RANKING score, never a probability). */
  score: number;
  /** Which corpus the citation came from. */
  source: "wiki" | "memory";

  // --- flow 235 T8: everything below is computed by `wikiAsk` (src/wiki/ask.ts)
  // and rendered by the CLI, and used to be dropped by the adapter's five-field
  // re-map. Optional at the TYPE level only so a hand-written port stub still
  // compiles; the reference adapter passes through whatever the facade set.
  /** Which query terms hit — the reason, kept rather than computed and dropped. */
  matched?: string[];
  /** Stable section id (AFC-W01), for a wiki citation that has one. */
  sectionId?: string;
  /** The resolvable section address, e.g. `wiki:<page>#<sectionId>`. */
  sectionRef?: string;
  /** `Page › Section` — what distinguishes two identically titled sections. */
  sectionTitle?: string;
  /** How far `sectionRef` can be trusted across an edit. */
  sectionStability?: "stable" | "version-bound";
  /** Whether the cited body is real content or scaffolding/generated reference. */
  contentClass?: "substantive" | "scaffold" | "reference";
  /** The wiki page type that owns the section. */
  domain?: string;
  startLine?: number;
  endLine?: number;
  /**
   * Set when this citation is NOT current. The CLI renders a
   * `**[HISTORICAL — not current: …]**` marker from these three; dropping them
   * here handed an agent stale guidance with no way to tell.
   */
  historical?: boolean;
  /** The lifecycle state verbatim (`LifecycleState`), never re-derived here. */
  lifecycleState?: string;
  lifecycleReasons?: string[];
}

/**
 * A retrieval OUTCOME, not a shape the caller must infer from an empty array
 * (`WikiAskStatus`, `src/wiki/types.ts`). A zero-information query, an unbuilt
 * index and a genuine no-match are different answers.
 */
export type WikiAskStatus = "ok" | "no-match" | "insufficient-evidence";

/** Structured result of `wikiAsk` — deterministic lexical Q&A over wiki + memory. */
export interface WikiAskResult {
  /** The question asked. */
  question: string;
  /**
   * `ok` only when the citations are evidence for the question asked.
   * Optional because a port stub may not set it; `undefined` means "a stub,
   * not a real retrieval" — never "ok".
   */
  status?: WikiAskStatus;
  /** Why, when `status` is not `ok`. Bounded and specific. */
  reason?: string;
  /** Ranked citations (empty when nothing matched). */
  citations: WikiAskCitation[];
  /** Assembled Markdown answer built deterministically from the citations. */
  answer: string;
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/**
 * Structured result of `wikiEvidence` — the AFC-W04 evidence envelope.
 *
 * `envelope` is `EvidencePackage` VERBATIM, not a re-mapped subset. That is the
 * whole design of this result type: the measured defect at this boundary was a
 * hand-written re-map that dropped thirteen fields from a wiki answer, and the
 * only structural fix is to make dropping a field impossible rather than to
 * write a longer re-map and hope. A field added to the envelope arrives here
 * with no edit to this file; a field renamed there fails to compile in the
 * renderer that projects it.
 *
 * `envelope` is optional ONLY for the `error` branch — a backing failure is a
 * structured result, never a throw, and never an empty envelope that would read
 * as a genuine `no-match`.
 */
export interface WikiEvidenceResult {
  /** The question asked, echoed back. */
  question: string;
  /** The evidence envelope, whole. Absent only when `error` is set. */
  envelope?: EvidencePackage;
  /** Set when the backing service failed — structured, not thrown. */
  error?: string;
}

/** Structured result of `wikiBacklinks` — wiki pages that reference a repo file. */
export interface WikiBacklinksResult {
  /** The repo-relative file whose referencing wiki pages were computed. */
  file: string;
  /** Repo-relative wiki page paths that reference `file`, sorted. */
  backlinks: string[];
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/**
 * One discovered skill under `.metaproject/skills/gdskills/` —
 * skills-catalog-result.schema.json (docs/requirements/keryx-skills-runtime-tools).
 */
export interface SkillsCatalogEntry {
  /** Skill name (its containing directory's basename), e.g. "flow-orchestrator". */
  name: string;
  /** Project-relative path to the skill's SKILL.md. */
  path: string;
  /** Category — the directory one level under `gdskills/` (core, orchestration, review, quality, planning, platform, shared). */
  category: string;
  /** From SKILL.md frontmatter `description`; "" when absent/unparsable. */
  description: string;
  /** From SKILL.md frontmatter `triggers`, when present. */
  triggers?: string[];
}

/** Structured result of `skillsCatalog` — skills-catalog-result.schema.json. */
export interface SkillsCatalogResult {
  /** Every skill discovered under `.metaproject/skills/gdskills/`. */
  skills: SkillsCatalogEntry[];
  /** ISO timestamp of the live read — never a cache-write timestamp. */
  generatedAt: string;
}

/** Structured result of `skill_load` — skill-load-result.schema.json. */
export interface SkillLoadResult {
  /** The requested skill name or path, echoed back. */
  name: string;
  /** Resolved project-relative path to the SKILL.md that was read; "" when not found. */
  path: string;
  /** The SKILL.md body verbatim, including frontmatter; "" when not found. */
  content: string;
  /** False when name/path did not resolve to a known skill — never a thrown error. */
  found: boolean;
}

/** Structured result of `describeContext` — a lightweight project summary. */
export interface ContextSummaryResult {
  /** The project root the port is bound to. */
  root: string;
  /** Graph node count (0 when the graph is unavailable). */
  graphNodes: number;
  /** Graph edge count (0 when the graph is unavailable). */
  graphEdges: number;
  /** Whether a wiki index (.metaproject/wiki/index.md) is present. */
  hasWikiIndex: boolean;
  /** Freshness of the graph these counts came from (never recomputed here). */
  staleness?: GraphStaleness;
  /** Set when the summary could not be fully computed (partial/degraded). */
  error?: string;
}

/**
 * A content-returning, deterministic read port over the metaproject layer. Every
 * method returns a structured result and NEVER throws — a backing failure becomes
 * a structured empty/error result (see each result type's `error`/`isError`).
 */
/**
 * Structured result of `wikiFreshness` — the LAST freshness report, projected
 * for a caller deciding whether to trust a page.
 *
 * `limitations` is not decoration. An empty `pages` list with a non-empty
 * `limitations` means the check could not run; treating that as a fresh wiki
 * is the failure this whole surface exists to prevent.
 */
export interface WikiFreshnessResult {
  /** `measured` | `no-report` | `unreadable-report` | `stale-evidence`. */
  status: string;
  /** Why there is no number. Absent when `status` is `measured`. */
  reason?: string;
  generatedAt?: string;
  totals?: Record<string, number>;
  pages: Array<{
    path: string;
    category: string;
    confidence: string;
    commitsBehind: number;
    verifiedAt: string | null;
  }>;
  limitations: Array<{ code: string; detail: string }>;
}

export interface MetaprojectPort {
  searchCode(input: { pattern: string; path?: string }): Promise<SearchCodeResult>;
  /**
   * Freshness of the wiki, from the LAST report. Never recomputes — that
   * would start a graph traversal behind a call the caller thinks is a read.
   *
   * OPTIONAL, like `loadSkill`: a port that cannot answer says so by not
   * implementing it, and the caller reports "not available" rather than
   * inventing a clean result.
   */
  wikiFreshness?(input: { page?: string }): Promise<WikiFreshnessResult>;
  graphAffected(input: { target: string; depth?: number; ranked?: boolean }): Promise<GraphAffectedResult>;
  graphQuery(input: { query: "cycles" | "orphans" }): Promise<GraphQueryResult>;
  memorySearch(input: {
    query: string;
    module?: string;
    status?: string;
    class?: string;
    limit?: number;
  }): Promise<MemorySearchResult>;
  readWiki(input: { path: string }): Promise<WikiPageResult>;
  describeContext(): Promise<ContextSummaryResult>;

  // --- flow 043: additive OPTIONAL read operations ----------------------------
  // These are OPTIONAL so every pre-existing full `MetaprojectPort` fake still
  // compiles WITHOUT modification. A consumer must treat an absent method as an
  // "unavailable" operation (a structured, isError result) rather than a throw.

  /** Shortest connection between two files/symbols over the code graph (gdgraph). */
  graphPath?(input: { from: string; to: string }): Promise<GraphPathResult>;
  /** The tests related to a file, by naming + directory heuristic (testing). */
  testRelated?(input: { file: string }): Promise<TestRelatedResult>;
  /** The latest code-health status/gate snapshot (health). */
  healthStatus?(): Promise<HealthStatusResult>;

  // --- flow 044: additive OPTIONAL read operations (batch 2) -------------------
  // Same OPTIONAL contract as flow 043: an absent method is an "unavailable"
  // operation (a structured, isError result), never a throw.

  /** Where a symbol is defined + its callers/callees over the symbol layer (gdgraph). */
  graphSymbol?(input: { name: string }): Promise<GraphSymbolResult>;
  /**
   * A ranked, token-budgeted repo map over the code graph (gdgraph).
   *
   * `seed` is the whole point of the operation for a change intent: a seeded
   * file and its direct consumers/tests become the REQUIRED set, protected
   * from rank eviction. `computeRepomap` and `keryx gdgraph repomap --seed`
   * have accepted it all along; this input used to be `{ budget? }` only, so
   * no seed could ever reach the compute through a tool.
   */
  repomap?(input: { budget?: number; seed?: string[] }): Promise<RepomapResult>;
  /**
   * Deterministic lexical Q&A over the project's wiki + memory (gdwiki).
   * `k` caps the citation count, exactly as `keryx wiki ask --k` does.
   */
  wikiAsk?(input: { question: string; k?: number }): Promise<WikiAskResult>;

  // --- AFC (flow 240): the two capabilities that existed with no boundary ----
  // Same OPTIONAL contract as every batch above: an absent method is an
  // "unavailable" operation (a structured result), never a throw.

  /**
   * Explainable seed-file/symbol search over the code graph (gdgraph), with the
   * AC5 outcome code attached. `keryx gdgraph find` has returned this since
   * flow 235; nothing on the agent or MCP boundary could ask for it.
   */
  graphFind?(input: {
    query: string;
    fileLimit?: number;
    symbolLimit?: number;
  }): Promise<GraphFindResult>;

  /**
   * The wiki evidence envelope (gdwiki) — required items that cannot be
   * silently dropped, conflicting sources paired symmetrically, and a mandatory
   * overflow reported as `budget-exceeded` rather than a shortened rule.
   * `createGdWikiService().evidence` has backed it since flow 235; nothing
   * outside its own test called it.
   */
  wikiEvidence?(input: {
    question: string;
    k?: number;
    budgetTokens?: number;
    maxItems?: number;
  }): Promise<WikiEvidenceResult>;

  // --- flow 122: additive OPTIONAL read operation (MP-5a) ---------------------
  // Same OPTIONAL contract as flows 043/044: an absent method is an
  // "unavailable" operation (a structured result), never a throw.

  /** Wiki pages that reference a repo file — the reverse "documented in" lookup (gdwiki). */
  wikiBacklinks?(input: { file: string }): Promise<WikiBacklinksResult>;

  // --- additive OPTIONAL read operation: Task Manager flow status ------------
  // Same OPTIONAL contract as the batches above: an absent method is an
  // "unavailable" operation (a structured result), never a throw. Gives the
  // interactive agent a `risk: "read"` alternative to `shell_exec` for `keryx
  // flow list`/`status`, so checking flow progress no longer has to spend a
  // non-read budget slot.

  /** Task Manager flows and their status/progress, optionally filtered to one id (flow). */
  flowStatus?(input: { id?: string }): Promise<FlowStatusResult>;

  // --- additive OPTIONAL read operations: gdskills runtime discovery ---------
  // Same OPTIONAL contract as the batches above: an absent method is an
  // "unavailable" operation (a structured result), never a throw. Gives
  // `.metaproject/skills/gdskills/` a structured discovery/load path instead
  // of relying solely on CLAUDE.md/index.md prose routing (docs/requirements/
  // keryx-skills-runtime-tools).

  /** Every skill discovered under `.metaproject/skills/gdskills/` (gdskills). */
  skillsCatalog?(input: Record<string, never>): Promise<SkillsCatalogResult>;
  /** One skill's full SKILL.md body, by name or exact path (gdskills). */
  loadSkill?(input: { name: string }): Promise<SkillLoadResult>;
}
