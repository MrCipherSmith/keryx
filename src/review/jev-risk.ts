// review-jev-risk — flow 332, AC1/AC2 of the frozen acceptance criteria
// (`.metaproject/flows/332-*/acceptance-criteria.md`).
//
// A RISK MAP of a diff: for every retained hunk (`buildReviewScope`/
// `hunkRegionsFromDiff`), keryx computes deterministic facts FIRST (path
// class, touched exported symbols, lines changed, whether a test file in the
// same diff touches the same module), then asks Jev ("System One") one
// `noul` question per RISK DIMENSION — security-sensitive, data/migration,
// public-API/contract change, concurrency, error-handling — never a prose
// question. keryx ranks hunks by the combined answer and writes every word
// of every finding; Jev supplies only five probabilities per hunk.
//
// CORE ZONE (`src/lib/import-zones.ts`): this module never imports the
// client-zone Jev client (`src/harness/decision/jev-client.ts`) — the same
// discipline `src/review/ci-triage.ts`, `src/review/conform-jev.ts` and flow
// 330's `src/review/jev-rules.ts` already established (see any of their own
// headers). The question/answer shapes below are chosen to satisfy
// `JevQuestion`/`JevAnswer` structurally with no import needed;
// `src/commands/review-jev-risk.ts` (the ADAPTER) is where the two meet.
//
// Through the security facade, not `security/redact` directly — the
// import-policy ratchet (`src/lib/import-policy.live.test.ts`) is at its
// cap, and every caller outside `src/security/` reaches redaction through
// `src/security/service.ts` (see `conform-jev.ts`'s own note on this).
//
// Two decisions recorded from the live check on #712/#717 (149 calls,
// $0.007; flow 332 journal):
//
// 1. **Docs hunks never reach any risk dimension, not even `public-api`.**
//    All four findings from that run were `cli-reference.md` prose hunks
//    describing a new CLI flag, scored high on `public-api` — Jev correctly
//    answered "does this text describe a public API" when the question
//    meant "is this HUNK a code risk to a public API". Those are different
//    claims, and a `.md`/`.txt` hunk can only ever supply evidence for the
//    first. The code that actually enacts the documented change is its own
//    hunk elsewhere in the same diff and gets scored there — scoring the
//    prose too is pure duplicate noise, never additional signal, so it is
//    excluded from selection entirely (`isNonCodeHunk`/`selectRiskHunks`)
//    rather than merely down-ranked.
// 2. **`hasNearbyTest` requires evidence, not just proximity.** A directory-
//    or stem-adjacent test file changed in the same diff used to be enough
//    to suppress a finding outright — which is how `providers.ts:723-733`
//    (new `boundedJsonBody`, p=0.89) went unflagged: some OTHER test in
//    `providers.test.ts` changed for an unrelated reason, and proximity
//    alone read that as coverage. A nearby test now only counts when its
//    OWN diff text mentions one of the hunk's touched exported symbols
//    (`touchedExportedSymbols`) or imports the hunk's module by path stem
//    (`testHunkEvidence`). Proximity is still reported as a fact
//    (`nearbyTestFiles`) — it is just no longer sufficient on its own to
//    suppress a finding.

import { hunkClauseFacts, hunkRedactedStateText } from "./conform-state";
import { estimateTokens } from "./cost";
import type { ScopedRegion } from "./scope";

// ---------------------------------------------------------------------------
// AC1: deterministic path classification — a heuristic word/pattern list,
// same discipline as `scope.ts`'s own path classifier: documented, and
// failing toward INCLUSION (a false "no class matched" costs nothing but a
// slightly less specific risk map; a false negative on a real auth path
// would hide the exact kind of change this reviewer exists to surface).
// ---------------------------------------------------------------------------

export const RISK_PATH_CLASSES = [
  "auth/permissions",
  "crypto",
  "migrations",
  "schema",
  "public API",
  "config",
  "concurrency primitives",
  "IO",
] as const;
export type RiskPathClass = (typeof RISK_PATH_CLASSES)[number];

