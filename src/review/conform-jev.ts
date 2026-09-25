// Reference-document conformance mode — flow 308, AC5/AC6 of the frozen
// acceptance criteria: turn a checkable clause's deterministic facts +
// redacted state into a Jev `noul` question, batch clauses of the same kind
// under the 64k budget, and compute the reported verdict.
//
// CORE ZONE — see `src/review/conform-clauses.ts`'s file header for why this
// never imports `src/harness/decision/jev-client.ts` (the same
// `src/review/ci-triage.ts` discipline). `CONFORM_TOKEN_BUDGET` duplicates
// `jev-client.ts`'s `JEV_TOKEN_BUDGET` value rather than importing it — both
// name the vendor's documented 64k ceiling, and a core module may not reach
// across the zone boundary to read a client-owned constant.

import { estimateTokens } from "./cost";
import type { ReferenceClause } from "./conform-clauses";
import type { ClauseStateFacts } from "./conform-state";
// Through the security facade, not `security/redact` directly — the
// import-policy ratchet (`src/lib/import-policy.live.test.ts`) is at its cap,
// and every caller outside `src/security/` reaches redaction through
// `src/security/service.ts` (its own file header explains why).
import { redactSensitiveText } from "../security/service";

/** A structural stand-in for `JevQuestion` (`type: "noul"`) — see the file header. */
export interface ConformNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

/** The vendor's documented combined `state`+`questions` budget (mirrors `jev-client.ts`'s `JEV_TOKEN_BUDGET`). */
export const CONFORM_TOKEN_BUDGET = 64_000;

/** Leaves headroom for the redacted state text shared across a batch's questions. */
const QUESTIONS_BUDGET_FRACTION = 0.5;

export interface ConformBatchItem {
  readonly clause: ReferenceClause;
  readonly facts: ClauseStateFacts;
}

export interface ConformBatch {
  readonly items: readonly ConformBatchItem[];
  readonly state: string;
  readonly questions: Readonly<Record<string, ConformNoulQuestion>>;
}

/**
 * The reference document's own clause text is embedded into the Jev question
 * below — that is the feature (clause text IS sent to Jev), and it is opt-in
 * via `review.jev.conform`. Only SECRETS inside that clause text are stripped
 * first, the same `redactSensitiveText` pass every other piece of state
 * (PR title/body, report markdown, hunk text) already gets before it leaves
 * the machine — a reference document is operator-supplied text like any
 * other, not something exempt from the redaction floor.
 */
function questionFor(clause: ReferenceClause): ConformNoulQuestion {
  return {
    type: "noul",
    instructions:
      `Given the state above (deterministic facts, then the redacted underlying content), does the state SATISFY ` +
      `this clause from a reference document? Clause ${clause.clause_id}: ${redactSensitiveText(clause.text)}`,
  };
}

function renderFacts(items: readonly ConformBatchItem[]): string {
  return items
    .map((item) => [`### clause ${item.clause.clause_id}`, ...item.facts.factLines].join("\n"))
    .join("\n\n");
}

function renderState(items: readonly ConformBatchItem[], sharedRedactedText: string): string {
  return [renderFacts(items), "", "--- state ---", sharedRedactedText].join("\n");
}

function estimateQuestionsTokens(items: readonly ConformBatchItem[]): number {
  return estimateTokens(items.map((item) => `${item.clause.clause_id}:noul:${questionFor(item.clause).instructions}`).join("\n"));
}

/**
 * AC5: batch every checkable clause of ONE kind that shares `sharedRedactedText`
 * (one PR's title+body, one report's markdown, one hunk's text) into as few
 * `/systemone` requests as fit the 64k budget, splitting rather than
 * truncating a clause's facts or text. Deterministic and pure — no network,
 * no Jev call; the caller (the adapter) sends each returned batch's `state`+
 * `questions` through `callJevSystemOne`.
 */
export function batchConformItems(items: readonly ConformBatchItem[], sharedRedactedText: string): ConformBatch[] {
  const sharedTokens = estimateTokens(sharedRedactedText);
  const batches: ConformBatch[] = [];
  let current: ConformBatchItem[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      items: current,
      state: renderState(current, sharedRedactedText),
      questions: Object.fromEntries(current.map((item) => [item.clause.clause_id, questionFor(item.clause)])),
    });
    current = [];
  };

  for (const item of items) {
    const attempt = [...current, item];
    const factsTokens = estimateTokens(renderFacts(attempt));
    const questionsTokens = estimateQuestionsTokens(attempt);
    const total = sharedTokens + factsTokens + questionsTokens;
    const withinQuestionsShare = questionsTokens <= CONFORM_TOKEN_BUDGET * QUESTIONS_BUDGET_FRACTION;
    if (current.length > 0 && (total > CONFORM_TOKEN_BUDGET || !withinQuestionsShare)) {
      flush();
      current = [item];
    } else {
      current = attempt;
    }
  }
  flush();
  return batches;
}

