// review-jev-scenarios — flow 332, AC3/AC4 of the frozen acceptance criteria
// (`.metaproject/flows/332-*/acceptance-criteria.md`).
//
// FUNCTIONAL review: which USER SCENARIOS a PR likely changes. Scenario
// sources are gathered deterministically — gdwiki `user-scenario` pages,
// PRD `docs/requirements/**` requirement/scenario sections, and README/docs
// "how to" sections — each already carrying the code it links to (a
// markdown link or an inline code-span file reference, the same
// `extractCodePaths` convention `src/wiki/backlinks.ts` already established
// for the wiki's own code edges). For each scenario, keryx computes which of
// its linked files the diff actually touches (a fact); only a scenario with
// at least one touched link is asked, ONE Jev `noul`: "does this change
// alter this scenario's behaviour?". keryx writes every word of every
// finding; Jev supplies only a probability.
//
// CORE ZONE (`src/lib/import-zones.ts`): both `review` and `wiki` are core
// segments (core-to-core is allowed; only core->client/adapter is
// forbidden), so this module may import `src/wiki/backlinks.ts`'s pure
// `extractCodePaths`/`extractLinks` directly — but it never imports the
// client-zone Jev client (`src/harness/decision/jev-client.ts`), the same
// discipline every sibling Jev-backed core module already holds (see
// `src/review/jev-rules.ts`'s own header). `src/commands/review-jev-
// scenarios.ts` (the ADAPTER) is where file reads and the Jev client meet.
//
// Through the security facade, not `security/redact` directly — same
// discipline as `jev-risk.ts`/`jev-rules.ts`.
//
// Decision recorded from the live check on #712/#717 (flow 332 journal): a
// large, widely-referenced file such as `tui-shell.ts` gets LINKED from many
// unrelated scenarios (every "how to" section mentions the shell somewhere),
// so "this scenario links a file the diff touches" stops being evidence of
// anything once enough scenarios link the same file — it becomes a fact
// about the file's popularity, not about this scenario's behaviour. A link
// to a file with fan-in above `SCENARIO_LINK_FANOUT_THRESHOLD`
// (`computeLinkFanIn`) is down-weighted: it only still counts as "touched"
// when the scenario's own text names one of the diff's touched exported
// symbols for that file (`isTouchedLinkSignificant`, reusing
// `touchedExportedSymbols` from `jev-risk.ts` — the adapter supplies the
// per-path symbol map, the same way it supplies `nearbyTestText` there). A
// low-fan-in link is unaffected: most scenarios link one or two specific
// files, and for those the link IS the evidence.

import { extractCodePaths, extractLinks, resolveLink } from "../wiki/backlinks";
import { estimateTokens } from "./cost";
import { testFilesTouchedNearby } from "./jev-risk";
import { redactSensitiveText } from "../security/service";

// ---------------------------------------------------------------------------
// AC3: scenario source discovery — classification/extraction over ALREADY-
// READ content. Walking the filesystem is the adapter's job
// (`src/commands/review-jev-scenarios.ts`), same split every sibling module
// in this family uses.
// ---------------------------------------------------------------------------

export const SCENARIO_SOURCE_KINDS = ["wiki", "prd", "readme"] as const;
export type ScenarioSourceKind = (typeof SCENARIO_SOURCE_KINDS)[number];

export interface ScenarioSource {
  /** Stable id: the repo-relative path, plus `#<heading>` for a section carved out of a larger document. */
  readonly id: string;
  readonly kind: ScenarioSourceKind;
  readonly path: string;
  readonly title: string;
  readonly text: string;
  /** Repo-relative code paths this scenario names — links to code, both markdown links and inline code-span file references. */
  readonly links: readonly string[];
}

function firstHeading(content: string): string | undefined {
  const match = /^#{1,6}\s+(.+?)\s*$/m.exec(content);
  return match?.[1];
}

