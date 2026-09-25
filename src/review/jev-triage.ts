// review-jev-triage — flow 340, an ADVISORY, ANNOTATE-ONLY pass the
// orchestrator runs over the CONSOLIDATED findings of a review package,
// after the Sub-Agent Report Quality Gate and before Wave C verification
// (`review-orchestrator/SKILL.md`). It never drops or demotes a finding by
// itself — every output here is an annotation an operator or a downstream
// pass reads, not a decision this module makes.
//
// Three independent tracks, one Jev `noul` question shape each:
//
// 1. SEVERITY CALIBRATION — for every blocker/major finding, one `noul`:
//    does the finding name a concrete trigger AND a concrete observable
//    outcome? That is the orchestrator's OWN canonical severity boundary
//    test (`review-orchestrator/SKILL.md` "Severity (canonical)" ->
//    "major/minor/info — the boundary test"), asked of Jev rather than
//    re-derived here — this module does not invent a second rubric.
// 2. DUPLICATE-MERGE CANDIDATES — pairs built deterministically, never a
//    blind n² scan: only among findings that share a file, or whose line
//    ranges overlap, or whose quotes overlap. One `noul` per pair: same
//    underlying defect at the same site?
// 3. VERIFIER QUEUE ORDER — one `noul` per finding: does the evidence
//    plausibly follow from the quoted code? Output lowest-plausibility
//    first — a prioritisation of Wave C's queue, never a skip.
//
// CORE ZONE (`src/lib/import-zones.ts`): this module never imports the
// client-zone Jev client (`src/harness/decision/jev-client.ts`) — the same
// discipline `jev-contract.ts`/`jev-risk.ts`/`jev-rules.ts` already
// establish. `src/commands/review-jev-triage.ts` (the ADAPTER) is where the
// question/answer shapes below meet the real client.
//
// Through the security facade, not `security/redact` directly — the
// import-policy ratchet is at its cap; every caller outside `src/security/`
// reaches redaction through `src/security/service.ts`.

import { estimateTokens } from "./cost";
import { redactSensitiveText } from "../security/service";

// ---------------------------------------------------------------------------
// Findings — a minimal, tolerant read of a review package's `findings.json`
// (a bare array, same shape flow 327's own package on disk uses) or a
// `REVIEW_RESULT`-shaped object (`{ findings: [...] }`). Every OTHER field a
// finding may carry (`verification`, `disposition`, `class_scope`, …) is
// read by nothing here and passed through untouched by the adapter.
// ---------------------------------------------------------------------------

export type TriageSeverity = "blocker" | "major" | "minor" | "info";

export interface TriageFinding {
  readonly id: string;
  readonly severity: TriageSeverity;
  readonly file?: string | null;
  readonly line?: number | null;
  readonly quote?: string | null;
  readonly problem: string;
  readonly evidence: string;
  readonly reviewer?: string;
}

const SEVERITIES: readonly TriageSeverity[] = ["blocker", "major", "minor", "info"];

function isTriageSeverity(value: unknown): value is TriageSeverity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/** A string field, tolerant of `null`/absent (a finding's `file`/`line`/`quote` may legitimately be `null` per `reviewer-finding.schema.json`). */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Tolerant parse: a malformed entry (missing `id`/`severity`/`problem`) is
 * DROPPED, not thrown over — a review package assembled by hand, or an
 * older reviewer that skipped a field, should still triage the findings
 * that parse rather than refuse the whole file. The adapter reports how
 * many were dropped.
 */
export function parseTriageFindings(raw: unknown): { readonly findings: readonly TriageFinding[]; readonly droppedCount: number } {
  const array: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>)["findings"])
      ? ((raw as Record<string, unknown>)["findings"] as unknown[])
      : [];
  const findings: TriageFinding[] = [];
  let droppedCount = 0;
  for (const entry of array) {
    if (typeof entry !== "object" || entry === null) {
      droppedCount += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = optionalString(record["id"]);
    const severity = record["severity"];
    const problem = optionalString(record["problem"]);
    if (id === undefined || !isTriageSeverity(severity) || problem === undefined) {
      droppedCount += 1;
      continue;
    }
    findings.push({
      id,
      severity,
      file: optionalString(record["file"]) ?? null,
      line: optionalNumber(record["line"]) ?? null,
      quote: optionalString(record["quote"]) ?? null,
      problem,
      evidence: optionalString(record["evidence"]) ?? "",
      ...(optionalString(record["reviewer"]) !== undefined ? { reviewer: optionalString(record["reviewer"])! } : {}),
    });
  }
  return { findings, droppedCount };
}

