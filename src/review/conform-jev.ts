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

export interface ConformVerdict {
  readonly clause_id: string;
  readonly state_kind: ReferenceClause["state_kind"];
  readonly status: ConformClauseStatus;
  readonly probability?: number;
  readonly factLines: readonly string[];
  readonly decisive?: { readonly satisfied: boolean; readonly reason: string };
  readonly reason?: string;
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
    ...(clause.reason !== undefined ? { reason: clause.reason } : {}),
  };
}

/** A checkable clause whose kind has no state supplied this run (AC6: "listed as not evaluated"). */
export function notEvaluatedVerdict(clause: ReferenceClause): ConformVerdict {
  return { clause_id: clause.clause_id, state_kind: clause.state_kind, status: "not-evaluated", factLines: [] };
}

/** A checkable clause that WAS asked — Jev's probability decides `satisfied` vs `likely-violated` against `threshold`. */
export function evaluatedVerdict(
  clause: ReferenceClause,
  facts: ClauseStateFacts,
  probability: number,
  threshold: number = DEFAULT_CONFORM_THRESHOLD,
): ConformVerdict {
  return {
    clause_id: clause.clause_id,
    state_kind: clause.state_kind,
    status: probability >= threshold ? "satisfied" : "likely-violated",
    probability,
    factLines: facts.factLines,
    ...(facts.decisive !== undefined ? { decisive: facts.decisive } : {}),
  };
}