const PATH_PATTERNS: ReadonlyArray<{ readonly cls: RiskPathClass; readonly re: RegExp }> = [
  { cls: "auth/permissions", re: /\b(auth|login|session|permission|acl|rbac|authz|authn|credential)\w*/i },
  { cls: "crypto", re: /\b(crypto|cipher|encrypt|decrypt|hmac|jwt)\w*/i },
  { cls: "migrations", re: /migrat/i },
  { cls: "schema", re: /schema/i },
  { cls: "config", re: /config/i },
];

// Content-based classes: the path alone cannot tell a lock-file-shaped
// module apart from one that merely mentions concurrency in passing, so
// these are matched against the hunk's own changed text instead.
const CONTENT_PATTERNS: ReadonlyArray<{ readonly cls: RiskPathClass; readonly re: RegExp }> = [
  {
    cls: "concurrency primitives",
    re: /\b(mutex|semaphore|AbortController|Promise\.all|Promise\.race|Promise\.allSettled|async\s+function|await\s|race condition|atomic)\b/i,
  },
  { cls: "IO", re: /\b(readFile|writeFile|fetch\(|Bun\.spawn|child_process|net\.\w+\(|fs\.\w+\(|http\.\w+\(|https\.\w+\(|Bun\.file)\b/ },
];

/** A public-API-shaped path: an entry point, a wire/contract surface, or a directory literally named `api`. */
const PUBLIC_API_PATH_RE = /(^|\/)(index\.ts|api\.ts|[\w-]+-api\.ts)$|\bapi\b/i;

export interface RiskPathClassification {
  readonly classes: readonly RiskPathClass[];
  /** One human-readable line per matched class, ready to place in `factLines`. */
  readonly detail: readonly string[];
}

/**
 * AC1's path class fact. Path-based classes are matched against the hunk's
 * file path; `public API` additionally fires when the hunk touches an
 * exported symbol (see {@link touchedExportedSymbols}), since an exported
 * declaration IS a public API surface regardless of where the file lives;
 * `concurrency primitives`/`IO` are matched against the hunk's own changed
 * text. A hunk can carry more than one class — nothing here is exclusive.
 */
export function classifyHunkRiskPath(region: ScopedRegion, exportedSymbolCount: number): RiskPathClassification {
  const classes: RiskPathClass[] = [];
  const detail: string[] = [];
  for (const { cls, re } of PATH_PATTERNS) {
    if (re.test(region.path)) {
      classes.push(cls);
      detail.push(`path class "${cls}": path matches ${re}`);
    }
  }
  const publicApiByPath = PUBLIC_API_PATH_RE.test(region.path);
  const publicApiBySymbol = exportedSymbolCount > 0;
  if (publicApiByPath || publicApiBySymbol) {
    classes.push("public API");
    detail.push(
      `path class "public API": ${publicApiByPath ? "path looks like an entry point/contract surface" : ""}${
        publicApiByPath && publicApiBySymbol ? "; " : ""
      }${publicApiBySymbol ? `${exportedSymbolCount} exported symbol(s) touched` : ""}`,
    );
  }
  for (const { cls, re } of CONTENT_PATTERNS) {
    if (re.test(region.text)) {
      classes.push(cls);
      detail.push(`path class "${cls}": changed text matches ${re}`);
    }
  }
  return { classes, detail };
}

// ---------------------------------------------------------------------------
// AC1: touched exported symbols — a deterministic, regex-based (never a
// parser) list of identifiers a hunk's changed lines EXPORT. Over/under-match
// is expected and documented, same discipline as `jev-rules.ts`'s own
// `symbolsTouched` (this is a fact reported alongside the hunk, not a claim
// the hunk's semantics were parsed).
// ---------------------------------------------------------------------------

const EXPORTED_DECLARATION_RE = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const MAX_TOUCHED_SYMBOLS = 20;

/** Exported identifiers a hunk's ADDED or REMOVED lines declare — a fact, not a claim of full parsing. */
export function touchedExportedSymbols(regionText: string): readonly string[] {
  const symbols = new Set<string>();
  for (const line of regionText.split("\n")) {
    if (line.length === 0 || (line[0] !== "+" && line[0] !== "-")) continue;
    for (const match of line.matchAll(EXPORTED_DECLARATION_RE)) {
      if (symbols.size >= MAX_TOUCHED_SYMBOLS) break;
      if (match[1] !== undefined) symbols.add(match[1]);
    }
  }
  return [...symbols];
}

// ---------------------------------------------------------------------------
// AC1: "test files touched nearby" — a fact over the WHOLE diff's changed
// file set, not just this hunk: does any OTHER changed file in the same run
// look like a test for this hunk's module (same directory, or same
// filename stem with a `.test.`/`.spec.` infix)?
// ---------------------------------------------------------------------------

const TEST_INFIX_RE = /\.(test|spec)\./;
const TEST_DIR_RE = /(^|\/)(__tests__|tests?)\//;

/** A path that IS a test file — a `.test.`/`.spec.` infix, or living under a `__tests__`/`test(s)` directory. Shared by `testFilesTouchedNearby` (a test CANDIDATE for another hunk's evidence) and, below, the routing-hint/finding suppression that keeps a test file's OWN hunk from independently producing either (the noise item 2 fix, flow's live check on #743's `task-cost.test.ts`). */
export function isTestFilePath(path: string): boolean {
  return TEST_INFIX_RE.test(path) || TEST_DIR_RE.test(path);
}

function stemOf(filePath: string): string {
  const base = filePath.split("/").at(-1) ?? filePath;
  return base.replace(/\.(test|spec)\.[jt]sx?$/, "").replace(/\.[jt]sx?$/, "");
}

function dirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx < 0 ? "" : filePath.slice(0, idx);
}

/** AC1/AC2's "test file(s) touched nearby" fact: any OTHER changed path that is a test AND shares this hunk's stem or directory. */
export function testFilesTouchedNearby(regionPath: string, allChangedFiles: readonly string[]): readonly string[] {
  const stem = stemOf(regionPath);
  const dir = dirOf(regionPath);
  return allChangedFiles.filter((file) => {
    if (file === regionPath) return false;
    if (!isTestFilePath(file)) return false;
    return stemOf(file) === stem || dirOf(file) === dir;
  });
}

function escapeForIdentifierRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-identifier match — `\b` alone under-anchors when `symbol` starts or
 * ends with `$` (a valid identifier character `\b` does not treat as a word
 * character), so the boundary is asserted explicitly on both sides instead.
 */
function mentionsIdentifier(text: string, identifier: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escapeForIdentifierRegex(identifier)}(?![A-Za-z0-9_$])`);
  return re.test(text);
}

/**
 * AC1/AC2 (tightened, see the file header's decision 2): whether a
 * PROXIMATE test file's own changed text gives actual evidence it reaches
 * this hunk — it mentions one of the hunk's touched exported symbols as a
 * whole identifier, or it imports a module whose path ends in the hunk's
 * own file stem (`from "../providers"`-shaped). Proximity
 * (`testFilesTouchedNearby`) only produces CANDIDATES; this decides which
 * candidates actually count.
 */
export function testHunkEvidence(testFileText: string, symbols: readonly string[], moduleStem: string): boolean {
  // A mention in a comment ("// still need to cover boundedJsonBody") is not
  // evidence the test exercises the symbol: comment text is stripped first,
  // line (`//`) and block (`/* */`, `*`-continued) alike.
  testFileText = testFileText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").replace(/^([+\- ]?)\s*\*.*$/, "$1"))
    .join("\n");
  if (symbols.some((symbol) => mentionsIdentifier(testFileText, symbol))) return true;
  const importRe = new RegExp(`from\\s*["'][^"']*/${escapeForIdentifierRegex(moduleStem)}(\\.[jt]sx?)?["']`);
  return importRe.test(testFileText);
}

// ---------------------------------------------------------------------------
// AC1: deterministic facts per hunk, assembled before any Jev question.
// ---------------------------------------------------------------------------

export interface RiskHunkFacts {
  readonly region: ScopedRegion;
  readonly pathClasses: readonly RiskPathClass[];
  readonly exportedSymbols: readonly string[];
  readonly changedLines: number;
  readonly nearbyTestFiles: readonly string[];
  /** Subset of `nearbyTestFiles` whose OWN diff text gives evidence it reaches this hunk (`testHunkEvidence`). */
  readonly evidencedTestFiles: readonly string[];
  readonly hasNearbyTest: boolean;
  /** Ready to place in `state`, above the redacted hunk text — the lesson `conform-state.ts`'s own header records. */
  readonly factLines: readonly string[];
}

/**
 * `path -> that path's own changed (added/removed) diff text`, used only to
 * look up a nearby test candidate's text for `testHunkEvidence`. Built by
 * the adapter from every retained region (not just the ones selected for
 * scoring) — a test file's own hunk may sort past `--max-calls` and still
 * be available as evidence. Absent or an empty map means no evidence was
 * supplied for any candidate, which fails toward NOT suppressing a finding
 * (the same "false retain over false drop" discipline `scope.ts` documents
 * for itself), not toward the old proximity-only behaviour.
 */
export type NearbyTestTextByPath = ReadonlyMap<string, string>;

export function computeHunkRiskFacts(
  region: ScopedRegion,
  allChangedFiles: readonly string[],
  nearbyTestText: NearbyTestTextByPath = new Map(),
): RiskHunkFacts {
  const exportedSymbols = touchedExportedSymbols(region.text);
  const pathClassification = classifyHunkRiskPath(region, exportedSymbols.length);
  const nearbyTestFiles = testFilesTouchedNearby(region.path, allChangedFiles);
  const moduleStem = stemOf(region.path);
  const evidencedTestFiles = nearbyTestFiles.filter((testPath) => {
    const text = nearbyTestText.get(testPath);
    return text !== undefined && testHunkEvidence(text, exportedSymbols, moduleStem);
  });
  const factLines = [
    ...hunkClauseFacts(region).factLines,
    `path class(es): ${pathClassification.classes.length > 0 ? pathClassification.classes.join(", ") : "(none matched)"}`,
    ...pathClassification.detail,
    `exported symbols touched: ${exportedSymbols.length > 0 ? exportedSymbols.join(", ") : "(none matched)"}`,
    `test file(s) touched nearby in this diff: ${nearbyTestFiles.length > 0 ? nearbyTestFiles.join(", ") : "(none)"}`,
    `nearby test(s) with evidence covering this hunk: ${evidencedTestFiles.length > 0 ? evidencedTestFiles.join(", ") : "(none)"}`,
  ];
  return {
    region,
    pathClasses: pathClassification.classes,
    exportedSymbols,
    changedLines: region.changedLines,
    nearbyTestFiles,
    evidencedTestFiles,
    hasNearbyTest: evidencedTestFiles.length > 0,
    factLines,
  };
}

// ---------------------------------------------------------------------------
// AC1: risk dimensions and Jev questions — one `noul` per dimension per hunk,
// batched into as few requests as fit the vendor's 64k budget (mirrors
// `conform-jev.ts`/`jev-rules.ts`'s own `batchConformItems`/
// `batchRulePairsForRegion` pattern).
// ---------------------------------------------------------------------------

export const RISK_DIMENSIONS = ["security", "data-migration", "public-api", "concurrency", "error-handling"] as const;
export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

const DIMENSION_INSTRUCTIONS: Readonly<Record<RiskDimension, string>> = {
  security:
    "Given the deterministic facts and the hunk above, how likely is this change SECURITY-SENSITIVE — it touches " +
    "authentication, authorization/permissions, cryptography, secrets, input validation, or a trust boundary?",
  "data-migration":
    "Given the deterministic facts and the hunk above, how likely is this change to affect DATA or a MIGRATION — a " +
    "schema change, a data migration, or the shape of stored/persisted data?",
  "public-api":
    "Given the deterministic facts and the hunk above, how likely is this change to alter a PUBLIC API or CONTRACT — " +
    "an exported function/type signature, a wire format, a CLI flag, or anything a caller outside this hunk depends on — in a way that breaks a caller?",
  concurrency:
    "Given the deterministic facts and the hunk above, how likely is this change to touch CONCURRENCY — locking, " +
    "async ordering, shared mutable state, or a race condition?",
  "error-handling":
    "Given the deterministic facts and the hunk above, how likely is this change to alter ERROR HANDLING — how a " +
    "failure is caught, reported, retried, or recovered from?",
};

export interface RiskNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

export function riskQuestionKey(dimension: RiskDimension): string {
  return dimension;
}

export function riskQuestionsFor(): Readonly<Record<RiskDimension, RiskNoulQuestion>> {
  return {
    security: { type: "noul", instructions: DIMENSION_INSTRUCTIONS.security },
    "data-migration": { type: "noul", instructions: DIMENSION_INSTRUCTIONS["data-migration"] },
    "public-api": { type: "noul", instructions: DIMENSION_INSTRUCTIONS["public-api"] },
    concurrency: { type: "noul", instructions: DIMENSION_INSTRUCTIONS.concurrency },
    "error-handling": { type: "noul", instructions: DIMENSION_INSTRUCTIONS["error-handling"] },
  };
}

export const RISK_TOKEN_BUDGET = 64_000;
const QUESTIONS_BUDGET_FRACTION = 0.5;

export interface RiskBatch {
  readonly facts: RiskHunkFacts;
  readonly dimensions: readonly RiskDimension[];
  readonly state: string;
  readonly questions: Readonly<Record<string, RiskNoulQuestion>>;
}

/**
 * AC1: one hunk's five dimension questions, split across requests only when
 * the 64k budget genuinely requires it (in practice all five fit in one
 * request every time — five short instructions is nowhere near 32k tokens —
 * but the split logic mirrors every sibling Jev batcher rather than assuming
 * that fact will always hold).
 */
export function batchRiskQuestionsForHunk(facts: RiskHunkFacts): RiskBatch[] {
  const sharedRedactedText = hunkRedactedStateText(facts.region);
  const sharedTokens = estimateTokens(sharedRedactedText);
  const stateHeader = [...facts.factLines, "", "--- state ---", sharedRedactedText].join("\n");
  const allQuestions = riskQuestionsFor();
  const batches: RiskBatch[] = [];
  let current: RiskDimension[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      facts,
      dimensions: current,
      state: stateHeader,
      questions: Object.fromEntries(current.map((dimension) => [riskQuestionKey(dimension), allQuestions[dimension]])),
    });
    current = [];
  };

  for (const dimension of RISK_DIMENSIONS) {
    const attempt = [...current, dimension];
    const questionsTokens = estimateTokens(attempt.map((d) => `${d}:noul:${allQuestions[d].instructions}`).join("\n"));
    const total = sharedTokens + questionsTokens;
    const withinShare = questionsTokens <= RISK_TOKEN_BUDGET * QUESTIONS_BUDGET_FRACTION;
    if (current.length > 0 && (total > RISK_TOKEN_BUDGET || !withinShare)) {
      flush();
      current = [dimension];
    } else {
      current = attempt;
    }
  }
  flush();
  return batches;
}

// ---------------------------------------------------------------------------
// AC1 (tightened, see the file header's decision 1): docs hunks never reach
// any risk dimension — not scored, not counted against `--max-calls`,
// reported separately as "not a code hunk".
// ---------------------------------------------------------------------------

const NON_CODE_HUNK_RE = /\.(md|txt)$/i;
/**
 * Flow-bookkeeping and generated review metadata — state the review/flow
 * process itself writes and reads (a flow's `flow.json`, saved review
 * output, cached data), never hand-authored source the risk dimensions were
 * designed to judge. The live check against PR #743 (this reviewer's own
 * default settings) flagged a flow's `flow.json` (under `.metaproject/flows/`)
 * as a data-migration risk — a JSON bookkeeping record, not a schema or migration
 * — because its own text can legitimately QUOTE words like "migration" or
 * "schema" from a task description it is merely recording. Unconditionally
 * excluded, with NO fixtures-directory exception (unlike the `.md`/`.txt`
 * rule below): this bookkeeping is never itself the code under review,
 * whatever directory it sits in.
 */
const GENERATED_METADATA_PATH_RE = /(^|\/)\.metaproject\/(flows|data|reviews)\//;

/** A `.md`/`.txt` path, or flow-bookkeeping/generated-metadata under `.metaproject/`  — prose or process state, never itself the code a risk dimension is asking about. */
export function isNonCodeHunk(path: string): boolean {
  if (GENERATED_METADATA_PATH_RE.test(path)) return true;
  // A `.txt` under a fixtures/testdata/snapshots directory is test data whose
  // change can carry real behavioural risk — it stays scored.
  if (/(^|\/)(__fixtures__|fixtures|testdata|__snapshots__|snapshots)\//.test(path)) return false;
  return NON_CODE_HUNK_RE.test(path);
}

// ---------------------------------------------------------------------------
// AC1: budget — `--max-calls` bounds (hunk, dimension) PAIRS, the same unit
// flow 330's `jev-rules.ts` `--max-calls` already counts. A prefix of the
// diff-ordered hunks is kept (deterministic), the rest are reported as
// skipped rather than silently dropped.
// ---------------------------------------------------------------------------

/** Default `--max-calls`: five dimensions x 30 hunks, the same order of magnitude as `jev-rules.ts`'s own `DEFAULT_MAX_JEV_RULE_CALLS`. */
export const DEFAULT_MAX_JEV_RISK_CALLS = 150;

export interface RiskHunkSelection {
  readonly selected: readonly ScopedRegion[];
  readonly skipped: readonly ScopedRegion[];
  /** Docs (`.md`/`.txt`) hunks — excluded before the budget is even applied; see `isNonCodeHunk`. */
  readonly notCode: readonly ScopedRegion[];
  readonly maxCalls: number;
  readonly pairsSelected: number;
  readonly pairsSkipped: number;
}

/** AC1: cap the number of (hunk, dimension) questions a run sends — every hunk gets all five dimensions or none. Docs hunks are removed first and never consume budget. */
export function selectRiskHunks(regions: readonly ScopedRegion[], maxCalls: number = DEFAULT_MAX_JEV_RISK_CALLS): RiskHunkSelection {
  const cap = Number.isFinite(maxCalls) && maxCalls >= 0 ? Math.trunc(maxCalls) : DEFAULT_MAX_JEV_RISK_CALLS;
  const notCode = regions.filter((region) => isNonCodeHunk(region.path));
  const codeRegions = regions.filter((region) => !isNonCodeHunk(region.path));
  const maxHunks = Math.floor(cap / RISK_DIMENSIONS.length);
  const selected = codeRegions.slice(0, maxHunks);
  const skipped = codeRegions.slice(maxHunks);
  return {
    selected,
    skipped,
    notCode,
    maxCalls: cap,
    pairsSelected: selected.length * RISK_DIMENSIONS.length,
    pairsSkipped: skipped.length * RISK_DIMENSIONS.length,
  };
}

// ---------------------------------------------------------------------------
// AC1/AC2: ranking, findings and the routing hint — deterministic, pure,
// over already-scored hunks (the adapter is where the Jev answers land).
// ---------------------------------------------------------------------------

/** Default: a hunk/dimension counts as "above threshold" from 0.7 up — same order of magnitude as the rest of this codebase's Jev thresholds (`DEFAULT_CONFORM_THRESHOLD`/`DEFAULT_JEV_RULES_THRESHOLD` use 0.5 for a binary satisfied/violated call; a risk FLAG is deliberately a higher bar, since it is advisory attention rather than a violation verdict). */
export const DEFAULT_JEV_RISK_THRESHOLD = 0.7;

export interface ScoredRiskHunk {
  readonly facts: RiskHunkFacts;
  readonly probabilities: Readonly<Record<RiskDimension, number>>;
  /** The combined score hunks are ranked by — the MAX across dimensions: any one high-risk dimension is enough to draw attention, so averaging would dilute exactly the signal this map exists to surface. */
  readonly combinedRisk: number;
  readonly topDimension: RiskDimension;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export function scoreHunk(facts: RiskHunkFacts, answers: Readonly<Record<string, { readonly noul?: number }>>): ScoredRiskHunk {
  const probabilities = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, clamp01(answers[d]?.noul ?? 0)])) as Record<RiskDimension, number>;
  let topDimension: RiskDimension = RISK_DIMENSIONS[0];
  for (const dimension of RISK_DIMENSIONS) {
    if (probabilities[dimension] > probabilities[topDimension]) topDimension = dimension;
  }
  return { facts, probabilities, combinedRisk: probabilities[topDimension], topDimension };
}

