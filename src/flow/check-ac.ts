// Flow 328: Jev checks a flow's change against its FROZEN acceptance criteria
// (`.metaproject/flows/328-*/acceptance-criteria.md`).
//
// CORE ZONE (`src/lib/import-zones.ts`: `flow` is core). Same discipline
// `src/review/ci-triage.ts` and `src/review/conform-jev.ts` already follow —
// this module never imports the client-zone Jev client
// (`src/harness/decision/jev-client.ts`); its question/answer shapes are
// plain, structurally typed stand-ins that the adapter
// (`src/commands/flow.ts`) glues to the real client.
//
// AC2: deterministic evidence FIRST, per criterion — computed here, with no
// model call, before anything is ever sent to Jev. A criterion whose named
// artefacts are ALL absent from the diff/tree is flagged by the facts alone
// (`allTokensAbsent`); the adapter still asks Jev for it (facts are evidence,
// not a verdict) but the fact is placed above the diff in Jev's `state`, and
// printed to the operator either way.
//
// AC3: `not-checkable` is assigned WITHOUT a model when a criterion is about
// something no diff can ever record. The marker list below is the exhaustive,
// documented set this flow recognizes — anything else is checkable.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "../review/cost";
import type { ScopedRegion } from "../review/scope";
// Through the security facade, not `security/redact` directly — the
// import-policy ratchet is at its cap; every caller outside `src/security/`
// reaches redaction through `src/security/service.ts` (see that file's own
// header, and `src/review/ci-triage.ts`'s identical note).
import { redactSensitiveText } from "../security/service";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { REVIEW_GATE_CONFIG_PATH } from "./review-gate";

// ---------------------------------------------------------------------------
// Parsing: acceptance-criteria.md -> AcCriterion[]
// ---------------------------------------------------------------------------

export interface AcCriterion {
  readonly id: string;
  readonly text: string;
}

/**
 * The exact same top-line rule `src/flow/store.ts`'s `readAcCriteria` uses
 * (`^\s*[-*]\s*(AC\d+):`) — this module additionally keeps the TEXT after the
 * colon, which that function discards. A continuation line (indented prose
 * under a criterion) is not re-matched here either, for the same reason
 * `store.ts`'s own comment gives: it is prose, not a new criterion.
 */
const AC_LINE = /^\s*[-*]\s*(AC\d+)\s*:\s?(.*)$/i;

export function parseAcceptanceCriteria(content: string): AcCriterion[] {
  const out: AcCriterion[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = AC_LINE.exec(line);
    if (match?.[1]) {
      out.push({ id: match[1].toUpperCase(), text: (match[2] ?? "").trim() });
    }
  }
  return out;
}

/** True once `flow.acChecksum` is set — the same "frozen" reading `assertAcIntact` uses. */
export function isFrozen(flow: { readonly acChecksum: string | null }): boolean {
  return typeof flow.acChecksum === "string" && flow.acChecksum.length > 0;
}

// ---------------------------------------------------------------------------
// AC3: not-checkable markers — an explicit, documented list. Never sent to
// Jev; always listed in the report.
// ---------------------------------------------------------------------------

export interface NotCheckableMarker {
  readonly label: string;
  readonly re: RegExp;
}

/**
 * Criteria about something no diff can ever record. Matched against the
 * criterion's own text, case-insensitively. This list is the documentation
 * AC3 asks for — extend it here, not by inventing a second mechanism.
 */
export const NOT_CHECKABLE_MARKERS: readonly NotCheckableMarker[] = [
  { label: "live check", re: /\blive[- ]?check\b|\brun(?:s|ning)? with\b.*\benv\b|\blive[- ]?run\b/i },
  // Narrow on purpose (review finding): the previous `\bCI\b.*\bgreen\b`
  // matched "CI" and "green" ANYWHERE in the same criterion, in either
  // order and however far apart — "CI runs fast; the light turns green"
  // would have matched it. This only accepts the phrase actually meant.
  { label: "CI green", re: /\bCI (?:is )?green\b|\bCI passes\b/i },
  { label: "health passing", re: /\bhealth run\b|\bhealth (?:passes|passing)\b|\bkeryx health run\b/i },
  { label: "docs published", re: /\bdocs?(?:umentation)? (?:published|live|deployed|site)\b/i },
  { label: "manual verification", re: /\bmanually verified\b|\bmanual(?:ly)? tested?\b|\ba human (?:verifies|confirms|checks)\b/i },
  { label: "operator confirmation", re: /\ban? operator\b.*\b(?:confirms?|signs? off|approves?)\b/i },
];

