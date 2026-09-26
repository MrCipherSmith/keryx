// review-jev-select — flow 344, `keryx review jev-select`.
//
// Reviewer (sub-agent) SELECTION is the lever the measurement programme
// named as the most promising and the LEAST measured: `review-orchestrator`
// dispatches roughly two dozen sub-agent reviewers per round, each a
// separate strong-model run, and nothing before this asked "does THIS
// reviewer have anything to say about THIS diff" before paying for all of
// them. Everything else Jev was tried on in this programme has a verdict —
// CI triage proven, review-jev-risk/contract/rules measured weaker than a
// strong model — and this is deliberately the one still being measured, so
// the policy below is written to fail toward keeping a reviewer rather than
// dropping one:
//
//   - a candidate is skipped ONLY when its scored probability is BELOW the
//     configured threshold (`review.jev.select_skip_below`, default 0.15 —
//     see `jev-select-config.ts`);
//   - the core safety set (`CORE_MANDATORY_REVIEWER_IDS`) is never skipped,
//     whatever Jev answers;
//   - any error — no opt-in, no credential, a failed call, a malformed
//     answer — keeps EVERY remaining candidate rather than dropping any of
//     them. `src/commands/review-jev-select.ts` is where that fail-open
//     policy is enforced; this module only computes decisions from answers
//     it was actually given.
//
// CORE ZONE (`src/lib/import-zones.ts`): this module never imports the
// client-zone Jev client (`src/harness/decision/jev-client.ts`) — the same
// split `src/review/jev-risk.ts`'s own header documents. Its adapter,
// `src/commands/review-jev-select.ts`, is where this module's
// question/state shapes meet the real client.

import { estimateTokens } from "./cost";
import type { ScopedRegion } from "./scope";

/** One reviewer this round could dispatch — the candidate `keryx review jev-select` scores. */
export interface ReviewerCandidate {
  readonly id: string;
  /** The reviewer's own routing description, when one is available. */
  readonly description?: string;
}

export type JevSelectVerdict = "keep" | "skip";

export interface JevSelectDecision {
  readonly reviewer: string;
  /** Jev's own `noul` answer, `0..1` — `1` for a decision made without asking Jev (mandatory, disabled, fail-open). */
  readonly probability: number;
  readonly decision: JevSelectVerdict;
  readonly reason: string;
}

/**
 * Reviewers this round never drops, whatever Jev answers — matching
 * `review-orchestrator` SKILL.md's own Wave A definition verbatim: "core
 * correctness/risk reviewers: logic, architecture, security/highload when
 * selected." `review-architecture`/`review-highload` are only ever
 * CANDIDATES to begin with when the round already selected them (via a flag
 * or auto-detection) — being in `jev-select`'s candidate list at all IS
 * "when selected" — so once they are candidates, jev-select must not be the
 * thing that drops them. Kept as an exported, named list (rather than a
 * convention buried in prose) because a caller that needs to know "will
 * this ever be skipped" should not have to re-derive it from the threshold
 * logic.
 */
export const CORE_MANDATORY_REVIEWER_IDS: readonly string[] = [
  "review-logic",
  "review-architecture",
  "review-security-code",
  "review-highload",
];

export function isCoreMandatoryReviewer(id: string): boolean {
  return CORE_MANDATORY_REVIEWER_IDS.includes(id);
}

/** The compact facts `keryx review jev-select` puts in front of Jev — no full diff, no full reviewer catalog prose. */
export interface DiffSummaryForSelect {
  readonly files: readonly string[];
  readonly fileTypes: readonly string[];
  /** Hunk text samples, already trimmed to the state budget. */
  readonly sampleHunks: readonly string[];
  /** How many hunks were retained vs. how many the diff actually carried, before trimming. */
  readonly hunksRetained: number;
  readonly hunksTotal: number;
}

/** File-extension classifier shared with nothing else here on purpose — this only needs a rough type label, not `scope.ts`'s stack-detection depth. */
export function fileTypeOf(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "(no extension)" : base.slice(dot);
}

/** Default state budget for the diff summary half of the Jev call — leaves the rest of `JEV_TOKEN_BUDGET` (64k) for the reviewer-description questions. */
export const DEFAULT_SELECT_STATE_BUDGET_TOKENS = 20_000;