function frontmatterTitle(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const match = /^title:\s*(.+)$/m.exec(content.slice(3, end));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

/** Every code path a scenario's text names — markdown links resolved relative to `fromPath`, plus inline code-span file references (repo-relative already). */
function linksIn(fromPath: string, content: string): readonly string[] {
  const out = new Set<string>();
  for (const raw of extractLinks(content)) {
    const resolved = resolveLink(fromPath, raw);
    if (resolved.length > 0) out.add(resolved);
  }
  for (const raw of extractCodePaths(content)) out.add(raw);
  return [...out];
}

/** AC3: a gdwiki `user-scenario` page IS one scenario — the whole page, title from frontmatter or its first heading. */
export function scenarioFromWikiPage(repoPath: string, content: string): ScenarioSource {
  const title = frontmatterTitle(content) ?? firstHeading(content) ?? repoPath;
  return { id: repoPath, kind: "wiki", path: repoPath, title, text: content, links: linksIn(repoPath, content) };
}

/** A markdown heading and the text under it, up to the next heading at the same or a shallower level. */
interface MarkdownSection {
  readonly heading: string;
  readonly level: number;
  readonly text: string;
}

function markdownSections(content: string): readonly MarkdownSection[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: MarkdownSection[] = [];
  let current: { heading: string; level: number; body: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    sections.push({ heading: current.heading, level: current.level, text: current.body.join("\n").trim() });
    current = undefined;
  };
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      flush();
      current = { heading: match[2]!, level: match[1]!.length, body: [] };
      continue;
    }
    if (current !== undefined) current.body.push(line);
  }
  flush();
  return sections;
}

const REQUIREMENT_SCENARIO_HEADING_RE = /\b(scenario|requirement|user story|use case)/i;

/** AC3: every section of a `docs/requirements/**` document whose heading names a scenario/requirement. */
export function scenariosFromPrd(repoPath: string, content: string): readonly ScenarioSource[] {
  return markdownSections(content)
    .filter((section) => REQUIREMENT_SCENARIO_HEADING_RE.test(section.heading) && section.text.length > 0)
    .map((section) => ({
      id: `${repoPath}#${section.heading}`,
      kind: "prd" as const,
      path: repoPath,
      title: section.heading,
      text: section.text,
      links: linksIn(repoPath, section.text),
    }));
}

const HOW_TO_HEADING_RE = /how\s*to|walkthrough|getting started|usage/i;

/** AC3: every "how to"-shaped section of a README/docs page — a documented user workflow, same treatment as a PRD scenario section. */
export function scenariosFromReadmeLike(repoPath: string, content: string): readonly ScenarioSource[] {
  return markdownSections(content)
    .filter((section) => HOW_TO_HEADING_RE.test(section.heading) && section.text.length > 0)
    .map((section) => ({
      id: `${repoPath}#${section.heading}`,
      kind: "readme" as const,
      path: repoPath,
      title: section.heading,
      text: section.text,
      links: linksIn(repoPath, section.text),
    }));
}

// ---------------------------------------------------------------------------
// AC3 (tightened, see the file header's decision): fan-in over a scenario
// link — how many DISTINCT discovered scenarios link the same file.
// ---------------------------------------------------------------------------

/** A link with fan-in above this many scenarios is down-weighted — significant only with symbol evidence. */
export const SCENARIO_LINK_FANOUT_THRESHOLD = 5;

/** `linked file -> number of distinct scenarios that link it`, over the WHOLE discovered scenario set. */
export function computeLinkFanIn(scenarios: readonly ScenarioSource[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const scenario of scenarios) {
    for (const link of new Set(scenario.links)) {
      counts.set(link, (counts.get(link) ?? 0) + 1);
    }
  }
  return counts;
}

function mentionsIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text);
}

/**
 * Whether a scenario's link to `link` is significant evidence the diff
 * touches THIS scenario — always true under the fan-in threshold; above it,
 * true only when the scenario's own text names one of `link`'s touched
 * exported symbols.
 */
export function isTouchedLinkSignificant(
  scenario: ScenarioSource,
  link: string,
  fanIn: ReadonlyMap<string, number>,
  symbolsByPath: ReadonlyMap<string, readonly string[]>,
): boolean {
  const count = fanIn.get(link) ?? 0;
  if (count <= SCENARIO_LINK_FANOUT_THRESHOLD) return true;
  const symbols = symbolsByPath.get(link) ?? [];
  return symbols.some((symbol) => mentionsIdentifier(scenario.text, symbol));
}