/** AC1: rank hunks by combined risk, descending — ties broken by the hunks' own diff order (stable sort over the input order). */
export function rankHunksByRisk(scored: readonly ScoredRiskHunk[]): readonly ScoredRiskHunk[] {
  return [...scored].map((hunk, index) => ({ hunk, index })).sort((a, b) => b.hunk.combinedRisk - a.hunk.combinedRisk || a.index - b.index).map((e) => e.hunk);
}

export type RiskFindingSeverity = "info" | "minor";

export interface RiskFinding {
  readonly id: string;
  readonly severity: RiskFindingSeverity;
  readonly file: string;
  readonly line: number;
  readonly quote: string;
  readonly problem: string;
  readonly impact: string;
  readonly suggested_fix: string;
  readonly evidence: string;
  readonly confidence: "high" | "medium" | "low";
  readonly reviewer: "review-jev-risk";
  readonly dedupe_key: string;
}

function shortHash(input: string): string {
  // FNV-1a 32-bit — deterministic, dependency-free, matches `jev-rules.ts`'s own `shortHash`.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function firstChangedLineQuote(region: ScopedRegion): string {
  for (const line of region.text.split("\n")) {
    if (line.length === 0) continue;
    const marker = line[0];
    if (marker !== "+" && marker !== "-") continue;
    const content = line.slice(1).trim();
    if (content.length > 0) return content;
  }
  return region.text.trim().slice(0, 200);
}