export interface NotCheckableClassification {
  readonly label: string;
  readonly reason: string;
}

/** One marker's classification of a single clause, or `undefined` when nothing on the list matches it. */
function classifyClause(clauseText: string): NotCheckableClassification | undefined {
  for (const marker of NOT_CHECKABLE_MARKERS) {
    if (marker.re.test(clauseText)) {
      return {
        label: marker.label,
        reason: `not-checkable: this criterion names a "${marker.label}" condition, which no diff records — assigned without asking Jev.`,
      };
    }
  }
  return undefined;
}

/**
 * Review finding: a criterion combining a checkable clause with a
 * not-checkable one (this flow's own AC10 — "Docs (…), CI green, `keryx
 * health run` passes, hermetic macOS-safe tests, import zones respected" —
 * has doc paths and "import zones" a diff CAN evidence, alongside "CI
 * green"/"health run" it cannot) used to become WHOLLY not-checkable the
 * moment any one clause matched a marker, silently dropping the checkable
 * part from every Jev call and every fact line. Split on `,`/`;` and
 * classify each clause; the criterion is not-checkable only when EVERY
 * clause is — one checkable clause keeps the whole criterion checkable, so
 * the evidence for it still reaches Jev with the full original text.
 */
function criterionClauses(criterionText: string): string[] {
  return criterionText
    .split(/[,;]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/** `undefined` when the criterion is checkable — the default reading of anything not on the marker list. */
export function classifyNotCheckable(criterionText: string): NotCheckableClassification | undefined {
  const clauses = criterionClauses(criterionText);
  if (clauses.length <= 1) {
    // No comma/semicolon at all — the single-clause path, unchanged.
    return classifyClause(criterionText);
  }
  const classifications = clauses.map(classifyClause);
  if (classifications.some((classification) => classification === undefined)) {
    return undefined;
  }
  const labels = [...new Set(classifications.map((classification) => classification?.label))];
  return {
    label: labels.join(", "),
    reason: `not-checkable: every clause of this criterion names a condition no diff records (${labels.join(", ")}) — assigned without asking Jev.`,
  };
}

// ---------------------------------------------------------------------------
// AC2: token extraction + deterministic facts
// ---------------------------------------------------------------------------

/** Backticked tokens, file-looking paths, and bare `keryx <word>` command names — the artefacts a criterion NAMES. */
export function extractCriterionTokens(text: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const raw = match[1]?.trim();
    if (raw) tokens.add(raw);
  }
  // Bare file paths not already inside backticks (src/foo/bar.ts, docs/x.md).
  for (const match of text.matchAll(/\b[\w.-]+\/[\w./-]+\.[a-zA-Z]{1,6}\b/g)) {
    tokens.add(match[0]);
  }
  // `keryx <subcommand>` command names mentioned in prose without backticks.
  for (const match of text.matchAll(/\bkeryx\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)/g)) {
    if (match[0]) tokens.add(match[0]);
  }
  return [...tokens];
}

export interface AcFacts {
  readonly tokens: readonly string[];
  readonly tokensPresent: readonly string[];
  readonly tokensAbsent: readonly string[];
  readonly allTokensAbsent: boolean;
  readonly testsChanged: readonly string[];
  readonly factLines: readonly string[];
}

/**
 * Pure: whether each of a criterion's named tokens appears anywhere in the
 * diff text or the retained file list, and which changed TEST files mention
 * one of those tokens. No network, no model — this is the evidence Jev's
 * `state` is built from (AC2/AC4), and it is printed to the operator even
 * when Jev is never asked (AC4's "without Jev configured" path).
 */