/** AC2/AC3/AC4: the severity/duplicate/verify tracks scope to blocker and major findings — the same population Wave C verification itself dispatches over ("when blockers/majors exist"), and the shapes the spec's severity-calibration example names directly. A `minor`/`info` finding is neither mis-severitied (a downgrade path Jev could not correct anyway, since it never auto-demotes) nor worth a verifier's queue slot. */
export function selectTriageFindings(findings: readonly TriageFinding[]): readonly TriageFinding[] {
  return findings.filter((f) => f.severity === "blocker" || f.severity === "major");
}

// ---------------------------------------------------------------------------
// AC3: deterministic duplicate-merge candidate pairs.
// ---------------------------------------------------------------------------

export type MergeCandidateReason = "file" | "lines" | "quote";

export interface MergeCandidatePair {
  readonly id: string;
  readonly a: TriageFinding;
  readonly b: TriageFinding;
  readonly reason: MergeCandidateReason;
}

/** A local window around one finding's reported line — the only line data a finding carries (`reviewer-finding.schema.json`'s `line` is a single integer, not a range) — expanded by a fixed context radius so two findings a few lines apart in the same neighbourhood still count as overlapping. */
const LINE_OVERLAP_WINDOW = 3;

function sameFile(a: TriageFinding, b: TriageFinding): boolean {
  return typeof a.file === "string" && a.file.length > 0 && a.file === b.file;
}

function lineRangesOverlap(a: TriageFinding, b: TriageFinding): boolean {
  if (typeof a.line !== "number" || typeof b.line !== "number") return false;
  const aStart = a.line - LINE_OVERLAP_WINDOW;
  const aEnd = a.line + LINE_OVERLAP_WINDOW;
  const bStart = b.line - LINE_OVERLAP_WINDOW;
  const bEnd = b.line + LINE_OVERLAP_WINDOW;
  return aStart <= bEnd && bStart <= aEnd;
}

function normalizeQuote(quote: string | null | undefined): string {
  return (quote ?? "").replace(/\s+/g, " ").trim();
}

/** Two quotes "overlap" when one contains the other after whitespace normalization — a short quote (under 12 normalized characters) is never enough evidence on its own (too likely to be a coincidental substring like a punctuation run). */
function quotesOverlap(a: TriageFinding, b: TriageFinding): boolean {
  const qa = normalizeQuote(a.quote);
  const qb = normalizeQuote(b.quote);
  if (qa.length < 12 || qb.length < 12) return false;
  return qa === qb || qa.includes(qb) || qb.includes(qa);
}

/** A hard ceiling on how many pairs are even CONSIDERED, independent of `--max-calls` — a package with hundreds of blocker/major findings sharing one file (e.g. a lint-shaped sweep) would otherwise produce a pair count quadratic in that count before any budget cap gets a say. Pairs beyond this are never built, not merely unscored; `--max-calls`'s own skip accounting is about items that WERE built and then dropped for budget, a different fact from a pair that was never enumerated. */
export const MAX_MERGE_CANDIDATE_PAIRS = 200;

/**
 * AC3: every pair among the calibration population (blocker/major) that
 * shares a file, has overlapping line ranges, or has overlapping quotes —
 * checked in that priority order per pair (a pair matching more than one
 * reason is recorded under the first that applies) — in the stable
 * `i < j` order of the input array, so re-running against the same
 * findings.json produces the identical pair list and ids every time.
 */