// ---------------------------------------------------------------------------
// AC3: facts — which of a scenario's linked files the diff touches.
// ---------------------------------------------------------------------------

export interface ScenarioFacts {
  readonly scenario: ScenarioSource;
  readonly touchedLinks: readonly string[];
  readonly hasTouchedLink: boolean;
  /** AC4: no test file in this diff covers any of this scenario's touched links. */
  readonly hasNearbyTest: boolean;
  readonly factLines: readonly string[];
}

/**
 * `fanIn`/`symbolsByPath` default to empty maps, under which every link's
 * fan-in reads as 0 (<= threshold) and every link stays unconditionally
 * significant — the original, pre-tightening behaviour. The adapter passes
 * real maps built from the whole discovered scenario set and the diff's
 * touched exported symbols per path.
 */
export function computeScenarioFacts(
  scenario: ScenarioSource,
  allChangedFiles: readonly string[],
  fanIn: ReadonlyMap<string, number> = new Map(),
  symbolsByPath: ReadonlyMap<string, readonly string[]> = new Map(),
): ScenarioFacts {
  const changed = new Set(allChangedFiles);
  const touchedLinks = scenario.links.filter((link) => changed.has(link) && isTouchedLinkSignificant(scenario, link, fanIn, symbolsByPath));
  const hasNearbyTest = touchedLinks.some((link) => testFilesTouchedNearby(link, allChangedFiles).length > 0);
  const factLines = [
    `scenario: ${scenario.title} (${scenario.kind}: ${scenario.id})`,
    `linked code: ${scenario.links.length > 0 ? scenario.links.join(", ") : "(none found)"}`,
    `touched by this diff: ${touchedLinks.length > 0 ? touchedLinks.join(", ") : "(none)"}`,
    `test file(s) touched nearby covering a touched link: ${hasNearbyTest ? "yes" : "no"}`,
  ];
  return { scenario, touchedLinks, hasTouchedLink: touchedLinks.length > 0, hasNearbyTest, factLines };
}

// ---------------------------------------------------------------------------
// AC3: the Jev question and its batching — one `noul` per scenario, batched
// across scenarios that share a call under the vendor's 64k budget (mirrors
// `conform-jev.ts`'s `batchConformItems`).
// ---------------------------------------------------------------------------

export interface ScenarioNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

const SCENARIO_TEXT_CHARS = 4_000;

function questionFor(scenario: ScenarioSource): ScenarioNoulQuestion {
  return {
    type: "noul",
    instructions:
      "Given the scenario description and the deterministic facts above (which of its linked files/symbols this diff " +
      `touches), how likely is it that this diff ALTERS THE BEHAVIOUR of the scenario "${scenario.title}"?`,
  };
}

function stateFor(facts: ScenarioFacts): string {
  const redactedText = redactSensitiveText(facts.scenario.text);
  const bounded = redactedText.length > SCENARIO_TEXT_CHARS ? `${redactedText.slice(0, SCENARIO_TEXT_CHARS)}\n… (truncated)` : redactedText;
  return [...facts.factLines, "", "--- scenario text (redacted) ---", bounded].join("\n");
}

export const SCENARIO_TOKEN_BUDGET = 64_000;
const QUESTIONS_BUDGET_FRACTION = 0.5;

export interface ScenarioBatch {
  readonly items: readonly ScenarioFacts[];
  readonly state: string;
  readonly questions: Readonly<Record<string, ScenarioNoulQuestion>>;
}

/** AC3: batch every scenario with a touched link into as few Jev calls as fit the budget — one shared `state` block per batch, one question key per scenario id. */
export function batchScenarioQuestions(items: readonly ScenarioFacts[]): readonly ScenarioBatch[] {
  const batches: ScenarioBatch[] = [];
  let current: ScenarioFacts[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      items: current,
      state: current.map((item) => stateFor(item)).join("\n\n"),
      questions: Object.fromEntries(current.map((item) => [item.scenario.id, questionFor(item.scenario)])),
    });
    current = [];
  };

  for (const item of items) {
    const attempt = [...current, item];
    const stateTokens = estimateTokens(attempt.map((i) => stateFor(i)).join("\n\n"));
    const questionsTokens = estimateTokens(attempt.map((i) => `${i.scenario.id}:noul:${questionFor(i.scenario).instructions}`).join("\n"));
    const total = stateTokens + questionsTokens;
    const withinShare = questionsTokens <= SCENARIO_TOKEN_BUDGET * QUESTIONS_BUDGET_FRACTION;
    if (current.length > 0 && (total > SCENARIO_TOKEN_BUDGET || !withinShare)) {
      flush();
      current = [item];
    } else {
      current = attempt;
    }
  }
  flush();
  return batches;
}

