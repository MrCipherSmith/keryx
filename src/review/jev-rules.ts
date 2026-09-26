// review-jev-rules — flow 330, AC1-AC4 of the frozen acceptance criteria
// (`.metaproject/flows/330-*/acceptance-criteria.md`).
//
// A CLI-driven, deterministic ADDITIONAL orchestrator reviewer that checks
// every changed hunk (from `buildReviewScope`/`hunkRegionsFromDiff`,
// mechanical bulk already dropped) against every APPLICABLE clause of every
// discovered project rule, using Jev ("System One") purely as a `noul`
// judge — "does this hunk VIOLATE this rule clause?" — never as a prose
// writer. keryx composes every word of every finding; Jev supplies one
// probability per (hunk, clause) pair. This is the AC4 guarantee: finding
// synthesis below never reads free text back from Jev, only a number.
//
// CORE ZONE (`src/lib/import-zones.ts`): this module never imports the
// client-zone Jev client (`src/harness/decision/jev-client.ts`) — the same
// discipline `src/review/conform-jev.ts` and `src/review/ci-triage.ts`
// already established (see either file's own header). The question/answer
// shapes below are chosen to satisfy `JevQuestion`/`JevAnswer` structurally
// with no import needed; `src/commands/review-jev-rules.ts` (the ADAPTER) is
// where the two actually meet.
//
// Through the security facade, not `security/redact` directly — the
// import-policy ratchet (`src/lib/import-policy.live.test.ts`) is at its cap,
// and every caller outside `src/security/` reaches redaction through
// `src/security/service.ts` (see `conform-clauses.ts`'s own note on this).
//
// # Rule discovery — the scope decision this flow had to make
//
// AC2 asks for "project skills and installed gdskills whose frontmatter/paths
// mark them as coding conventions". No such marker exists in this codebase
// today (checked: no skill declares `metadata.category: conventions` and no
// `coding_convention` field exists anywhere). Rather than invent a marker no
// author has ever written, discovery here is DELIBERATELY narrow and
// DOCUMENTED, with `--rules <paths>` as the escape hatch for everything it
// misses:
//
//   - every file under `.metaproject/rules/**`, `rules/**` or
//     `.claude/rules/**` (hand-written `.mdc`/`.md` rule corpora; the last is
//     where Claude Code projects keep theirs);
//   - the root `CLAUDE.md` (else `AGENTS.md`), without keryx's managed
//     routing block;
//   - a project-skill or installed gdskill whose directory name contains
//     "convention" (case-insensitive), or whose frontmatter declares
//     `metadata.category: conventions` — the one category value this
//     mechanism is ready to recognise the day a skill author writes it;
//   - anything passed via `--rules <paths>`, unconditionally.
//
// `isCodingConventionSkill` below is the one place this decision lives, so a
// future author extending it has one function to change, not a scattered
// heuristic.
//
// # Precision fix (post-AC9 live check on MrCipherSmith/keryx PR #712)
//
// AC9's live check measured ~1/10 hand-labelled precision. Its journal named
// the cause: this repo's own `.metaproject/rules/**` corpus is 41 broad prose
// docs with no `metadata.paths`/`stack_requires`, several of which are
// PROCESS/AGENT-BEHAVIOUR rules (how to write a commit message, TDD workflow,
// how an agent should report its own edits) with no real per-hunk
// applicability at all — paired against every hunk anyway because
// `clauseApplicability` fails toward inclusion when a rule declares no
// restriction. Two complementary, deterministic fixes, both applied BEFORE
// any violation-scoring Jev call is made (so they also cut cost, not only
// noise):
//
//   1. Clause-kind filtering (`isHunkCheckableClause`, `TaggedRuleSource`,
//      `selectRuleHunkPairs` below): every rule doc's clauses are tagged
//      `state_kind`/`checkable` by REUSING `./conform-clauses.ts`'s own
//      `applyClauseTags`/`buildClauseTagQuestions`/`clauseTagFromChoice` —
//      the exact mechanism `review conform` already uses for its reference
//      documents, cached by content hash via `./conform-tag-cache.ts` — and
//      only a clause tagged `state_kind: "hunk"` and `checkable` is ever
//      paired against a hunk. Tagging is I/O (a cache read, sometimes one
//      Jev `choice` call per doc) so it lives in the ADAPTER
//      (`src/commands/review-jev-rules.ts`'s `resolveRuleSourceClauseTags`),
//      not here; this module stays pure, taking already-tagged clauses in.
//   2. Rule-source category filtering (`classifyRuleSourceCategory`,
//      `PROCESS_RULE_HEURISTIC_TERMS` below): a CHEAPER, coarser pre-filter
//      the adapter applies at DISCOVERY time, before clause extraction runs
//      at all — explicit frontmatter (`applies_to`/`metadata.category`)
//      first, else a documented filename/title heuristic that catches
//      exactly the process docs AC9's ten hand-labelled findings named
//      (commit-message-formatting, tdd-workflow, opus-5-5-prompting,
//      definition-of-done, ...). `--rules <paths>` always overrides — an
//      operator who explicitly names a process doc still gets it checked.
import { extractReferenceClauses, type ReferenceClause } from "./conform-clauses";
import { hunkClauseFacts, hunkRedactedStateText } from "./conform-state";
import { estimateTokens } from "./cost";
import type { ScopedRegion } from "./scope";
import { scopeReviewerByStack, type DetectedStack, type StackTag } from "./stack";
import { redactSensitiveText } from "../security/service";
import { TEST_FILE_RE } from "../testing/selection";

// ---------------------------------------------------------------------------
// Rule source discovery (AC2) — classification helpers only; walking the
// filesystem is the adapter's job (`src/commands/review-jev-rules.ts`).
// ---------------------------------------------------------------------------

export const RULE_SOURCE_KINDS = ["project-rule", "project-skill", "gdskill", "explicit"] as const;
export type RuleSourceKind = (typeof RULE_SOURCE_KINDS)[number];