export type ConformClauseStatus = "satisfied" | "likely-violated" | "not-checkable" | "not-evaluated";

/** Flow 326, AC1: where a hunk-kind verdict came from — set only on a verdict produced against one hunk region. */
export interface ConformHunkLocation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ConformVerdict {
  readonly clause_id: string;
  readonly state_kind: ReferenceClause["state_kind"];
  readonly status: ConformClauseStatus;
  readonly probability?: number;
  readonly factLines: readonly string[];
  readonly decisive?: { readonly satisfied: boolean; readonly reason: string };
  readonly reason?: string;
  /** Flow 326, AC1/AC2: the hunk this verdict was judged against, when it is one of possibly many for the same clause_id. */
  readonly location?: ConformHunkLocation;
  /** Flow 337, item 5: how the clause got its tag — carried straight through from {@link ReferenceClause.tag_source} into the report/JSON output, `"pre-classified"` included. */
  readonly tag_source: ReferenceClause["tag_source"];
}

/** Below this Jev `noul` score (AC7's default), a clause is treated as likely violated / explained under `--explain`. */
export const DEFAULT_CONFORM_THRESHOLD = 0.5;

/** A not-checkable clause — always reported (AC6/PLAN Phase 2 AC2), never dropped. */
export function notCheckableVerdict(clause: ReferenceClause): ConformVerdict {
  return {
    clause_id: clause.clause_id,
    state_kind: clause.state_kind,
    status: "not-checkable",
    factLines: [],
    tag_source: clause.tag_source,
    ...(clause.reason !== undefined ? { reason: clause.reason } : {}),
  };
}

/**
 * A checkable clause whose kind has no state supplied this run (AC6: "listed
 * as not evaluated"). Flow 326, AC3: a hunk-kind clause that lost its entire
 * `--max-hunk-calls` share carries a `reason` naming why — the caller (e.g.
 * `runConform`'s hunk scoring) passes one such as
 * `"skipped by --max-hunk-calls (0 of 12 hunks judged)"` rather than leaving
 * this indistinguishable from "no hunks existed at all in the diff".
 */