// ---------------------------------------------------------------------------
// AC3: budget — `--max-calls` bounds the number of scenarios checked (each
// scenario is one Jev question, batched together where the budget allows).
// A prefix of the deterministically ordered (by id) scenario list is kept.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_JEV_SCENARIO_CALLS = 150;

export interface ScenarioSelection {
  readonly selected: readonly ScenarioFacts[];
  readonly skipped: readonly ScenarioFacts[];
  readonly maxCalls: number;
  readonly notApplicable: readonly ScenarioFacts[];
}

/** AC3: only scenarios with at least one touched link are candidates at all; among those, a deterministic (by id) prefix up to `maxCalls`. */
export function selectScenarios(all: readonly ScenarioFacts[], maxCalls: number = DEFAULT_MAX_JEV_SCENARIO_CALLS): ScenarioSelection {
  const cap = Number.isFinite(maxCalls) && maxCalls >= 0 ? Math.trunc(maxCalls) : DEFAULT_MAX_JEV_SCENARIO_CALLS;
  const notApplicable = all.filter((item) => !item.hasTouchedLink);
  const candidates = [...all.filter((item) => item.hasTouchedLink)].sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
  return { selected: candidates.slice(0, cap), skipped: candidates.slice(cap), maxCalls: cap, notApplicable };
}

// ---------------------------------------------------------------------------
// AC4: the manual-check list and findings — deterministic, over already-
// scored scenarios.
// ---------------------------------------------------------------------------

export const DEFAULT_JEV_SCENARIOS_THRESHOLD = 0.5;