/** One discovered rule document, already read off disk by the adapter. */
export interface RuleSourceFile {
  /** Repo-relative path — also this source's stable id, used in every finding's `evidence`/`dedupe_key`. */
  readonly path: string;
  readonly kind: RuleSourceKind;
  readonly text: string;
  /** `metadata.paths` (a rule/skill's own declared applicability globs), when present. */
  readonly declaredPaths?: readonly string[];
  /** `metadata.stack_requires`, parsed with `./stack`'s own parser. */
  readonly stackRequires?: readonly StackTag[];
  /**
   * `classifyRuleSourceCategory(path, text)`'s own decision — attached by the
   * adapter to EVERY source it constructs (discovered, skill-based, or
   * `--rules`), whether or not that source survived the category filter
   * (AC-follow-up 2). Used downstream by the file-kind gate (item 4,
   * `clauseFileKindApplicability`) so a `docs`-categorised source only pairs
   * against a docs hunk and vice versa. `undefined` reads as `"code"` — the
   * same default the classifier itself falls back to.
   */
  readonly category?: RuleSourceCategory;
}

/** Read one `metadata.<key>: value` scalar out of a `SKILL.md`-shaped frontmatter block. Never throws. */
export function metadataScalar(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  let inMetadata = false;
  for (const line of content.slice(3, end).split("\n")) {
    const top = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (top) {
      inMetadata = top[1] === "metadata";
      continue;
    }
    if (!inMetadata) continue;
    const field = new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)$`).exec(line);
    if (field?.[1] !== undefined) {
      const raw = field[1].trim();
      return raw.length >= 2 && ((raw[0] === '"' && raw.at(-1) === '"') || (raw[0] === "'" && raw.at(-1) === "'"))
        ? raw.slice(1, -1)
        : raw;
    }
  }
  return undefined;
}

/** AC2's discovery scope decision (see module header): is this skill a coding-convention rule source? */
export function isCodingConventionSkill(name: string, content: string): { readonly matches: boolean; readonly reason: string } {
  if (/convention/i.test(name)) {
    return { matches: true, reason: `skill directory name "${name}" names conventions` };
  }
  const category = metadataScalar(content, "category");
  if (category === "conventions") {
    return { matches: true, reason: 'frontmatter metadata.category is "conventions"' };
  }
  return {
    matches: false,
    reason: 'no convention marker found (directory name, or frontmatter metadata.category: "conventions")',
  };
}

/**
 * Read one TOP-LEVEL `key: value` frontmatter scalar — unlike
 * {@link metadataScalar}, not nested under a `metadata:` block. Used for
 * `applies_to: code|process|docs` (AC-follow-up 2), a field rule authors are
 * meant to write at the frontmatter's own top level, the same place
 * `description`/`alwaysApply` already live in every `.mdc` file in this repo
 * (see `.metaproject/rules/core/*.mdc`). Never throws.
 */
export function frontmatterScalar(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)$`, "m");
  const match = re.exec(content.slice(3, end));
  if (match?.[1] === undefined) return undefined;
  const raw = match[1].trim();
  return raw.length >= 2 && ((raw[0] === '"' && raw.at(-1) === '"') || (raw[0] === "'" && raw.at(-1) === "'")) ? raw.slice(1, -1) : raw;
}

// ---------------------------------------------------------------------------
// Rule-source category filter — a CHEAP pre-filter, applied by the adapter
// BEFORE clause extraction/tagging, so a process/meta rule doc (how to write
// a commit message, how an agent should report its own edits) never costs a
// tagging call OR a violation call at all. This is the corpus-shape problem
// flow 330's own AC9 live-check journal already named as future work: "a
// narrower, explicitly-curated rule set... aimed at hunk-checkable coding
// conventions specifically" — this filter is that narrowing, made cheap and
// deterministic rather than hand-curated.
// ---------------------------------------------------------------------------

export const RULE_SOURCE_CATEGORIES = ["code", "process", "docs"] as const;
export type RuleSourceCategory = (typeof RULE_SOURCE_CATEGORIES)[number];

function isRuleSourceCategory(value: string): value is RuleSourceCategory {
  return (RULE_SOURCE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The documented default filename/title heuristic (AC-follow-up 2): a rule
 * source whose path or title contains any of these (case-insensitive) is
 * treated as `process` unless frontmatter says otherwise. Exported so a rule
 * author — or a test — can see and pin the exact list rather than reverse-
 * engineering it from behaviour. Substring match on purpose: "review-process"
 * catches `code-review-process-notes.mdc` as readily as an exact filename.
 */
export const PROCESS_RULE_HEURISTIC_TERMS = [
  "commit",
  "git",
  "tdd",
  "workflow",
  "definition-of-done",
  "documentation",
  "requirements",
  "plan",
  "prompting",
  "subagent",
  "skill",
  "jobs",
  "orchestrat",
  "review-process",
  "release",
] as const;

/** A rule doc's own title: frontmatter `description`, else its first `#` heading, else empty. */
function ruleSourceTitle(content: string): string {
  const description = frontmatterScalar(content, "description");
  if (description !== undefined) return description;
  const heading = /^#\s+(.+)$/m.exec(content);
  return heading?.[1] ?? "";
}

export interface RuleSourceCategoryDecision {
  readonly category: RuleSourceCategory;
  readonly reason: string;
}

/**
 * AC-follow-up 2: classify one rule source's category. Explicit frontmatter
 * wins outright — `applies_to` (top-level) first, then `metadata.category` —
 * over the heuristic, which is only a default for the many `.mdc` docs this
 * repo's own corpus ships with neither field. `filePath` is matched together
 * with the doc's own title so a file named ambiguously (`house-rules.mdc`)
 * can still be caught by a title that names process ("Commit Workflow").
 */
export function classifyRuleSourceCategory(filePath: string, content: string): RuleSourceCategoryDecision {
  const appliesTo = frontmatterScalar(content, "applies_to");
  if (appliesTo !== undefined && isRuleSourceCategory(appliesTo)) {
    return { category: appliesTo, reason: `frontmatter declares applies_to: "${appliesTo}"` };
  }
  const metaCategory = metadataScalar(content, "category");
  if (metaCategory !== undefined && isRuleSourceCategory(metaCategory)) {
    return { category: metaCategory, reason: `frontmatter declares metadata.category: "${metaCategory}"` };
  }
  const haystack = `${filePath} ${ruleSourceTitle(content)}`.toLowerCase();
  const hit = PROCESS_RULE_HEURISTIC_TERMS.find((term) => haystack.includes(term));
  if (hit !== undefined) {
    return { category: "process", reason: `filename/title heuristic matched "${hit}"` };
  }
  return { category: "code", reason: "no frontmatter category declared and no process/meta heuristic term matched the filename or title" };
}

const RATIONALE_HEADING_RE = /rationale|why|purpose|reason/i;

/** AC4's "the rule's stated rationale if present": the text of the first clause whose nearest heading names one of rationale/why/purpose/reason. `undefined` when the rule states none — the caller then falls back to `DEFAULT_IMPACT_TEMPLATE`. */
export function extractRuleRationale(ruleText: string): string | undefined {
  const clause = extractReferenceClauses(ruleText).find((c) => c.heading_path.some((heading) => RATIONALE_HEADING_RE.test(heading)));
  return clause?.text;
}

// ---------------------------------------------------------------------------
// Placeholder/template clause filter (precision fix, item 3) — a live
// re-measurement of PR #712 found clauses like `[x] <criterion 1> —
// verified by <test>`: authoring-template scaffolding from a checklist a
// rule author never filled in, extracted as a real clause and checked
// against every hunk anyway. Applied by the adapter right after
// `extractReferenceClauses`, before a clause ever reaches tagging or
// pairing — pure, deterministic, no I/O.
// ---------------------------------------------------------------------------

const PLACEHOLDER_TOKEN_RE = /<[^<>\n]{1,100}>/g;
const CHECKLIST_MARKER_RE = /^\[[ xX]\]\s*/;
const CODE_FENCE_ONLY_RE = /^`{3,}[\w-]*$/;

/**
 * True for a clause whose text is authoring scaffolding rather than a real,
 * fillable rule — three independent shapes, each sufficient on its own:
 *
 *   1. A checklist item (`[ ]`/`[x]`) whose text still carries a `<...>`
 *      placeholder token — `[x] <criterion 1> — verified by <test>` was
 *      never filled in.
 *   2. Text dominated by `<...>` placeholders: once every placeholder token
 *      is stripped, fewer than 8 non-space/punctuation characters remain.
 *   3. The whole clause is only a code-fence marker (`` ``` `` / `` ```ts ``)
 *      that slipped through list-item extraction.
 *
 * Empty text (already unreachable — `extractReferenceClauses` never emits an
 * empty clause) is treated as a placeholder too, defensively.
 */
export function isPlaceholderClauseText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (CODE_FENCE_ONLY_RE.test(trimmed)) return true;
  // A `<...>` inside backticks is code the rule names (`<script>`,
  // `Array<T>`), never an unfilled placeholder — only bare ones count.
  const placeholders = trimmed.replace(/`[^`]*`/g, "code").match(PLACEHOLDER_TOKEN_RE) ?? [];
  if (placeholders.length === 0) return false;
  if (CHECKLIST_MARKER_RE.test(trimmed)) return true;
  const withoutPlaceholders = trimmed.replace(PLACEHOLDER_TOKEN_RE, "").replace(/[\s\-–—:.,;]+/g, "");
  return withoutPlaceholders.length < 8;
}