function confidenceFor(probability: number): "high" | "medium" | "low" {
  const certainty = Math.max(probability, 1 - probability);
  if (certainty >= 0.85) return "high";
  if (certainty >= 0.65) return "medium";
  return "low";
}

const IMPACT_TEMPLATE =
  "A high-risk hunk with no test in the same diff exercising its module is the shape of change most likely to " +
  "regress silently: nobody but a careful human reviewer will notice before it ships.";

/**
 * AC2: emit a finding ONLY for a hunk above `threshold` AND with no test
 * touched nearby (a fact, `RiskHunkFacts.hasNearbyTest`) — severity capped at
 * `minor` (never higher: this flags attention, it does not assert a defect).
 * Prose is synthesized deterministically here; Jev supplied only the five
 * probabilities that decided which hunks qualify.
 */
export function synthesizeRiskFindings(scored: readonly ScoredRiskHunk[], threshold: number = DEFAULT_JEV_RISK_THRESHOLD): readonly RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (const hunk of rankHunksByRisk(scored)) {
    if (hunk.combinedRisk < threshold || hunk.facts.hasNearbyTest) continue;
    // A test file's OWN hunk never produces a finding on its own (noise item
    // 2, flow's live check on #743's `task-cost.test.ts`): the risk this
    // dimension is meant to surface belongs to the PRODUCTION file the test
    // exercises — if that file's own hunk is in this same diff, it is scored
    // and reported on its own facts; the test's hunk is still scored (it can
    // still count as evidence via `testHunkEvidence`) but is not itself a
    // second, duplicate source of a finding.
    if (isTestFilePath(hunk.facts.region.path)) continue;
    const { region } = hunk.facts;
    const key = `jev-risk::${region.path}:${region.startLine}-${region.endLine}`;
    const severity: RiskFindingSeverity = hunk.combinedRisk >= 0.85 ? "minor" : "info";
    const dims = RISK_DIMENSIONS.filter((d) => hunk.probabilities[d] >= threshold);
    findings.push({
      id: `jev-risk-${shortHash(key)}`,
      severity,
      file: region.path,
      line: region.startLine,
      quote: firstChangedLineQuote(region),
      problem:
        `This hunk scores high risk (${dims.join(", ") || hunk.topDimension}, top ${hunk.topDimension}=${hunk.combinedRisk.toFixed(2)}) ` +
        `and no test file in this diff touches ${region.path}'s module.`,
      impact: IMPACT_TEMPLATE,
      suggested_fix: `Add or extend a test that exercises ${region.path} near lines ${region.startLine}-${region.endLine}, or have a reviewer look here first.`,
      evidence: `path class(es): ${hunk.facts.pathClasses.join(", ") || "(none)"}; probabilities: ${RISK_DIMENSIONS.map(
        (d) => `${d}=${hunk.probabilities[d].toFixed(2)}`,
      ).join(", ")} (threshold ${threshold})`,
      confidence: confidenceFor(hunk.combinedRisk),
      reviewer: "review-jev-risk",
      dedupe_key: key,
    });
  }
  return findings;
}