export interface ScoredScenario {
  readonly facts: ScenarioFacts;
  readonly probability: number;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export function scoreScenario(facts: ScenarioFacts, answer: { readonly noul?: number } | undefined): ScoredScenario {
  return { facts, probability: clamp01(answer?.noul ?? 0) };
}

/** Ranked, highest probability first — ties broken by scenario id for determinism. */
export function rankScenariosByProbability(scored: readonly ScoredScenario[]): readonly ScoredScenario[] {
  return [...scored].sort((a, b) => b.probability - a.probability || a.facts.scenario.id.localeCompare(b.facts.scenario.id));
}

export interface ScenarioCheckItem {
  readonly id: string;
  readonly title: string;
  readonly kind: ScenarioSourceKind;
  readonly probability: number;
  readonly touchedLinks: readonly string[];
}

/** AC4: the manual-check list — every scenario at/above `threshold`, ranked, with its touched links as evidence. Not itself a finding array; the orchestrator/human reads this as a checklist. */
export function buildScenarioChecklist(scored: readonly ScoredScenario[], threshold: number = DEFAULT_JEV_SCENARIOS_THRESHOLD): readonly ScenarioCheckItem[] {
  return rankScenariosByProbability(scored)
    .filter((s) => s.probability >= threshold)
    .map((s) => ({
      id: s.facts.scenario.id,
      title: s.facts.scenario.title,
      kind: s.facts.scenario.kind,
      probability: s.probability,
      touchedLinks: s.facts.touchedLinks,
    }));
}

export interface ScenarioFinding {
  readonly id: string;
  readonly severity: "minor";
  readonly file: string;
  readonly line: number | null;
  readonly quote: string | null;
  readonly problem: string;
  readonly impact: string;
  readonly suggested_fix: string;
  readonly evidence: string;
  readonly confidence: "high" | "medium" | "low";
  readonly reviewer: "review-jev-scenarios";
  readonly dedupe_key: string;
}

function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function confidenceFor(probability: number): "high" | "medium" | "low" {
  const certainty = Math.max(probability, 1 - probability);
  if (certainty >= 0.85) return "high";
  if (certainty >= 0.65) return "medium";
  return "low";
}

/**
 * AC4: a `minor` finding for each likely-affected scenario (>= `threshold`)
 * with NO test in the diff covering any of its touched links (a fact,
 * `ScenarioFacts.hasNearbyTest`). Severity is fixed at `minor` — this flags
 * attention over a functional scenario, never asserts a defect.
 */
export function synthesizeScenarioFindings(scored: readonly ScoredScenario[], threshold: number = DEFAULT_JEV_SCENARIOS_THRESHOLD): readonly ScenarioFinding[] {
  const findings: ScenarioFinding[] = [];
  for (const item of rankScenariosByProbability(scored)) {
    if (item.probability < threshold || item.facts.hasNearbyTest) continue;
    const { scenario, touchedLinks } = item.facts;
    const anchorFile = touchedLinks[0] ?? scenario.path;
    findings.push({
      id: `jev-scenarios-${shortHash(scenario.id)}`,
      severity: "minor",
      file: anchorFile,
      line: null,
      quote: null,
      problem: `Scenario "${scenario.title}" (${scenario.kind}: ${scenario.id}) is likely affected by this diff (p=${item.probability.toFixed(2)}), and no test in this diff covers ${touchedLinks.join(", ") || anchorFile}.`,
      impact: "A functional scenario changed with no accompanying test is the shape of change most likely to regress silently for a real user.",
      suggested_fix: `Add or extend a test covering "${scenario.title}", or manually verify the scenario before merge.`,
      evidence: `linked code: ${scenario.links.join(", ") || "(none)"}; touched by this diff: ${touchedLinks.join(", ") || "(none)"}; probability ${item.probability.toFixed(2)} (threshold ${threshold})`,
      confidence: confidenceFor(item.probability),
      reviewer: "review-jev-scenarios",
      dedupe_key: scenario.id,
    });
  }
  return findings;
}

export function scenarioFindingStats(findings: readonly ScenarioFinding[]): Readonly<Record<"blocker" | "major" | "minor" | "info", number>> {
  const stats = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const finding of findings) stats[finding.severity] += 1;
  return stats;
}

// ---------------------------------------------------------------------------
// Rendering — the non-`--json` text a human reads.
// ---------------------------------------------------------------------------

export interface JevScenariosRunResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-scenarios";
  readonly summary: string;
  readonly findings: readonly ScenarioFinding[];
  readonly stats: Readonly<Record<"blocker" | "major" | "minor" | "info", number>>;
  readonly checklist: readonly ScenarioCheckItem[];
}

export function renderScenariosMarkdown(result: JevScenariosRunResult): string {
  const lines: string[] = ["# review-jev-scenarios", "", `status: ${result.status}`, result.summary, "", `stats: blocker=0, major=0, minor=${result.stats.minor}, info=0`, ""];
  lines.push("## Manual-check list (ranked, likely-affected scenarios)", "");
  if (result.checklist.length === 0) {
    lines.push("_no scenario at or above threshold_", "");
  } else {
    for (const item of result.checklist) {
      lines.push(`- [${item.kind}] ${item.title} (p=${item.probability.toFixed(2)}) — touched: ${item.touchedLinks.join(", ") || "(none)"}`);
    }
    lines.push("");
  }
  if (result.findings.length === 0) {
    lines.push("_no findings: every likely-affected scenario has a nearby test, or none is likely affected_");
    return `${lines.join("\n")}\n`;
  }
  lines.push("## Findings", "");
  for (const finding of result.findings) {
    lines.push(`### [${finding.id}] ${finding.severity} — ${finding.file}`, "");
    lines.push(`- **Problem**: ${finding.problem}`);
    lines.push(`- **Impact**: ${finding.impact}`);
    lines.push(`- **Suggested fix**: ${finding.suggested_fix}`);
    lines.push(`- **Evidence**: ${finding.evidence}`);
    lines.push(`- **Confidence**: ${finding.confidence}`, "");
  }
  return `${lines.join("\n")}\n`;
}