// ---------------------------------------------------------------------------
// Applicability (AC2): which clauses of a rule source apply to which changed
// file, by declared path globs and/or stack_requires — pure, deterministic.
// ---------------------------------------------------------------------------

/** Translate one glob (`src/core/**`, `*.ts`, `**\/*.test.ts`) into an anchored RegExp. `**` matches across path separators; `*` does not. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
      // Swallow one following slash so `src/**/*.ts` and `src/**.ts` behave alike.
      if (glob[i + 1] === "/") i += 1;
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    source += ch!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

export interface ApplicabilityDecision {
  readonly applicable: boolean;
  readonly reason: string;
}

/**
 * AC2: is `source` applicable to `changedFile`? Stack gate first (reusing
 * `./stack`'s own decision function — same asymmetry: uncertain always
 * includes), then declared path globs. A source with neither restriction
 * applies to every changed file — the same fail-toward-inclusion the rest of
 * the review pipeline (`scope.ts`, `stack.ts`) already commits to: a rule
 * checked needlessly costs a Jev call, a rule silently skipped hides a real
 * violation.
 */
export function clauseApplicability(source: RuleSourceFile, changedFile: string, detectedStack: DetectedStack): ApplicabilityDecision {
  const stackRequires = source.stackRequires ?? [];
  if (stackRequires.length > 0) {
    const decision = scopeReviewerByStack(source.path, stackRequires, detectedStack);
    if (!decision.include) {
      return { applicable: false, reason: `stack: ${decision.reason}` };
    }
  }
  const declaredPaths = source.declaredPaths ?? [];
  if (declaredPaths.length > 0) {
    if (!matchesAnyGlob(changedFile, declaredPaths)) {
      return { applicable: false, reason: `no declared path glob (${declaredPaths.join(", ")}) matches "${changedFile}"` };
    }
    return { applicable: true, reason: `matched declared path glob against "${changedFile}"` };
  }
  return { applicable: true, reason: "no path/stack restriction declared on this rule — applies to every changed file" };
}

// ---------------------------------------------------------------------------
// File-kind gating (precision fix, item 4) — a live re-measurement found a
// code-convention clause (no declared path restriction, so `clauseApplicability`
// above waves it through everywhere) paired against a `docs/docs/cli-reference.md`
// hunk. `clauseApplicability` stays untouched (the existing language/path/stack
// gate); this is an ADDITIONAL gate, keyed on the rule source's own category
// (`classifyRuleSourceCategory`, AC-follow-up 2) versus the changed file's
// kind — `docs` only pairs with `docs`, `code` (the default for every other
// category, including `undefined`/unclassified) only pairs with non-docs
// files. A single clause can opt out of its source's own category with an
// explicit `[docs-applicable]` marker, the same trailing-bracket family as
// `[severity: ...]` below — a `code`-categorised source can still carry one
// clause about documentation (e.g. "update the README when a public API
// changes") that should be checked against a docs hunk too.
// ---------------------------------------------------------------------------

const DOCS_FILE_RE = /\.(md|mdx|txt)$/i;

export type HunkFileKind = "docs" | "code";

/** A changed file's kind for the file-kind gate — `.md`/`.mdx`/`.txt` are `"docs"`; everything else, including test files, is `"code"` (item 2's separate test/docs ordering does not change this binary split). */
export function hunkFileKind(filePath: string): HunkFileKind {
  return DOCS_FILE_RE.test(filePath) ? "docs" : "code";
}

const DOCS_APPLICABLE_MARKER_RE = /\[docs-applicable\]/i;

/** A clause's own opt-in, independent of its source's category — `[docs-applicable]` anywhere in the clause text. */
export function isDocsApplicableClauseText(clauseText: string): boolean {
  return DOCS_APPLICABLE_MARKER_RE.test(clauseText);
}

export interface FileKindApplicabilityDecision {
  readonly applicable: boolean;
  readonly reason: string;
}