/**
 * Build the diff summary from retained scope regions, trimming sampled hunks
 * to `budgetTokens` (estimated). Regions are taken in order; a region that
 * would push the running estimate over budget is skipped rather than
 * truncated mid-hunk — a partial hunk reads as a smaller, calmer change than
 * the diff actually is, which is the wrong direction to bias a selection call.
 */
export function summarizeDiffForSelect(
  regions: readonly ScopedRegion[],
  files: readonly string[],
  budgetTokens: number = DEFAULT_SELECT_STATE_BUDGET_TOKENS,
): DiffSummaryForSelect {
  const fileTypes = [...new Set(files.map(fileTypeOf))].sort();
  const sampleHunks: string[] = [];
  let used = 0;
  let retained = 0;
  for (const region of regions) {
    const text = `${region.path}:${region.startLine}-${region.endLine}\n${region.text}`;
    const cost = estimateTokens(text);
    if (used + cost > budgetTokens) continue;
    sampleHunks.push(text);
    used += cost;
    retained += 1;
  }
  return { files, fileTypes, sampleHunks, hunksRetained: retained, hunksTotal: regions.length };
}

/** The `state` string every `jev-select` question batch shares. */
export function buildJevSelectState(summary: DiffSummaryForSelect): string {
  const lines = [
    "# diff summary for reviewer selection",
    "",
    `files changed: ${summary.files.length}`,
    `file types: ${summary.fileTypes.join(", ") || "(none)"}`,
    `hunks sampled: ${summary.hunksRetained} of ${summary.hunksTotal}`,
    "",
    "changed files:",
    ...summary.files.map((file) => `- ${file}`),
    "",
    "sampled hunks:",
    "",
    ...summary.sampleHunks,
  ];
  return lines.join("\n");
}

/** The `noul` question one candidate reviewer is asked. Kept short and uniform — the description carries the reviewer-specific signal. */
export function questionInstructionsFor(candidate: ReviewerCandidate): string {
  const described = candidate.description !== undefined && candidate.description.length > 0 ? ` — ${candidate.description}` : "";
  return (
    `Reviewer "${candidate.id}"${described}. Given the diff summary above, how likely is this reviewer to be ` +
    "applicable to this diff and to find something worth reporting? Answer as a noul (0 = certainly not applicable/nothing to find, 1 = certainly applicable and likely to find something)."
  );
}

/** A stable per-candidate answer key — `q:<id>`, so an answer can be matched back to its candidate even after batching splits the question set. */
export function answerKeyFor(candidateId: string): string {
  return `q:${candidateId}`;
}

/** One batch of candidates whose combined question set fits the Jev budget alongside `stateTokens`. */
export interface JevSelectBatch {
  readonly candidates: readonly ReviewerCandidate[];
  readonly questions: Readonly<Record<string, { readonly type: "noul"; readonly instructions: string }>>;
}

/**
 * Split `candidates` into batches whose `state` + questions stays under
 * `budgetTokens` (default: the full `JEV_TOKEN_BUDGET`, minus what `stateText`
 * already spent). One reviewer question is small — this only matters when
 * the candidate set is unusually large or descriptions are unusually long;
 * the common case (this project's ~27 bundled reviewers) is one batch.
 */
export function batchSelectQuestions(
  candidates: readonly ReviewerCandidate[],
  stateText: string,
  budgetTokens: number,
): JevSelectBatch[] {
  const stateTokens = estimateTokens(stateText);
  const perBatchBudget = Math.max(budgetTokens - stateTokens, 0);
  const batches: JevSelectBatch[] = [];
  let current: ReviewerCandidate[] = [];
  let currentQuestions: Record<string, { type: "noul"; instructions: string }> = {};
  let used = 0;
  for (const candidate of candidates) {
    const instructions = questionInstructionsFor(candidate);
    const cost = estimateTokens(`${answerKeyFor(candidate.id)}:${instructions}`);
    if (current.length > 0 && used + cost > perBatchBudget) {
      batches.push({ candidates: current, questions: currentQuestions });
      current = [];
      currentQuestions = {};
      used = 0;
    }
    current.push(candidate);
    currentQuestions[answerKeyFor(candidate.id)] = { type: "noul", instructions };
    used += cost;
  }
  if (current.length > 0) {
    batches.push({ candidates: current, questions: currentQuestions });
  }
  return batches;
}