export function computeAcFacts(criterion: AcCriterion, diffText: string, changedFiles: readonly string[]): AcFacts {
  const tokens = extractCriterionTokens(criterion.text);
  const tokensPresent = tokens.filter((token) => diffText.includes(token) || changedFiles.some((file) => file.includes(token)));
  const tokensAbsent = tokens.filter((token) => !tokensPresent.includes(token));
  const testFiles = changedFiles.filter((file) => /\.(test|spec)\.[a-z]+$/i.test(file));
  const testsChanged = testFiles.filter((file) => tokens.some((token) => file.includes(token)) || tokens.some((token) => diffText.includes(token)));
  const factLines = [
    tokens.length === 0
      ? "no backticked token, file path, or `keryx <cmd>` name was found in this criterion's text — no artefact to check for."
      : `named artefacts: ${tokens.map((t) => `\`${t}\``).join(", ")}`,
    ...(tokens.length > 0
      ? [
          tokensPresent.length > 0
            ? `present in the diff/tree: ${tokensPresent.map((t) => `\`${t}\``).join(", ")}`
            : "none of the named artefacts appear in the diff or the changed-file list.",
          ...(tokensAbsent.length > 0 && tokensPresent.length > 0 ? [`absent: ${tokensAbsent.map((t) => `\`${t}\``).join(", ")}`] : []),
        ]
      : []),
    testFiles.length > 0
      ? `changed test file(s): ${testFiles.join(", ")}${testsChanged.length > 0 ? " (mentions a named artefact)" : " (does not mention a named artefact)"}`
      : "no test file changed in this diff.",
  ];
  return {
    tokens,
    tokensPresent,
    tokensAbsent,
    allTokensAbsent: tokens.length > 0 && tokensPresent.length === 0,
    testsChanged,
    factLines,
  };
}

// ---------------------------------------------------------------------------
// AC4: Jev use — one `noul` question per checkable criterion, redacted
// relevant hunks selected by AC2's tokens, bounded to the 64k budget.
// ---------------------------------------------------------------------------

/** The vendor's documented combined `state`+`questions` budget (mirrors `jev-client.ts`'s `JEV_TOKEN_BUDGET`). */
export const AC_CHECK_TOKEN_BUDGET = 64_000;

/** A structural stand-in for `JevQuestion` (`type: "noul"`) — see the file header. */
export interface AcCheckQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

function questionFor(criterion: AcCriterion): AcCheckQuestion {
  return {
    type: "noul",
    instructions:
      `Given the deterministic facts and the redacted diff evidence above, does this change LIKELY SATISFY this frozen ` +
      `acceptance criterion? Criterion ${criterion.id}: ${redactSensitiveText(criterion.text)}`,
  };
}

/**
 * A generic token (`/model`, `--json`, a one-word command) can match dozens
 * of regions in a large diff, and every one of them is embedded verbatim in
 * `state`. Capped rather than left unbounded — AC9's live check (flow 328)
 * hit a real vendor `HTTP 400 max_tokens_exceeded` on a genuinely large PR
 * before this cap existed. The SMALLEST matching regions are kept first: a
 * compact, targeted hunk reads more like "the evidence for this token" than
 * an arbitrary large one, and more of them fit inside the same budget.
 */
const MAX_MATCHED_HUNKS_PER_ITEM = 8;

/** Diff regions whose text mentions at least one of the criterion's tokens — the "selected by the AC2 tokens" evidence AC4 asks for. */
export function selectMatchedHunks(facts: AcFacts, regions: readonly ScopedRegion[]): ScopedRegion[] {
  if (facts.tokens.length === 0) return [];
  const matched = regions.filter((region) => facts.tokens.some((token) => region.text.includes(token) || region.path.includes(token)));
  if (matched.length <= MAX_MATCHED_HUNKS_PER_ITEM) return matched;
  return [...matched].sort((a, b) => a.text.length - b.text.length).slice(0, MAX_MATCHED_HUNKS_PER_ITEM);
}

export interface AcCheckItem {
  readonly criterion: AcCriterion;
  readonly facts: AcFacts;
  readonly matchedHunks: readonly ScopedRegion[];
  readonly changedFiles: readonly string[];
}

function renderItemState(item: AcCheckItem): string {
  const evidence =
    item.matchedHunks.length > 0
      ? item.matchedHunks.map((region) => `--- ${region.path}\n@@ ${region.startLine},${region.endLine} @@\n${redactSensitiveText(region.text)}`).join("\n\n")
      : `no diff hunk matched this criterion's named artefacts; files changed in this diff: ${
          item.changedFiles.length > 0 ? item.changedFiles.join(", ") : "(none)"
        }`;
  return [`### ${item.criterion.id}`, ...item.facts.factLines, "", evidence].join("\n");
}