export function notEvaluatedVerdict(clause: ReferenceClause, reason?: string): ConformVerdict {
  return {
    clause_id: clause.clause_id,
    state_kind: clause.state_kind,
    status: "not-evaluated",
    factLines: [],
    tag_source: clause.tag_source,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** A checkable clause that WAS asked — Jev's probability decides `satisfied` vs `likely-violated` against `threshold`. */
export function evaluatedVerdict(
  clause: ReferenceClause,
  facts: ClauseStateFacts,
  probability: number,
  threshold: number = DEFAULT_CONFORM_THRESHOLD,
  location?: ConformHunkLocation,
): ConformVerdict {
  return {
    clause_id: clause.clause_id,
    state_kind: clause.state_kind,
    status: probability >= threshold ? "satisfied" : "likely-violated",
    probability,
    factLines: facts.factLines,
    tag_source: clause.tag_source,
    ...(facts.decisive !== undefined ? { decisive: facts.decisive } : {}),
    ...(location !== undefined ? { location } : {}),
  };
}

// ---------------------------------------------------------------------------
// Flow 326, AC3: bound hunk × clause Jev questions per run.
// ---------------------------------------------------------------------------

/** Flow 326, AC3's documented default: `--max-hunk-calls` caps hunk × clause questions per run. */
export const DEFAULT_MAX_HUNK_CALLS = 40;

/** Flow 326, AC1's documented default: `--max-hunks` further violating hunk locations shown per clause, beyond the worst. */
export const DEFAULT_MAX_HUNKS = 3;

export interface HunkBudgetResult<T> {
  /** The regions to actually score this run — a prefix of the input, kept in order. The union of every clause's own share: the longest a clause's quota goes. */
  readonly regions: readonly T[];
  readonly totalRegions: number;
  readonly skippedRegions: number;
  /**
   * How many of `regions` (a prefix, first-encountered-first) each hunk-kind
   * clause gets judged against — keyed by `clause_id`, same keys as the
   * `hunkClauseIds` passed in. A clause missing 0 here still has an entry (0
   * is a valid quota, not an absence) so a caller can always `.get(id) ?? 0`.
   */
  readonly judgedPerClause: ReadonlyMap<string, number>;
}

/**
 * AC3: cap the number of hunk × clause questions a run sends.
 *
 * When the budget covers at least one full round (`maxHunkCalls >=
 * hunkClauseIds.length`), every clause gets the same `floor(maxHunkCalls /
 * hunkClauseCount)` region budget — unchanged from the original design, and
 * what keeps every clause's report row directly comparable.
 *
 * When the budget is SMALLER than the clause count, `floor` alone would give
 * every clause 0 (rounds down to nothing) and silently drop every hunk-kind
 * clause from the report. Instead, the per-clause floor: while the budget
 * allows, give each clause (in the order given) 1 judged hunk before giving
 * any clause a 2nd — so a budget of `maxHunkCalls` with more clauses than
 * that spends itself on the first `maxHunkCalls` clauses (1 hunk each) and
 * leaves the rest at 0, rather than spending it on nobody. Those 0-quota
 * clauses are what the caller reports as not-evaluated (AC3), not silently
 * vanished.
 *
 * A prefix of the input regions is kept (deterministic, first-encountered/
 * diff order), and the rest are reported as skipped rather than silently
 * dropped. `hunkClauseIds` empty or no regions at all needs no bounding:
 * there is nothing to ask.
 */
export function boundHunkRegions<T>(
  regions: readonly T[],
  hunkClauseIds: readonly string[],
  maxHunkCalls: number = DEFAULT_MAX_HUNK_CALLS,
): HunkBudgetResult<T> {
  if (hunkClauseIds.length === 0 || regions.length === 0) {
    const judgedPerClause = new Map(hunkClauseIds.map((id) => [id, regions.length]));
    return { regions, totalRegions: regions.length, skippedRegions: 0, judgedPerClause };
  }
  const clauseCount = hunkClauseIds.length;
  const base = Math.max(0, Math.floor(maxHunkCalls / clauseCount));
  const perClauseQuota =
    base >= 1
      ? hunkClauseIds.map(() => base)
      : hunkClauseIds.map((_, i) => (i < maxHunkCalls ? 1 : 0));
  const judgedPerClause = new Map(hunkClauseIds.map((id, i) => [id, Math.min(regions.length, perClauseQuota[i]!)]));
  const maxJudged = Math.max(0, ...judgedPerClause.values());
  const kept = regions.slice(0, maxJudged);
  return { regions: kept, totalRegions: regions.length, skippedRegions: regions.length - kept.length, judgedPerClause };
}

/**
 * Flow 326, AC3: which of `hunkClauseIds` still have a judged slot at
 * `index` (0-based) into `boundHunkRegions`'s own `regions` prefix — a clause
 * whose quota is shorter than another's stops appearing once `index` passes
 * its own quota, letting a caller score one region for only the clauses that
 * still want it (the per-clause floor means quotas can differ per clause).
 */
export function activeClausesAt(judgedPerClause: ReadonlyMap<string, number>, index: number, hunkClauseIds: readonly string[]): readonly string[] {
  return hunkClauseIds.filter((id) => (judgedPerClause.get(id) ?? 0) > index);
}

// ---------------------------------------------------------------------------
// Flow 326, AC1/AC2: per-clause aggregation — one row per clause, not one
// row per hunk × clause. Pure, synchronous, no I/O.
// ---------------------------------------------------------------------------

export interface ConformAggregateHunk {
  readonly location: ConformHunkLocation;
  readonly probability: number;
}

export interface ConformClauseAggregate {
  readonly clause_id: string;
  readonly state_kind: ReferenceClause["state_kind"];
  readonly status: ConformClauseStatus;
  /** Flow 337, item 5: the clause's own {@link ReferenceClause.tag_source} — the same across every hunk verdict for this clause_id, so the first is representative. */
  readonly tag_source: ReferenceClause["tag_source"];
  /** 0 for a not-checkable/not-evaluated clause, or a pr/report-kind clause (which is never scored per-hunk). */
  readonly hunksJudged: number;
  readonly hunksBelowThreshold: number;
  /** The single worst-scoring judged hunk, hunk-kind clauses only. */
  readonly worst?: ConformAggregateHunk;
  /** Up to `--max-hunks` further violating hunk locations, beyond `worst`, most severe first. */
  readonly furtherViolations: readonly ConformAggregateHunk[];
  /** A single-verdict clause's own evidence (pr/report-kind, or not-checkable); empty for a hunk-kind clause — see `detail`. */
  readonly factLines: readonly string[];
  readonly probability?: number;
  readonly decisive?: { readonly satisfied: boolean; readonly reason: string };
  readonly reason?: string;
  /** The raw verdict the worst/probability figures above were computed from — reused for `--explain`, never rendered directly. */
  readonly worstVerdict?: ConformVerdict;
  /** The full per-hunk detail behind this row — always available under `--json` (nested per clause) and `--detail`. */
  readonly detail: readonly ConformVerdict[];
}

function byAscendingProbability(a: ConformVerdict, b: ConformVerdict): number {
  return (a.probability ?? 0) - (b.probability ?? 0);
}

/**
 * AC2: group verdicts by `clause_id` and reduce each group to one row.
 *
 * - A not-checkable/not-evaluated clause has exactly one verdict (never asked
 *   per-hunk) and passes through unchanged.
 * - A pr/report-kind clause likewise has exactly one verdict (its state is
 *   shared across the whole target, not per-hunk) and passes through with its
 *   own probability/decisive/factLines at the top level.
 * - A hunk-kind clause can have one verdict per judged hunk (AC3's budget
 *   permitting): `likely-violated` when ANY retained hunk falls below the
 *   threshold, `satisfied` only when EVERY judged hunk is at or above it
 *   (ties — probability === threshold — read as satisfied, matching
 *   `evaluatedVerdict`'s own `>=` comparison, computed once there and never
 *   re-derived here). An empty set of hunk verdicts cannot reach this
 *   function at all — `notEvaluatedVerdict` is what a caller uses instead —
 *   so "no hunks" is covered by the not-evaluated pass-through above.
 */
export function aggregateConformVerdicts(verdicts: readonly ConformVerdict[], maxHunks: number = DEFAULT_MAX_HUNKS): ConformClauseAggregate[] {
  const order: string[] = [];
  const byClause = new Map<string, ConformVerdict[]>();
  for (const verdict of verdicts) {
    let group = byClause.get(verdict.clause_id);
    if (group === undefined) {
      group = [];
      byClause.set(verdict.clause_id, group);
      order.push(verdict.clause_id);
    }
    group.push(verdict);
  }

  return order.map((clauseId): ConformClauseAggregate => {
    const group = byClause.get(clauseId)!;
    const first = group[0]!;

    if (first.status === "not-checkable" || first.status === "not-evaluated") {
      return {
        clause_id: first.clause_id,
        state_kind: first.state_kind,
        status: first.status,
        tag_source: first.tag_source,
        hunksJudged: 0,
        hunksBelowThreshold: 0,
        furtherViolations: [],
        factLines: first.factLines,
        detail: group,
        ...(first.reason !== undefined ? { reason: first.reason } : {}),
      };
    }

    const withLocation = group.filter((v) => v.location !== undefined);
    if (withLocation.length === 0) {
      // pr/report-kind: exactly one verdict, no per-hunk multiplicity.
      return {
        clause_id: first.clause_id,
        state_kind: first.state_kind,
        status: first.status,
        tag_source: first.tag_source,
        hunksJudged: 0,
        hunksBelowThreshold: 0,
        furtherViolations: [],
        factLines: first.factLines,
        detail: group,
        worstVerdict: first,
        ...(first.probability !== undefined ? { probability: first.probability } : {}),
        ...(first.decisive !== undefined ? { decisive: first.decisive } : {}),
      };
    }

    // hunk-kind: one verdict per judged hunk.
    const sorted = [...withLocation].sort(byAscendingProbability);
    const worstVerdict = sorted[0]!;
    const belowThreshold = withLocation.filter((v) => v.status === "likely-violated").length;
    const status: ConformClauseStatus = belowThreshold > 0 ? "likely-violated" : "satisfied";
    const furtherViolations: ConformAggregateHunk[] = sorted
      .slice(1)
      .filter((v) => v.status === "likely-violated")
      .slice(0, maxHunks)
      .map((v) => ({ location: v.location!, probability: v.probability ?? 0 }));

    return {
      clause_id: first.clause_id,
      state_kind: first.state_kind,
      status,
      tag_source: first.tag_source,
      hunksJudged: withLocation.length,
      hunksBelowThreshold: belowThreshold,
      worst: { location: worstVerdict.location!, probability: worstVerdict.probability ?? 0 },
      furtherViolations,
      factLines: [],
      detail: group,
      worstVerdict,
    };
  });
}