/**
 * Turn scored answers into decisions. `answers` carries only the candidates
 * Jev actually answered (a caller that stopped early on an error passes a
 * partial map); anything missing from it is treated as "kept, fail-open" —
 * this function itself never fails a candidate closed.
 */
export function decideCandidates(
  candidates: readonly ReviewerCandidate[],
  answers: ReadonlyMap<string, number>,
  skipBelow: number,
  fallbackReason: string = "no Jev answer for this reviewer — kept (fail-open)",
): JevSelectDecision[] {
  return candidates.map((candidate) => {
    if (isCoreMandatoryReviewer(candidate.id)) {
      const probability = answers.get(candidate.id) ?? 1;
      return {
        reviewer: candidate.id,
        probability,
        decision: "keep",
        reason: "core safety set (Wave A: logic/architecture/security/highload) — never skipped by jev-select",
      };
    }
    const probability = answers.get(candidate.id);
    if (probability === undefined) {
      return { reviewer: candidate.id, probability: 1, decision: "keep", reason: fallbackReason };
    }
    if (probability < skipBelow) {
      return {
        reviewer: candidate.id,
        probability,
        decision: "skip",
        reason: `probability ${probability.toFixed(2)} is below the recall-first skip threshold ${skipBelow} — advisory only, unmeasured lever`,
      };
    }
    return {
      reviewer: candidate.id,
      probability,
      decision: "keep",
      reason: `probability ${probability.toFixed(2)} is at/above the skip threshold ${skipBelow}`,
    };
  });
}

/** Every decision kept without an unqualified fail-open reason — i.e. a candidate `review.jev.select` is meant to gate all disabled/errored runs into. */
export function allKeptFailOpen(candidates: readonly ReviewerCandidate[], reason: string): JevSelectDecision[] {
  return candidates.map((candidate) => ({ reviewer: candidate.id, probability: 1, decision: "keep", reason }));
}

export interface JevSelectResult {
  readonly decisions: readonly JevSelectDecision[];
  readonly skipBelow: number;
  readonly summary: string;
}

export function summarizeDecisions(decisions: readonly JevSelectDecision[], skipBelow: number): JevSelectResult {
  const kept = decisions.filter((decision) => decision.decision === "keep").length;
  const skipped = decisions.length - kept;
  return {
    decisions,
    skipBelow,
    summary: `${decisions.length} candidate(s) scored: ${kept} kept, ${skipped} skipped (threshold ${skipBelow}).`,
  };
}

/** The heading `--out` writes and readers look for, matching `BLAST_RADIUS_HEADING`'s own convention. */
export const JEV_SELECT_HEADING = "## Jev reviewer selection (advisory)";

const JEV_SELECT_BLOCK = /^## Jev reviewer selection \(advisory\)[^\n]*\n[\s\S]*?(?=^## (?!#)|$(?![\s\S]))/m;

/** Same replace-not-append rule `upsertBlastRadiusBlock` documents: three rounds must not leave three contradictory blocks. */
export function upsertJevSelectBlock(text: string, block: string): string {
  const body = `${block.trimEnd()}\n`;
  if (JEV_SELECT_BLOCK.test(text)) {
    return `${text.replace(JEV_SELECT_BLOCK, () => `${body}\n`).trimEnd()}\n`;
  }
  return text.trimEnd() === "" ? body : `${text.trimEnd()}\n\n${body}`;
}

export function renderJevSelectMarkdown(result: JevSelectResult): string {
  const lines = [
    JEV_SELECT_HEADING,
    "",
    result.summary,
    "",
    "Advisory only — a skip here removes a reviewer from Wave A/B dispatch, never from the report; " +
      "record every decision so skipped-reviewer domains can be checked against later rounds " +
      "(review-orchestrator SKILL.md, \"Dispatching Reviewers\").",
    "",
    "| reviewer | decision | probability | reason |",
    "|---|---|---|---|",
    ...result.decisions.map(
      (decision) => `| ${decision.reviewer} | ${decision.decision} | ${decision.probability.toFixed(2)} | ${decision.reason.replace(/\|/g, "\\|")} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