export interface AcCheckBatch {
  readonly items: readonly AcCheckItem[];
  readonly state: string;
  readonly questions: Readonly<Record<string, AcCheckQuestion>>;
}

/**
 * Headroom below the vendor-documented {@link AC_CHECK_TOKEN_BUDGET}, same
 * idea as `conform-jev.ts`'s `QUESTIONS_BUDGET_FRACTION`. Measured, not
 * guessed: flow 328's own AC9 live check got a real `HTTP 400
 * max_tokens_exceeded` from a batch this module's own `estimateTokens`
 * scored comfortably under 64k — `estimateTokens` is a chars/4 heuristic
 * (`src/review/cost.ts`), not a real tokenizer, and the vendor's actual
 * accounting (message envelope, `noul` schema per question) costs more than
 * the raw text alone. Packing to a fraction of the documented ceiling is
 * cheaper than getting this exactly right, and a batch that still comes back
 * over-budget degrades to `factsOnlyVerdict` per item rather than losing the
 * whole check (see the adapter's `try`/`catch` around each batch).
 */
const BATCH_BUDGET_FRACTION = 0.5;

/** How many criteria one batch combines, regardless of estimated size — a second guard against a handful of huge, single-criterion states. */
const MAX_ITEMS_PER_BATCH = 6;

/**
 * Pack every checkable item into as few `/systemone` requests as fit the
 * budget — same greedy-pack shape `src/review/conform-jev.ts`'s
 * `batchConformItems` uses, adapted because here each item carries its OWN
 * evidence text (matched hunks differ per criterion) rather than one shared
 * blob. Deterministic and pure — no network, no Jev call.
 */