/** May `clauseText` (from a source categorised `sourceCategory`) be checked against a hunk of `changedFileKind`? `sourceCategory` of `undefined` reads as `"code"`, the same default the classifier itself falls back to. */
export function clauseFileKindApplicability(
  sourceCategory: RuleSourceCategory | undefined,
  clauseText: string,
  changedFileKind: HunkFileKind,
): FileKindApplicabilityDecision {
  const category = sourceCategory ?? "code";
  if (changedFileKind === "docs") {
    if (category === "docs") return { applicable: true, reason: "rule source categorised docs; hunk is a docs file" };
    if (isDocsApplicableClauseText(clauseText)) return { applicable: true, reason: "clause explicitly tagged [docs-applicable]" };
    return {
      applicable: false,
      reason: `hunk is a docs file but the rule source is categorised "${category}" and the clause carries no [docs-applicable] marker`,
    };
  }
  if (category === "docs") {
    return { applicable: false, reason: "rule source categorised docs; hunk is a code file" };
  }
  return { applicable: true, reason: "hunk is a code file; rule source is not categorised docs" };
}

// ---------------------------------------------------------------------------
// API/endpoint scope gating (precision fix, live PR #743's own run) — a rule
// source whose OWN declared scope is HTTP/API endpoints applies to endpoint
// code, not every changed file. The live check found `api-contracts.mdc`'s
// "required fields for every endpoint" clause paired against
// `src/standard/command-registry.ts`, a CLI command registry with no HTTP
// endpoint anywhere in it — the SAME shape of mistake `clauseFileKindApplic-
// ability` above already fixes for docs vs code (a source's OWN declared
// scope, applied everywhere it declares no narrower restriction), just for a
// different scope axis. An ADDITIONAL gate alongside `clauseApplicability`'s
// existing path/stack check — never a replacement for it — keyed on the
// SOURCE's own detected API scope versus whether the CHANGED FILE itself
// looks like an API surface.
// ---------------------------------------------------------------------------

/** Whole-word, case-insensitive — matched against a rule source's declared path globs (`metadata.paths`), its own title (frontmatter `description`, else its first `#` heading — {@link ruleSourceTitle}), and its file path, the same three places `classifyRuleSourceCategory` and AC9's live check already read a rule's own stated scope from. */
export const API_SCOPE_TERMS = ["api", "endpoint", "rest", "http", "openapi"] as const;

/** AC-follow-up 5: is `source`'s own declared scope HTTP/API endpoints? A path glob naming `api/**`, a description/title mentioning "REST", "OpenAPI", "HTTP", or a filename like `api-contracts.mdc` are each sufficient on their own. */
export function isApiScopedRuleSource(source: RuleSourceFile): boolean {
  const haystack = `${(source.declaredPaths ?? []).join(" ")} ${ruleSourceTitle(source.text)} ${source.path}`.toLowerCase();
  return API_SCOPE_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(haystack));
}