export function buildMergeCandidatePairs(findings: readonly TriageFinding[]): readonly MergeCandidatePair[] {
  const pool = selectTriageFindings(findings);
  const pairs: MergeCandidatePair[] = [];
  outer: for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      if (pairs.length >= MAX_MERGE_CANDIDATE_PAIRS) break outer;
      const a = pool[i]!;
      const b = pool[j]!;
      const reason: MergeCandidateReason | undefined = sameFile(a, b) ? "file" : lineRangesOverlap(a, b) ? "lines" : quotesOverlap(a, b) ? "quote" : undefined;
      if (reason === undefined) continue;
      pairs.push({ id: `MRG${pairs.length + 1}`, a, b, reason });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// One Jev `noul` question per item, batched under the vendor's 64k budget —
// same greedy-pack / conservative-fraction / split-retry-once discipline
// `src/review/jev-contract.ts`'s `batchContractClaimItems` and
// `src/commands/review-jev-contract.ts`'s `attemptBatch` already establish,
// mirrored here rather than imported (each Jev-backed reviewer in this
// codebase owns its own batcher over its own item shape).
// ---------------------------------------------------------------------------

export const TRIAGE_TOKEN_BUDGET = 64_000;
/** Same 0.4 fraction, same reasoning `jev-contract.ts`'s `BATCH_BUDGET_FRACTION` documents: `estimateTokens` underestimates a code-shaped quote/evidence excerpt, and a batch sized off the optimistic 64k straight can still overshoot the vendor's real ceiling. */
const BATCH_BUDGET_FRACTION = 0.4;
/** Same cap `jev-contract.ts`'s `MAX_CLAIMS_PER_BATCH` uses, for the same reason: a smaller `state` per call is margin independent of the token-budget fraction. */
const MAX_ITEMS_PER_BATCH = 3;

export type TriageItemKind = "severity" | "merge" | "verify";

export interface TriageQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

export interface TriageItem {
  readonly id: string;
  readonly kind: TriageItemKind;
  readonly state: string;
  readonly question: TriageQuestion;
}

function severityCheckState(finding: TriageFinding): string {
  const location = finding.file !== null && finding.file !== undefined ? `${finding.file}${finding.line !== null && finding.line !== undefined ? `:${finding.line}` : ""}` : "(no file recorded)";
  return [`### ${finding.id} (${finding.severity})`, `location: ${location}`, `problem: ${redactSensitiveText(finding.problem)}`, `evidence: ${redactSensitiveText(finding.evidence)}`].join("\n");
}

function severityCheckQuestion(): TriageQuestion {
  return {
    type: "noul",
    instructions: "Does this finding name a concrete trigger AND a concrete observable outcome that trigger produces? (the review-orchestrator's canonical major/minor/info boundary test).",
  };
}

function mergeCandidateState(pair: MergeCandidatePair): string {
  const render = (f: TriageFinding): string => {
    const location = f.file !== null && f.file !== undefined ? `${f.file}${f.line !== null && f.line !== undefined ? `:${f.line}` : ""}` : "(no file recorded)";
    const quote = f.quote !== null && f.quote !== undefined && f.quote.length > 0 ? `\nquote: ${redactSensitiveText(f.quote)}` : "";
    return `${f.id} at ${location}\nproblem: ${redactSensitiveText(f.problem)}${quote}`;
  };
  return [`### ${pair.id} (matched by: ${pair.reason})`, render(pair.a), "", render(pair.b)].join("\n");
}

function mergeCandidateQuestion(): TriageQuestion {
  return { type: "noul", instructions: "Do these two findings describe the same underlying defect at the same site?" };
}

function verifyOrderState(finding: TriageFinding): string {
  const location = finding.file !== null && finding.file !== undefined ? `${finding.file}${finding.line !== null && finding.line !== undefined ? `:${finding.line}` : ""}` : "(no file recorded)";
  const quote = finding.quote !== null && finding.quote !== undefined && finding.quote.length > 0 ? redactSensitiveText(finding.quote) : "(no quote recorded)";
  return [`### ${finding.id} at ${location}`, `quoted code: ${quote}`, `evidence: ${redactSensitiveText(finding.evidence)}`].join("\n");
}

function verifyOrderQuestion(): TriageQuestion {
  return { type: "noul", instructions: "Does this finding's evidence plausibly follow from the quoted code?" };
}

export interface TriagePopulation {
  readonly calibration: readonly TriageFinding[];
  readonly mergePairs: readonly MergeCandidatePair[];
}

/** AC2/AC3/AC4 combined: the calibration population and its merge pairs, computed once and shared by {@link computeTriageItems} and by the adapter's reporting. */
export function computeTriagePopulation(findings: readonly TriageFinding[]): TriagePopulation {
  const calibration = selectTriageFindings(findings);
  return { calibration, mergePairs: buildMergeCandidatePairs(findings) };
}

export interface TriageItemSelection {
  readonly items: readonly TriageItem[];
  readonly skippedCount: number;
  readonly maxItems: number;
}

/**
 * Every item across the three tracks, in a fixed priority order — severity
 * calibration first (spec's own (a)/(b)/(c) ordering, and the track with
 * the smallest, highest-value population), then merge candidates, then
 * verify-order — capped at `maxItems` total. Items beyond the cap are
 * SKIPPED, never silently dropped: {@link TriageItemSelection.skippedCount}
 * reports exactly how many, the same discipline
 * `jev-contract.ts`'s `selectContractClaims` already uses for `--max-calls`.
 */
export function computeTriageItems(population: TriagePopulation, maxItems: number): TriageItemSelection {
  const cap = Number.isFinite(maxItems) && maxItems >= 0 ? Math.trunc(maxItems) : 0;
  const all: TriageItem[] = [
    ...population.calibration.map((f) => ({ id: `SEV-${f.id}`, kind: "severity" as const, state: severityCheckState(f), question: severityCheckQuestion() })),
    ...population.mergePairs.map((p) => ({ id: p.id, kind: "merge" as const, state: mergeCandidateState(p), question: mergeCandidateQuestion() })),
    ...population.calibration.map((f) => ({ id: `VER-${f.id}`, kind: "verify" as const, state: verifyOrderState(f), question: verifyOrderQuestion() })),
  ];
  return { items: all.slice(0, cap), skippedCount: Math.max(0, all.length - cap), maxItems: cap };
}

export interface TriageBatch {
  readonly items: readonly TriageItem[];
  readonly state: string;
  readonly questions: Readonly<Record<string, TriageQuestion>>;
}

/** Rebuilds one batch's `state`/`questions` from a subset of items — used by {@link batchTriageItems}'s own initial pack and by the adapter's split-and-retry-once path on a real vendor `max_tokens_exceeded`, never a second bespoke assembly path. */
export function buildTriageBatch(items: readonly TriageItem[]): TriageBatch {
  return {
    items,
    state: items.map((item) => `[${item.id}]\n${item.state}`).join("\n\n"),
    questions: Object.fromEntries(items.map((item) => [item.id, item.question])),
  };
}

/** AC5: greedy-pack under `BATCH_BUDGET_FRACTION * TRIAGE_TOKEN_BUDGET`, at most `MAX_ITEMS_PER_BATCH` items per batch — mirrors `jev-contract.ts`'s `batchContractClaimItems` exactly, over the unified `TriageItem` shape instead of a claim. */
export function batchTriageItems(items: readonly TriageItem[]): readonly TriageBatch[] {
  const batches: TriageBatch[] = [];
  let current: TriageItem[] = [];
  const effectiveBudget = TRIAGE_TOKEN_BUDGET * BATCH_BUDGET_FRACTION;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push(buildTriageBatch(current));
    current = [];
  };

  for (const item of items) {
    const attempt = [...current, item];
    const stateTokens = estimateTokens(attempt.map((i) => i.state).join("\n\n"));
    const questionsTokens = estimateTokens(attempt.map((i) => `${i.id}:noul:${i.question.instructions}`).join("\n"));
    if (current.length > 0 && (attempt.length > MAX_ITEMS_PER_BATCH || stateTokens + questionsTokens > effectiveBudget)) {
      flush();
      current = [item];
    } else {
      current = attempt;
    }
  }
  flush();
  return batches;
}