export function batchAcCheckItems(items: readonly AcCheckItem[]): AcCheckBatch[] {
  const batches: AcCheckBatch[] = [];
  let current: AcCheckItem[] = [];
  const effectiveBudget = AC_CHECK_TOKEN_BUDGET * BATCH_BUDGET_FRACTION;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      items: current,
      state: current.map(renderItemState).join("\n\n"),
      questions: Object.fromEntries(current.map((item) => [item.criterion.id, questionFor(item.criterion)])),
    });
    current = [];
  };

  for (const item of items) {
    const attempt = [...current, item];
    const stateTokens = estimateTokens(attempt.map(renderItemState).join("\n\n"));
    const questionsTokens = estimateTokens(attempt.map((i) => `${i.criterion.id}:noul:${questionFor(i.criterion).instructions}`).join("\n"));
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

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type AcCheckStatus = "likely-met" | "not-evident" | "not-checkable";

export interface AcCheckVerdict {
  readonly id: string;
  readonly text: string;
  readonly status: AcCheckStatus;
  readonly probability?: number;
  readonly factLines: readonly string[];
  readonly evidencePaths: readonly string[];
  readonly notCheckableReason?: string;
}

/** Below this Jev `noul` score, a criterion is reported `not-evident` rather than `likely-met`. */
export const DEFAULT_AC_CHECK_THRESHOLD = 0.5;

export function notCheckableVerdict(criterion: AcCriterion, reason: string): AcCheckVerdict {
  return { id: criterion.id, text: criterion.text, status: "not-checkable", factLines: [], evidencePaths: [], notCheckableReason: reason };
}

export function evaluatedVerdict(item: AcCheckItem, probability: number, threshold: number = DEFAULT_AC_CHECK_THRESHOLD): AcCheckVerdict {
  return {
    id: item.criterion.id,
    text: item.criterion.text,
    status: probability >= threshold ? "likely-met" : "not-evident",
    probability,
    factLines: item.facts.factLines,
    evidencePaths: item.matchedHunks.map((region) => region.path),
  };
}

/**
 * AC4's degrade path: without Jev configured (or reachable), a checkable
 * criterion is reported `not-evident` — the facts are printed, but with no
 * model call nothing supports "likely met". `allTokensAbsent` is already
 * visible in `factLines`; this never upgrades a criterion to `likely-met` on
 * facts alone, which would be the model's job, not this function's.
 */
export function factsOnlyVerdict(item: AcCheckItem): AcCheckVerdict {
  return {
    id: item.criterion.id,
    text: item.criterion.text,
    status: "not-evident",
    factLines: item.facts.factLines,
    evidencePaths: item.matchedHunks.map((region) => region.path),
  };
}

// ---------------------------------------------------------------------------
// Opt-in gate (AC4): `review.jev.ac_check` in `.metaproject/tasks.config.json`
// — same shape, same fail-closed reading as `readCiTriageEnabled`/
// `readConformEnabled`.
// ---------------------------------------------------------------------------

export async function readAcCheckEnabled(cwd: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const review = (parsed as Record<string, unknown>)["review"];
    if (typeof review !== "object" || review === null) return false;
    const jev = (review as Record<string, unknown>)["jev"];
    if (typeof jev !== "object" || jev === null) return false;
    return (jev as Record<string, unknown>)["ac_check"] === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AC8: cache key — (criteria checksum, diff hash).
// ---------------------------------------------------------------------------

export function hashDiff(diffText: string): string {
  return createHash("sha256").update(diffText).digest("hex");
}

export function acCheckCacheKey(criteriaChecksum: string, diffText: string): string {
  return `${criteriaChecksum}:${hashDiff(diffText)}`;
}

/**
 * AC8's on-disk record: `.metaproject/data/ac-check/<flow-dir>.json`, 0600,
 * gitignored (`.gitignore`'s `.metaproject/data/ac-check/` entry). Owned here
 * (core) rather than by the adapter so the TUI (client — allowed to import
 * core, never adapter, per `src/lib/import-zones.ts`) can read a flow's
 * cached markers for AC7 without reaching into `src/commands/`.
 */
export interface AcCheckCacheRecord {
  readonly key: string;
  readonly at: string;
  readonly jevAsked: boolean;
  readonly jevError?: string;
  readonly usage?: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  readonly verdicts: readonly AcCheckVerdict[];
}

export function acCheckCachePath(cwd: string, flowDir: string): string {
  return path.join(cwd, ".metaproject", "data", "ac-check", `${flowDir}.json`);
}

export async function readAcCheckCache(cachePath: string): Promise<AcCheckCacheRecord | undefined> {
  if (!(await pathExists(cachePath))) return undefined;
  try {
    return JSON.parse(await readFile(cachePath, "utf8")) as AcCheckCacheRecord;
  } catch {
    return undefined;
  }
}

export async function writeAcCheckCache(cachePath: string, record: AcCheckCacheRecord): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFileAtomic(cachePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(cachePath, 0o600).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABEL: Readonly<Record<AcCheckStatus, string>> = {
  "likely-met": "likely met",
  "not-evident": "not evident",
  "not-checkable": "not checkable",
};

export function statusLabel(status: AcCheckStatus): string {
  return STATUS_LABEL[status];
}

export interface AcCheckSummaryCounts {
  readonly likelyMet: number;
  readonly notEvident: number;
  readonly notCheckable: number;
}

export function summarizeVerdicts(verdicts: readonly AcCheckVerdict[]): AcCheckSummaryCounts {
  return {
    likelyMet: verdicts.filter((v) => v.status === "likely-met").length,
    notEvident: verdicts.filter((v) => v.status === "not-evident").length,
    notCheckable: verdicts.filter((v) => v.status === "not-checkable").length,
  };
}

/**
 * The full, multi-line report `keryx flow check-ac` prints (text mode).
 * Always ADVISORY — never a pass/fail gate.
 *
 * `at`/`criteriaChecksum`/`diffHash` are the full cache key
 * (`acCheckCacheKey`'s `(criteriaChecksum, diffHash)` pair) plus when it was
 * computed — review finding: a report with no visible key gives a reader no
 * way to tell a fresh check from a stale one just by reading the file, which
 * is exactly the fact AC6's/AC7's freshness checks exist to surface. Optional
 * only so a caller with no cache record yet (nothing has ever run) can still
 * render a report; every caller that HAS a cache record — a live run, a cache
 * hit, or `review ingest`'s attachment — always supplies them.
 */
export function renderAcCheckReport(input: {
  readonly flowId: string;
  readonly verdicts: readonly AcCheckVerdict[];
  readonly jevAsked: boolean;
  readonly usage?: { readonly jevCalls: number; readonly costUsd?: number };
  readonly at?: string;
  readonly criteriaChecksum?: string;
  readonly diffHash?: string;
}): string {
  const counts = summarizeVerdicts(input.verdicts);
  const lines: string[] = [
    `# Acceptance-criteria check (ADVISORY) — flow ${input.flowId}`,
    "",
    "This is Jev's/deterministic opinion, never a gate: it never changes flow state and never confirms an AC.",
    "",
    `checked: ${input.at ?? "unknown"}   criteria checksum: ${input.criteriaChecksum ?? "unknown"}   diff hash: ${input.diffHash ?? "unknown"}`,
    `likely met: ${counts.likelyMet}   not evident: ${counts.notEvident}   not checkable: ${counts.notCheckable}`,
    input.jevAsked ? `Jev was asked${input.usage ? ` (${input.usage.jevCalls} call(s)${input.usage.costUsd !== undefined ? `, ≈$${input.usage.costUsd.toFixed(4)}` : ""})` : ""}.` : "Jev was NOT asked (not configured, or nothing checkable) — deterministic evidence only below.",
    "",
  ];
  for (const verdict of input.verdicts) {
    lines.push(`## ${verdict.id} — ${statusLabel(verdict.status)}${verdict.probability !== undefined ? ` (≈${Math.round(verdict.probability * 100)}%)` : ""}`);
    lines.push(verdict.text);
    if (verdict.notCheckableReason !== undefined) {
      lines.push(verdict.notCheckableReason);
    }
    for (const factLine of verdict.factLines) {
      lines.push(`  - ${factLine}`);
    }
    if (verdict.evidencePaths.length > 0) {
      lines.push(`  evidence: ${verdict.evidencePaths.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The one-paragraph advisory notice `flow implemented`/`flow complete` print (AC5) — never blocking. */
export function renderAcCheckAdvisoryNotice(verdicts: readonly AcCheckVerdict[]): string {
  const counts = summarizeVerdicts(verdicts);
  const inDoubt = verdicts.filter((v) => v.status === "not-evident").map((v) => v.id);
  return (
    `acceptance-criteria check (advisory): ${counts.likelyMet} likely met, ${counts.notEvident} not evident, ${counts.notCheckable} not checkable` +
    (inDoubt.length > 0 ? ` — in doubt: ${inDoubt.join(", ")}` : "") +
    ` (\`keryx flow check-ac\` for detail)`
  );
}

/** Markdown section attached to a review package (AC6). */
export function renderAcCheckMarkdown(input: { readonly flowId: string; readonly verdicts: readonly AcCheckVerdict[]; readonly jevAsked: boolean }): string {
  return renderAcCheckReport({ flowId: input.flowId, verdicts: input.verdicts, jevAsked: input.jevAsked });
}
