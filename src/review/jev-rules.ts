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
//   - every file under `.metaproject/rules/**` or `rules/**` (this
//     repository's own hand-written `.mdc`/`.md` rule corpus — exactly what
//     AC9's live check runs against);
//   - a project-skill or installed gdskill whose directory name contains
//     "convention" (case-insensitive), or whose frontmatter declares
//     `metadata.category: conventions` — the one category value this
//     mechanism is ready to recognise the day a skill author writes it;
//   - anything passed via `--rules <paths>`, unconditionally.
//
// `isCodingConventionSkill` below is the one place this decision lives, so a
// future author extending it has one function to change, not a scattered
// heuristic.
import { extractReferenceClauses, type RawReferenceClause } from "./conform-clauses";
import { hunkClauseFacts, hunkRedactedStateText } from "./conform-state";
import { estimateTokens } from "./cost";
import type { ScopedRegion } from "./scope";
import { scopeReviewerByStack, type DetectedStack, type StackTag } from "./stack";
import { redactSensitiveText } from "../security/service";

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

const RATIONALE_HEADING_RE = /rationale|why|purpose|reason/i;

/** AC4's "the rule's stated rationale if present": the text of the first clause whose nearest heading names one of rationale/why/purpose/reason. `undefined` when the rule states none — the caller then falls back to `DEFAULT_IMPACT_TEMPLATE`. */
export function extractRuleRationale(ruleText: string): string | undefined {
  const clause = extractReferenceClauses(ruleText).find((c) => c.heading_path.some((heading) => RATIONALE_HEADING_RE.test(heading)));
  return clause?.text;
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
// Pair selection (AC3): every (region, rule clause) pair the applicability
// decision admits, capped at `--max-calls`, deterministic order, nothing
// dropped silently.
// ---------------------------------------------------------------------------

/** Default `--max-calls`: bounds a single run to a budget an operator can afford without thinking about it, matching the order of magnitude AC9's live check uses (~150 Jev calls total across two PRs). */
export const DEFAULT_MAX_JEV_RULE_CALLS = 150;

export interface RuleHunkPair {
  readonly region: ScopedRegion;
  readonly ruleId: string;
  readonly clause: RawReferenceClause;
  readonly reason: string;
}

export interface PairSelectionResult {
  readonly selected: readonly RuleHunkPair[];
  readonly dropped: readonly RuleHunkPair[];
  readonly notApplicable: readonly { readonly region: ScopedRegion; readonly ruleId: string; readonly reason: string }[];
  readonly maxCalls: number;
}

/**
 * AC3: build every applicable (hunk, clause) pair and cap it at `maxCalls`.
 * Order is deterministic — regions in input order (already the diff's own
 * order), rule sources sorted by path, clauses in extraction order — so the
 * SAME diff and SAME rule set always select the SAME pairs, and a caller
 * re-running with a smaller `--max-calls` sees a stable prefix drop from the
 * tail, not a different sample.
 */
export function selectRuleHunkPairs(
  regions: readonly ScopedRegion[],
  sources: readonly RuleSourceFile[],
  detectedStack: DetectedStack,
  maxCalls: number = DEFAULT_MAX_JEV_RULE_CALLS,
): PairSelectionResult {
  const sortedSources = [...sources].sort((a, b) => a.path.localeCompare(b.path));
  const all: RuleHunkPair[] = [];
  const notApplicable: { readonly region: ScopedRegion; readonly ruleId: string; readonly reason: string }[] = [];
  for (const region of regions) {
    for (const source of sortedSources) {
      const decision = clauseApplicability(source, region.path, detectedStack);
      if (!decision.applicable) {
        notApplicable.push({ region, ruleId: source.path, reason: decision.reason });
        continue;
      }
      for (const clause of extractReferenceClauses(source.text)) {
        all.push({ region, ruleId: source.path, clause, reason: decision.reason });
      }
    }
  }
  const cap = Number.isFinite(maxCalls) && maxCalls >= 0 ? Math.trunc(maxCalls) : DEFAULT_MAX_JEV_RULE_CALLS;
  return { selected: all.slice(0, cap), dropped: all.slice(cap), notApplicable, maxCalls: cap };
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
function questionFor(ruleId: string, clause: RawReferenceClause): RuleNoulQuestion {
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
  readonly clause: RawReferenceClause;
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