export const DEFAULT_MAX_JEV_TRIAGE_ITEMS = 30;
export const DEFAULT_JEV_TRIAGE_SEVERITY_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Annotations — the scored result of the three tracks. Never a decision:
// every field here is read by a human or by a downstream pass, and none of
// it removes or reclassifies a finding.
// ---------------------------------------------------------------------------

export interface SeverityCheckAnnotation {
  readonly id: string;
  readonly p?: number;
  readonly flagged: boolean;
}

export interface MergeCandidateAnnotation {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly reason: MergeCandidateReason;
  readonly p?: number;
}

export interface VerifyOrderAnnotation {
  readonly id: string;
  readonly p?: number;
}

export interface TriageAnnotations {
  readonly severity_check: readonly SeverityCheckAnnotation[];
  readonly merge_candidates: readonly MergeCandidateAnnotation[];
  readonly verify_order: readonly VerifyOrderAnnotation[];
}

/**
 * AC2/AC3/AC4: turns `noul` scores (keyed by item id, `undefined` where Jev
 * was never asked or a batch degraded) into the three annotation arrays.
 * `flagged` in {@link SeverityCheckAnnotation} is `p < threshold`
 * (default {@link DEFAULT_JEV_TRIAGE_SEVERITY_THRESHOLD}) and nothing more —
 * never a severity mutation. `verify_order` is sorted ascending by `p`
 * (lowest plausibility first, i.e. verify first); items Jev was never asked
 * about sort after every scored item, in their original order, since there
 * is nothing to rank them by.
 */