export function riskFindingStats(findings: readonly RiskFinding[]): Readonly<Record<"blocker" | "major" | "minor" | "info", number>> {
  const stats = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const finding of findings) stats[finding.severity] += 1;
  return stats;
}

// ---------------------------------------------------------------------------
// AC2: routing hint — hunks above threshold with a security/concurrency
// dimension, listed for the orchestrator to consider dispatching
// `review-security-code`/`review-highload` at (documented in
// `review-orchestrator/SKILL.md`'s own "CLI-engine reviewers" section).
// A hint is independent of whether a finding was emitted for the same hunk
// (a hunk WITH a nearby test still routes, since the routing question is
// "should a specialist look", not "is there evidence of an actual gap").
// ---------------------------------------------------------------------------

export interface RiskRoutingHint {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly dimension: "security" | "concurrency";
  readonly probability: number;
  readonly suggestedReviewer: "review-security-code" | "review-highload";
}

export function computeRiskRoutingHints(scored: readonly ScoredRiskHunk[], threshold: number = DEFAULT_JEV_RISK_THRESHOLD): readonly RiskRoutingHint[] {
  const hints: RiskRoutingHint[] = [];
  for (const hunk of rankHunksByRisk(scored)) {
    // Same rule `synthesizeRiskFindings` applies, for the same reason: a
    // test file's own hunk never produces a routing hint on its own — the
    // hint belongs to the production file the test exercises, whose own
    // hunk (if in this same diff) is scored and hinted independently.
    if (isTestFilePath(hunk.facts.region.path)) continue;
    const { region } = hunk.facts;
    if (hunk.probabilities.security >= threshold) {
      hints.push({ file: region.path, startLine: region.startLine, endLine: region.endLine, dimension: "security", probability: hunk.probabilities.security, suggestedReviewer: "review-security-code" });
    }
    if (hunk.probabilities.concurrency >= threshold) {
      hints.push({ file: region.path, startLine: region.startLine, endLine: region.endLine, dimension: "concurrency", probability: hunk.probabilities.concurrency, suggestedReviewer: "review-highload" });
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Rendering — the non-`--json` text a human reads.
// ---------------------------------------------------------------------------

export interface JevRiskRunResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-risk";
  readonly summary: string;
  readonly findings: readonly RiskFinding[];
  readonly stats: Readonly<Record<"blocker" | "major" | "minor" | "info", number>>;
  readonly ranked: readonly { readonly file: string; readonly startLine: number; readonly endLine: number; readonly combinedRisk: number; readonly topDimension: RiskDimension }[];
  readonly routingHints: readonly RiskRoutingHint[];
}

export function renderRiskMarkdown(result: JevRiskRunResult): string {
  const lines: string[] = ["# review-jev-risk", "", `status: ${result.status}`, result.summary, "", `stats: blocker=0, major=0, minor=${result.stats.minor}, info=${result.stats.info}`, ""];
  lines.push("## Risk map (ranked, highest first)", "");
  if (result.ranked.length === 0) {
    lines.push("_no hunks scored_", "");
  } else {
    for (const hunk of result.ranked) {
      lines.push(`- ${hunk.file}:${hunk.startLine}-${hunk.endLine} — combined risk ${hunk.combinedRisk.toFixed(2)} (top: ${hunk.topDimension})`);
    }
    lines.push("");
  }
  if (result.routingHints.length > 0) {
    lines.push("## Routing hints", "");
    for (const hint of result.routingHints) {
      lines.push(`- ${hint.file}:${hint.startLine}-${hint.endLine} — ${hint.dimension}=${hint.probability.toFixed(2)} -> consider dispatching \`${hint.suggestedReviewer}\``);
    }
    lines.push("");
  }
  if (result.findings.length === 0) {
    lines.push("_no findings at or above threshold with no nearby test_");
    return `${lines.join("\n")}\n`;
  }
  lines.push("## Findings", "");
  for (const finding of result.findings) {
    lines.push(`### [${finding.id}] ${finding.severity} — ${finding.file}:${finding.line}`, "");
    lines.push(`- **Problem**: ${finding.problem}`);
    lines.push(`- **Impact**: ${finding.impact}`);
    lines.push(`- **Suggested fix**: ${finding.suggested_fix}`);
    lines.push(`- **Evidence**: ${finding.evidence}`);
    lines.push(`- **Confidence**: ${finding.confidence}`);
    lines.push(`- **Quote**: \`${finding.quote}\``, "");
  }
  return `${lines.join("\n")}\n`;
}