/** A directory literally named `api`, `routes`, `controllers`, `handlers`, or `server` — the conventional homes for HTTP endpoint code in this codebase's own stack and the frameworks it's paired against. */
const API_SURFACE_DIR_RE = /(^|\/)(api|routes|controllers|handlers|server)\//i;
/** An `import ... from "<http-framework>"` in the hunk's own changed text — evidence the hunk itself wires up an HTTP endpoint, independent of its path. */
const HTTP_FRAMEWORK_IMPORT_RE = /\bfrom\s*["'](?:express|fastify|koa|hono|@hono\/[\w-]+|hapi|@nestjs\/(?:common|core)|next\/server|h3)["']/;

/** Does `region` look like an API surface — a path under one of {@link API_SURFACE_DIR_RE}'s directories, or a hunk that imports a known HTTP framework? A fact about the HUNK, independent of any rule source. */
export function looksLikeApiSurfaceHunk(region: ScopedRegion): boolean {
  return API_SURFACE_DIR_RE.test(region.path) || HTTP_FRAMEWORK_IMPORT_RE.test(region.text);
}

/** May ANY hunk-checkable clause of `source` be paired against `region` at all, from the API-scope gate's point of view? A source that is not API-scoped (`isApiScopedRuleSource`) is untouched by this gate — always applicable. Same shape as {@link ApplicabilityDecision}, kept as its own named type so a caller can tell which gate produced a refusal from the type alone, same discipline `FileKindApplicabilityDecision` already follows for the file-kind gate. */
export interface ApiScopeApplicabilityDecision {
  readonly applicable: boolean;
  readonly reason: string;
}

/** AC-follow-up 5: is `source` (an API-scoped rule source, or not) applicable to `region`? A source not API-scoped always passes this gate untouched — it is additive, never a replacement for `clauseApplicability`'s existing path/stack check. */
export function clauseApiScopeApplicability(source: RuleSourceFile, region: ScopedRegion): ApiScopeApplicabilityDecision {
  if (!isApiScopedRuleSource(source)) {
    return { applicable: true, reason: "rule source is not API/endpoint-scoped — this gate does not apply" };
  }
  if (looksLikeApiSurfaceHunk(region)) {
    return { applicable: true, reason: `rule source is API/endpoint-scoped and ${region.path} looks like an API surface` };
  }
  return {
    applicable: false,
    reason:
      `rule source is API/endpoint-scoped (its declared paths/description/title name one of: ${API_SCOPE_TERMS.join(", ")}) but ${region.path} ` +
      "does not look like an API surface (no api/routes/controllers/handlers/server path segment, and this hunk imports no known HTTP framework)",
  };
}

// ---------------------------------------------------------------------------
// Pair selection (AC3): every (region, rule clause) pair the applicability
// decision admits, capped at `--max-calls`, deterministic order, nothing
// dropped silently.
// ---------------------------------------------------------------------------

/** Default `--max-calls`: bounds a single run to a budget an operator can afford without thinking about it, matching the order of magnitude AC9's live check uses (~150 Jev calls total across two PRs). */
export const DEFAULT_MAX_JEV_RULE_CALLS = 150;

export interface RuleHunkPair {
  readonly region: ScopedRegion;
  readonly ruleId: string;
  readonly clause: ReferenceClause;
  readonly reason: string;
}

/**
 * One rule source paired with its already-TAGGED clauses (conform's
 * `applyClauseTags`/`buildClauseTagQuestions`/`clauseTagFromChoice`,
 * resolved by the adapter — see `src/commands/review-jev-rules.ts`'s
 * `resolveRuleSourceClauseTags`). `selectRuleHunkPairs` below is still pure:
 * it reads tags a caller already resolved, it never resolves them itself.
 */
export interface TaggedRuleSource {
  readonly source: RuleSourceFile;
  readonly clauses: readonly ReferenceClause[];
}

/** Precision fix: only a clause tagged `state_kind: "hunk"` and `checkable` can ever describe a code-hunk violation — a `"pr"`/`"report"`-kind or not-checkable clause paired against a hunk anyway is exactly the category-mismatch false-positive shape AC9's live check found (commit-message-formatting, opus-5-5-prompting, tdd-workflow). */
export function isHunkCheckableClause(clause: ReferenceClause): boolean {
  return clause.state_kind === "hunk" && clause.checkable;
}

export interface DroppedClause {
  readonly ruleId: string;
  readonly clauseId: string;
  readonly reason: string;
}

export interface HunkCoverage {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Pairs this hunk had after every gate (path/stack, hunk-checkable clause, file-kind) — the denominator "how much was there to check". */
  readonly applicablePairs: number;
  /** Pairs this hunk actually got scored, after the `--max-calls` round-robin allocation below. */
  readonly selectedPairs: number;
}

export interface PairSelectionResult {
  readonly selected: readonly RuleHunkPair[];
  readonly dropped: readonly RuleHunkPair[];
  readonly notApplicable: readonly { readonly region: ScopedRegion; readonly ruleId: string; readonly reason: string }[];
  /** Every (ruleId, clauseId) excluded from pairing because it is not `state_kind: "hunk"` and `checkable` — reported once per clause, never silently. */
  readonly droppedClauses: readonly DroppedClause[];
  readonly maxCalls: number;
  /**
   * Item 2: one entry per hunk that had at least one applicable pair, in the
   * priority order the round-robin allocator used below (code first, then
   * tests, then docs; original diff order breaks ties within a rank) — so a
   * caller can see exactly which hunks the budget reached and which it
   * never got to, never only a raw pair count.
   */
  readonly hunkCoverage: readonly HunkCoverage[];
  /** `hunkCoverage.length` minus this is how many hunks with something to check were never reached by the budget — `hunkCoverage.length - hunksReached`. */
  readonly hunksReached: number;
}

function droppedClauseReason(clause: ReferenceClause): string {
  if (!clause.checkable) return clause.reason ?? `not checkable (state_kind: "${clause.state_kind}")`;
  return `tagged state_kind: "${clause.state_kind}", not "hunk" — not a hunk-checkable clause`;
}

/**
 * Item 2's hunk ordering: code (non-docs, non-test) first, then test files,
 * then docs — so a fixed-size round-robin slice (below) reaches a code hunk
 * before it reaches a docs hunk, deterministically, regardless of which one
 * happens to sit first in the diff. Reuses `hunkFileKind` (docs vs
 * everything else) and `../testing/selection.ts`'s own `TEST_FILE_RE` — the
 * SAME test-file regex `review floor`/`review scope`/`keryx test related`
 * already share — rather than inventing a second test-path heuristic.
 */
function hunkPriorityRank(filePath: string): 0 | 1 | 2 {
  if (hunkFileKind(filePath) === "docs") return 2;
  if (TEST_FILE_RE.test(filePath)) return 1;
  return 0;
}

/**
 * AC3, plus the precision-fix follow-ups: build every applicable (hunk,
 * clause) pair — clauses already filtered to `state_kind: "hunk"` and
 * `checkable` (the tag-based filter), sources gated by file-kind (item 4) —
 * then spend `maxCalls` FAIRLY across hunks instead of draining it on the
 * first hunk in diff order. That was the PR #712 live-check bug this fixes:
 * the whole default 150-call budget landed on a single docs hunk in
 * `cli-reference.md`, and not one code hunk was ever scored.
 *
 * Hunk order: `hunkPriorityRank` above — code, then tests, then docs;
 * original diff order breaks ties within a rank, so a re-run over the SAME
 * diff and SAME rules ranks hunks identically every time.
 *
 * Allocation: round-robin, `K` clauses per hunk per round, where
 * `K = max(1, floor(maxCalls / hunks-with-at-least-one-applicable-pair))` —
 * computed ONCE, so every hunk in the rotation gets at least one round when
 * the budget allows one K-sized slice per hunk. A hunk whose queue empties
 * before a later round simply drops out of the rotation; the freed capacity
 * keeps circulating among the hunks still holding pairs. Deterministic: same
 * inputs, same `K`, same rotation order, same result every run.
 */
export function selectRuleHunkPairs(
  regions: readonly ScopedRegion[],
  taggedSources: readonly TaggedRuleSource[],
  detectedStack: DetectedStack,
  maxCalls: number = DEFAULT_MAX_JEV_RULE_CALLS,
): PairSelectionResult {
  const sorted = [...taggedSources].sort((a, b) => a.source.path.localeCompare(b.source.path));

  // Every dropped (ruleId, clauseId) is reported exactly once, regardless of
  // how many hunks it would otherwise have been paired against.
  const droppedClauses: DroppedClause[] = [];
  const seenDropped = new Set<string>();
  for (const { source, clauses } of sorted) {
    for (const clause of clauses) {
      if (isHunkCheckableClause(clause)) continue;
      const key = `${source.path}::${clause.clause_id}`;
      if (seenDropped.has(key)) continue;
      seenDropped.add(key);
      droppedClauses.push({ ruleId: source.path, clauseId: clause.clause_id, reason: droppedClauseReason(clause) });
    }
  }

  const orderedRegions = regions
    .map((region, index) => ({ region, index, rank: hunkPriorityRank(region.path) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
    .map((entry) => entry.region);

  const pairsByRegion = new Map<ScopedRegion, RuleHunkPair[]>();
  const notApplicable: { readonly region: ScopedRegion; readonly ruleId: string; readonly reason: string }[] = [];
  for (const region of orderedRegions) {
    const changedFileKind = hunkFileKind(region.path);
    const regionPairs: RuleHunkPair[] = [];
    for (const { source, clauses } of sorted) {
      const decision = clauseApplicability(source, region.path, detectedStack);
      if (!decision.applicable) {
        notApplicable.push({ region, ruleId: source.path, reason: decision.reason });
        continue;
      }
      const apiScopeDecision = clauseApiScopeApplicability(source, region);
      if (!apiScopeDecision.applicable) {
        notApplicable.push({ region, ruleId: source.path, reason: apiScopeDecision.reason });
        continue;
      }
      let sawHunkCheckable = false;
      let anyFileKindApplicable = false;
      for (const clause of clauses) {
        if (!isHunkCheckableClause(clause)) continue;
        sawHunkCheckable = true;
        const fileKindDecision = clauseFileKindApplicability(source.category, clause.text, changedFileKind);
        if (!fileKindDecision.applicable) continue;
        anyFileKindApplicable = true;
        regionPairs.push({ region, ruleId: source.path, clause, reason: decision.reason });
      }
      if (sawHunkCheckable && !anyFileKindApplicable) {
        notApplicable.push({
          region,
          ruleId: source.path,
          reason: `file-kind gate: every hunk-checkable clause of this source excluded for a ${changedFileKind} hunk (source category "${source.category ?? "code"}")`,
        });
      }
    }
    pairsByRegion.set(region, regionPairs);
  }

  const all: RuleHunkPair[] = orderedRegions.flatMap((region) => pairsByRegion.get(region) ?? []);
  const cap = Number.isFinite(maxCalls) && maxCalls >= 0 ? Math.trunc(maxCalls) : DEFAULT_MAX_JEV_RULE_CALLS;

  const candidateRegions = orderedRegions.filter((region) => (pairsByRegion.get(region) ?? []).length > 0);
  const roundSize = candidateRegions.length > 0 ? Math.max(1, Math.floor(cap / candidateRegions.length)) : 0;

  const queues = candidateRegions.map((region) => ({ region, queue: [...(pairsByRegion.get(region) ?? [])] }));
  const selectedCountByRegion = new Map<ScopedRegion, number>();
  const selected: RuleHunkPair[] = [];
  let remaining = cap;
  let active = queues.filter((entry) => entry.queue.length > 0);
  while (remaining > 0 && active.length > 0) {
    const next: typeof active = [];
    for (const entry of active) {
      if (remaining <= 0) {
        next.push(entry);
        continue;
      }
      const take = Math.min(roundSize, entry.queue.length, remaining);
      if (take > 0) {
        const items = entry.queue.splice(0, take);
        selected.push(...items);
        selectedCountByRegion.set(entry.region, (selectedCountByRegion.get(entry.region) ?? 0) + items.length);
        remaining -= take;
      }
      if (entry.queue.length > 0) next.push(entry);
    }
    active = next;
  }

  const selectedSet = new Set(selected);
  const dropped = all.filter((pair) => !selectedSet.has(pair));

  const hunkCoverage: HunkCoverage[] = candidateRegions.map((region) => ({
    path: region.path,
    startLine: region.startLine,
    endLine: region.endLine,
    applicablePairs: (pairsByRegion.get(region) ?? []).length,
    selectedPairs: selectedCountByRegion.get(region) ?? 0,
  }));
  const hunksReached = hunkCoverage.filter((coverage) => coverage.selectedPairs > 0).length;

  return { selected, dropped, notApplicable, droppedClauses, maxCalls: cap, hunkCoverage, hunksReached };
}

// ---------------------------------------------------------------------------
// Batching (AC3) — mirrors `./conform-jev.ts`'s `batchConformItems` pattern:
// group same-region questions under the vendor's 64k `state`+`questions`
// budget, splitting rather than truncating. The question asks VIOLATION,
// never SATISFACTION — the opposite framing from conform, which is why this
// is a sibling module and not a shared function.
// ---------------------------------------------------------------------------

export interface RuleNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

/** Mirrors `conform-jev.ts`'s `CONFORM_TOKEN_BUDGET` — the vendor's documented combined `state`+`questions` ceiling. */
export const RULE_TOKEN_BUDGET = 64_000;
const QUESTIONS_BUDGET_FRACTION = 0.5;

export function ruleQuestionKey(ruleId: string, clauseId: string): string {
  return `${ruleId}::${clauseId}`;
}

/**
 * The redacted clause text is embedded — that is the feature (opt-in via
 * `review.jev.rules`) — after `redactSensitiveText` strips any secret the
 * rule document itself happens to contain, the same floor every other piece
 * of state sent to Jev already gets (see `conform-jev.ts`'s own note).
 */
function questionFor(ruleId: string, clause: ReferenceClause): RuleNoulQuestion {
  return {
    type: "noul",
    instructions:
      `Given the hunk above (deterministic facts, then the redacted diff text), does this hunk VIOLATE the following ` +
      `project rule clause? Rule "${ruleId}", clause ${clause.clause_id}: ${redactSensitiveText(clause.text)}`,
  };
}

/** AC3's deterministic facts for one hunk: `hunkClauseFacts`'s own location line, plus inferred language and symbols touched. */
export function ruleFactLines(region: ScopedRegion): string[] {
  return [...hunkClauseFacts(region).factLines, `language: ${inferLanguage(region.path)}`, `symbols touched: ${symbolsTouched(region.text)}`];
}

const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript (tsx)",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript (jsx)",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "c++",
  ".cpp": "c++",
  ".hpp": "c++",
  ".cs": "c#",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".md": "markdown",
  ".mdc": "markdown (rule)",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sql": "sql",
};

/** Best-effort language name from a file's extension. `"unknown"` is reported rather than guessed — this is a fact fed to Jev, never inferred beyond what the extension states. */
export function inferLanguage(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "unknown";
  return EXTENSION_LANGUAGE[filePath.slice(dot).toLowerCase()] ?? "unknown";
}

const DECLARATION_RE = /\b(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const MAX_SYMBOLS = 20;

/**
 * A deterministic, regex-based (never a parser) list of identifiers a hunk's
 * changed lines declare. Over- and under-matches are both expected — this is
 * a fact reported alongside the hunk text, not a claim the hunk's semantics
 * were understood.
 */
export function symbolsTouched(regionText: string): string {
  const symbols = new Set<string>();
  for (const line of regionText.split("\n")) {
    if (line.length === 0 || (line[0] !== "+" && line[0] !== "-")) continue;
    for (const match of line.matchAll(DECLARATION_RE)) {
      if (symbols.size >= MAX_SYMBOLS) break;
      if (match[1] !== undefined) symbols.add(match[1]);
    }
  }
  return symbols.size > 0 ? [...symbols].join(", ") : "(none matched)";
}

export interface RuleBatch {
  readonly region: ScopedRegion;
  readonly items: readonly RuleHunkPair[];
  readonly state: string;
  readonly questions: Readonly<Record<string, RuleNoulQuestion>>;
}

/** Group one region's applicable (ruleId, clause) pairs into as few Jev calls as fit the budget — AC3, mirroring `batchConformItems`. */
export function batchRulePairsForRegion(region: ScopedRegion, pairs: readonly RuleHunkPair[]): RuleBatch[] {
  const sharedRedactedText = hunkRedactedStateText(region);
  const sharedTokens = estimateTokens(sharedRedactedText);
  const factLines = ruleFactLines(region);
  const batches: RuleBatch[] = [];
  let current: RuleHunkPair[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      region,
      items: current,
      state: [...factLines, "", "--- state ---", sharedRedactedText].join("\n"),
      questions: Object.fromEntries(current.map((item) => [ruleQuestionKey(item.ruleId, item.clause.clause_id), questionFor(item.ruleId, item.clause)])),
    });
    current = [];
  };

  for (const pair of pairs) {
    const attempt = [...current, pair];
    const questionsTokens = estimateTokens(
      attempt.map((item) => `${ruleQuestionKey(item.ruleId, item.clause.clause_id)}:noul:${questionFor(item.ruleId, item.clause).instructions}`).join("\n"),
    );
    const total = sharedTokens + questionsTokens;
    const withinQuestionsShare = questionsTokens <= RULE_TOKEN_BUDGET * QUESTIONS_BUDGET_FRACTION;
    if (current.length > 0 && (total > RULE_TOKEN_BUDGET || !withinQuestionsShare)) {
      flush();
      current = [pair];
    } else {
      current = attempt;
    }
  }
  flush();
  return batches;
}

/** Every region's pairs, batched — the adapter's one call to get every Jev request this run will make. */
export function batchAllRulePairs(pairs: readonly RuleHunkPair[]): RuleBatch[] {
  const byRegion = new Map<ScopedRegion, RuleHunkPair[]>();
  for (const pair of pairs) {
    const list = byRegion.get(pair.region) ?? [];
    list.push(pair);
    byRegion.set(pair.region, list);
  }
  const batches: RuleBatch[] = [];
  for (const [region, regionPairs] of byRegion) {
    batches.push(...batchRulePairsForRegion(region, regionPairs));
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Finding synthesis (AC4) — deterministic prose, Jev supplies only the
// probability. One finding per (hunk, clause) above threshold, deduped per
// clause+file with a hunk list.
// ---------------------------------------------------------------------------

export const SEVERITY_ORDER = ["info", "minor", "major", "blocker"] as const;
export type RuleFindingSeverity = (typeof SEVERITY_ORDER)[number];
const SEVERITY_RANK: Readonly<Record<RuleFindingSeverity, number>> = { info: 0, minor: 1, major: 2, blocker: 3 };

export type RuleFindingConfidence = "high" | "medium" | "low";

/** Default `noul` threshold above which a (hunk, clause) pair becomes a finding — mirrors `conform-jev.ts`'s `DEFAULT_CONFORM_THRESHOLD`. */
export const DEFAULT_JEV_RULES_THRESHOLD = 0.5;

/** AC4's documented probability -> severity mapping, BEFORE the `minor` cap is applied. */
export function probabilityToUncappedSeverity(probability: number): RuleFindingSeverity {
  if (probability >= 0.9) return "blocker";
  if (probability >= 0.75) return "major";
  if (probability >= 0.5) return "minor";
  return "info";
}

/** AC4's probability -> confidence bands. Certainty is distance from 0.5 either direction — a 0.5 verdict is the least confident answer Jev can give, whichever way a caller rounds it. */
export function probabilityToConfidence(probability: number): RuleFindingConfidence {
  const certainty = Math.max(probability, 1 - probability);
  if (certainty >= 0.85) return "high";
  if (certainty >= 0.65) return "medium";
  return "low";
}

const SEVERITY_MARKER_RE = /\[severity:\s*(blocker|major|minor|info)\]/i;

function isRuleFindingSeverity(value: string): value is RuleFindingSeverity {
  return (SEVERITY_ORDER as readonly string[]).includes(value);
}

/** Strip an explicit `[severity: major]` marker (same syntax family as `conform-clauses.ts`'s `[state:pr]`) from a clause's text, returning the clean text and the declared severity, if any. */
export function declaredSeverityAndCleanText(clauseText: string): { readonly text: string; readonly declared?: RuleFindingSeverity } {
  const match = SEVERITY_MARKER_RE.exec(clauseText);
  if (match === null) return { text: clauseText };
  const declared = match[1]!.toLowerCase();
  const text = clauseText.replace(SEVERITY_MARKER_RE, "").replace(/\s+/g, " ").trim();
  return isRuleFindingSeverity(declared) ? { text, declared } : { text };
}

/** AC4: capped at `minor` unless the rule declares a higher severity via `[severity: ...]`. */
export function cappedSeverity(uncapped: RuleFindingSeverity, ruleDeclared: RuleFindingSeverity | undefined): RuleFindingSeverity {
  const ceiling = Math.max(SEVERITY_RANK.minor, ruleDeclared !== undefined ? SEVERITY_RANK[ruleDeclared] : SEVERITY_RANK.minor);
  return SEVERITY_ORDER[Math.min(SEVERITY_RANK[uncapped], ceiling)]!;
}

export const DEFAULT_IMPACT_TEMPLATE =
  "Violating a documented project rule erodes the convention the rule exists to keep consistent across the codebase; " +
  "the next reader or reviewer has to re-discover the exception by hand, and the rule stops being a reliable statement " +
  "of how this project works.";

/** One Jev-scored (hunk, clause) pair, above or below threshold — the adapter's raw material for `synthesizeFindingsFromViolations`. */
export interface RuleViolationCandidate {
  readonly region: ScopedRegion;
  readonly ruleId: string;
  readonly clause: ReferenceClause;
  readonly probability: number;
}

export interface RuleFinding {
  readonly id: string;
  readonly severity: RuleFindingSeverity;
  readonly file: string;
  readonly line: number;
  readonly quote: string;
  readonly problem: string;
  readonly impact: string;
  readonly suggested_fix: string;
  readonly evidence: string;
  readonly confidence: RuleFindingConfidence;
  readonly reviewer: "review-jev-rules";
  readonly dedupe_key: string;
  /** `reviewer-finding.schema.json` requires this for `blocker`/`major` severity — every hunk site this finding's group covers, enumerated by construction (the dedup grouping itself), never by "I checked the others". */
  readonly class_scope?: { readonly sites: readonly string[]; readonly enumeration_method: string };
}

/** The first non-empty changed line of a region, diff prefix stripped — `quote`, per the schema's own instruction: a model is good at repeating text it just read, not at counting lines. */
export function firstChangedLineQuote(region: ScopedRegion): string {
  for (const line of region.text.split("\n")) {
    if (line.length === 0) continue;
    const marker = line[0];
    if (marker !== "+" && marker !== "-") continue;
    const content = line.slice(1).trim();
    if (content.length > 0) return content;
  }
  return region.text.trim().slice(0, 200);
}

function shortHash(input: string): string {
  // FNV-1a 32-bit — deterministic, dependency-free, sufficient for a finding
  // id that only needs to be stable and collision-unlikely within one run.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function dedupeKeyFor(ruleId: string, clauseId: string, file: string): string {
  return `${ruleId}::${clauseId}::${file}`;
}

/**
 * AC4: group violation candidates by (ruleId, clauseId, file) — "deduped per
 * clause+file with a hunk list" — one finding per group. `file`/`line`/
 * `quote` anchor to the FIRST hunk (by line, stable across a re-run);
 * `severity`/`confidence` read the WORST (highest-probability) hunk in the
 * group, the strongest evidence found rather than the first. Every hunk's
 * own location and probability is recorded in `evidence` regardless.
 *
 * `ruleRationales` supplies "the rule's stated rationale if present" (AC4);
 * a rule with none gets `DEFAULT_IMPACT_TEMPLATE`.
 */
export function synthesizeFindingsFromViolations(
  candidates: readonly RuleViolationCandidate[],
  threshold: number = DEFAULT_JEV_RULES_THRESHOLD,
  ruleRationales: ReadonlyMap<string, string> = new Map(),
): RuleFinding[] {
  const groups = new Map<string, RuleViolationCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.probability < threshold) continue;
    const key = dedupeKeyFor(candidate.ruleId, candidate.clause.clause_id, candidate.region.path);
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }

  const findings: RuleFinding[] = [];
  for (const key of [...groups.keys()].sort()) {
    // `anchor` (first hunk, by line) fixes WHERE the finding points — stable
    // across a re-run even if Jev's scores shift slightly. `worst` (highest
    // probability) decides HOW SEVERE it reads — the strongest evidence in
    // the group, not the first one found.
    const group = groups.get(key)!.slice().sort((a, b) => a.region.startLine - b.region.startLine);
    const anchor = group[0]!;
    const worst = group.reduce((max, c) => (c.probability > max.probability ? c : max), group[0]!);
    const { text: clauseText, declared } = declaredSeverityAndCleanText(anchor.clause.text);
    const severity = cappedSeverity(probabilityToUncappedSeverity(worst.probability), declared);
    const confidence = probabilityToConfidence(worst.probability);
    const headingPath = anchor.clause.heading_path.join(" > ") || "(no heading)";
    const hunkList = group.map((c) => `${c.region.path}:${c.region.startLine}-${c.region.endLine} (p=${c.probability.toFixed(2)})`);
    const problem =
      `${group.length} hunk${group.length === 1 ? "" : "s"} in ${anchor.region.path} likely violate${group.length === 1 ? "s" : ""} ` +
      `rule "${anchor.ruleId}" clause ${anchor.clause.clause_id} (${headingPath}): "${clauseText}"`;
    const rationale = ruleRationales.get(anchor.ruleId);
    const impact = rationale !== undefined && rationale.length > 0 ? rationale : DEFAULT_IMPACT_TEMPLATE;
    const suggestedFix = `Bring ${group.length > 1 ? "these hunks" : "this hunk"} in line with rule "${anchor.ruleId}" clause ${anchor.clause.clause_id}: "${clauseText}".`;
    const evidence = [
      `hunks: ${hunkList.join(", ")}`,
      `Jev violation probability (max across hunks): ${worst.probability.toFixed(2)} (threshold ${threshold})`,
    ].join("; ");
    const classScope =
      severity === "major" || severity === "blocker"
        ? {
            sites: group.map((c) => `${c.region.path}:${c.region.startLine}-${c.region.endLine}`),
            enumeration_method: `every hunk this run scored against rule "${anchor.ruleId}" clause ${anchor.clause.clause_id} in ${anchor.region.path} — grouped by (rule, clause, file) construction, not by inspection`,
          }
        : undefined;
    findings.push({
      id: `jev-rules-${shortHash(key)}`,
      severity,
      file: anchor.region.path,
      line: anchor.region.startLine,
      quote: firstChangedLineQuote(anchor.region),
      problem,
      impact,
      suggested_fix: suggestedFix,
      evidence,
      confidence,
      reviewer: "review-jev-rules",
      dedupe_key: key,
      ...(classScope !== undefined ? { class_scope: classScope } : {}),
    });
  }
  return findings;
}

export function findingStats(findings: readonly RuleFinding[]): Readonly<Record<RuleFindingSeverity, number>> {
  const stats: Record<RuleFindingSeverity, number> = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const finding of findings) stats[finding.severity] += 1;
  return stats;
}

// ---------------------------------------------------------------------------
// Rendering — the non-`--json` text a human reads.
// ---------------------------------------------------------------------------

export interface JevRulesRunResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-rules";
  readonly summary: string;
  readonly findings: readonly RuleFinding[];
  readonly stats: Readonly<Record<RuleFindingSeverity, number>>;
}

export function renderJevRulesMarkdown(result: JevRulesRunResult): string {
  const lines: string[] = [
    "# review-jev-rules",
    "",
    `status: ${result.status}`,
    result.summary,
    "",
    `stats: blocker=${result.stats.blocker}, major=${result.stats.major}, minor=${result.stats.minor}, info=${result.stats.info}`,
    "",
  ];
  if (result.findings.length === 0) {
    lines.push("_no findings at or above threshold_");
    return `${lines.join("\n")}\n`;
  }
  for (const finding of result.findings) {
    lines.push(`## [${finding.id}] ${finding.severity} — ${finding.file}:${finding.line}`);
    lines.push("");
    lines.push(`- **Problem**: ${finding.problem}`);
    lines.push(`- **Impact**: ${finding.impact}`);
    lines.push(`- **Suggested fix**: ${finding.suggested_fix}`);
    lines.push(`- **Evidence**: ${finding.evidence}`);
    lines.push(`- **Confidence**: ${finding.confidence}`);
    lines.push(`- **Quote**: \`${finding.quote}\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