export function synthesizeTriageAnnotations(population: TriagePopulation, probabilityById: ReadonlyMap<string, number>, threshold: number = DEFAULT_JEV_TRIAGE_SEVERITY_THRESHOLD): TriageAnnotations {
  const severity_check: SeverityCheckAnnotation[] = population.calibration.map((f) => {
    const p = probabilityById.get(`SEV-${f.id}`);
    return { id: f.id, ...(p !== undefined ? { p } : {}), flagged: p !== undefined && p < threshold };
  });

  const merge_candidates: MergeCandidateAnnotation[] = population.mergePairs.map((pair) => {
    const p = probabilityById.get(pair.id);
    return { id: pair.id, a: pair.a.id, b: pair.b.id, reason: pair.reason, ...(p !== undefined ? { p } : {}) };
  });

  const verifyScored: VerifyOrderAnnotation[] = [];
  const verifyUnscored: VerifyOrderAnnotation[] = [];
  for (const f of population.calibration) {
    const p = probabilityById.get(`VER-${f.id}`);
    if (p !== undefined) verifyScored.push({ id: f.id, p });
    else verifyUnscored.push({ id: f.id });
  }
  verifyScored.sort((x, y) => (x.p ?? 0) - (y.p ?? 0));

  return { severity_check, merge_candidates, verify_order: [...verifyScored, ...verifyUnscored] };
}

// ---------------------------------------------------------------------------
// Rendering — the non-`--json` text a human reads.
// ---------------------------------------------------------------------------

export interface TriageBudgetReport {
  readonly maxItems: number;
  readonly itemsScored: number;
  readonly itemsSkipped: number;
  readonly findingsDropped: number;
}

export interface JevTriageRunResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-triage";
  readonly summary: string;
  readonly annotations: TriageAnnotations;
  readonly budget: TriageBudgetReport;
}

export function renderTriageMarkdown(result: JevTriageRunResult): string {
  const lines: string[] = [
    "# review-jev-triage",
    "",
    `status: ${result.status}`,
    result.summary,
    "",
    `budget: max-items=${result.budget.maxItems}, scored=${result.budget.itemsScored}, skipped=${result.budget.itemsSkipped}, findings dropped on parse=${result.budget.findingsDropped}`,
    "",
    "## Severity calibration",
    "",
  ];
  if (result.annotations.severity_check.length === 0) {
    lines.push("_no blocker/major findings to calibrate_", "");
  } else {
    for (const a of result.annotations.severity_check) {
      lines.push(`- [${a.id}] p=${a.p !== undefined ? a.p.toFixed(2) : "n/a"}${a.flagged ? " — FLAGGED (below threshold; advisory only, not auto-demoted)" : ""}`);
    }
    lines.push("");
  }
  lines.push("## Duplicate-merge candidates", "");
  if (result.annotations.merge_candidates.length === 0) {
    lines.push("_no candidate pairs_", "");
  } else {
    for (const m of result.annotations.merge_candidates) {
      lines.push(`- [${m.id}] ${m.a} <-> ${m.b} (matched by: ${m.reason}) p=${m.p !== undefined ? m.p.toFixed(2) : "n/a"}`);
    }
    lines.push("");
  }
  lines.push("## Verifier queue order (lowest plausibility first)", "");
  if (result.annotations.verify_order.length === 0) {
    lines.push("_no findings to order_");
  } else {
    for (const v of result.annotations.verify_order) {
      lines.push(`- [${v.id}] p=${v.p !== undefined ? v.p.toFixed(2) : "n/a"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
