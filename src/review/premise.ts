/**
 * The premise merge: what a premise judgement may do to a finding (flow 459, AC1/AC2).
 *
 * ## Why a second delete-only judge
 *
 * The verifier asks whether a finding's FACTS hold: it runs something, and "`dir=\"ltr\"` is
 * hard-coded" always reproduces. It cannot ask whether the finding's REQUEST is right — whether the
 * hard-coded value is a deliberate choice that accepted platform practice supports (media controls
 * and timelines do not mirror in RTL). A finding that passed every reviewer law and the verifier was
 * implemented, reviewed twice for its implementation only, and closed by the owner. `review-premise`
 * asks the missing question on a clean context, claim first, and answers `upheld`, `downgraded`,
 * `challenged` or `owner-decision`.
 *
 * ## The invariant this module holds
 *
 * **Nothing here adds a finding, raises a severity, edits a finding's text, or dismisses a finding.**
 * The merged record is the ORIGINAL finding plus a `premise` and, for `downgraded` only, a strictly
 * lower `severity`. `challenged` and `owner-decision` do not remove anything: they HOLD the finding
 * (see {@link premiseHoldState}) until the operator answers, and only the operator's `dismiss` ends
 * its life. As in the verifier merge, every rejection path leaves the finding exactly as it was: a
 * claim can cost a verdict, never a finding.
 *
 * The judge is never the reviewer that raised the finding (nor one of the reviewers a duplicate merge
 * folded into it): the reporter is the one actor whose agreement says nothing about the premise.
 */

import { createHash } from "node:crypto";
import { actorKey } from "./verification";
import {
  HELD_PREMISE_VERDICTS,
  PREMISE_VERDICTS,
  REVIEW_FINDING_SEVERITIES,
  type PremiseClaimInput,
  type PremiseOperatorAnswer,
  type PremiseIntentSignal,
  type PremisePracticeSource,
  type PremiseVerdict,
  type ReviewFindingPremise,
  type ReviewFindingSeverity,
  type StructuredReviewFinding,
} from "./types";
import type { PremiseDecisionSubject, PremiseQuestionDecision } from "./operator-decisions";

/** The only properties a claim may carry. Anything else is a shape the judge has no authority over. */
export const PREMISE_CLAIM_PROPERTIES = [
  "finding_id",
  "verdict",
  "severity",
  "intent_signals",
  "practice_sources",
  "reasoning",
  "question",
  "options",
] as const;

/** The properties of the claims file itself. */
export const PREMISE_FILE_PROPERTIES = ["judge", "model", "premises"] as const;

/** Where the claims are stored, relative to the package directory. */
export const PREMISES_FILE = "research-evidence/premises.json";
/** Where an ingest without `--premises` moves an earlier ingest's claims file: kept as the record, never re-read. */
export const PREMISES_SUPERSEDED_FILE = "research-evidence/premises.superseded.json";

/** Why a claim was discarded. Every one of these leaves the finding as it was. */
export const PREMISE_REJECTION_REASONS = [
  "malformed-claim",
  "no-judge",
  "unknown-property",
  "unknown-finding",
  "ambiguous-finding",
  "already-judged",
  "below-minor",
  "unknown-verdict",
  "self-judgement",
  "external-downgrade",
  "security-downgrade",
  "severity-without-downgrade",
  "not-a-downgrade",
  "downgrade-below-threshold",
  "raise-severity",
  "malformed-field",
  "challenged-without-evidence",
  "downgrade-without-evidence",
  "held-without-question",
  "owner-decision-without-options",
  "duplicate-claim",
] as const;
export type PremiseRejectionReason = (typeof PREMISE_REJECTION_REASONS)[number];

export type PremiseRejection = {
  /** The finding the claim named, verbatim, so an unresolvable one is still legible. */
  finding: string;
  reason: PremiseRejectionReason;
  /** What was wrong, in words, rendered into the review record. */
  detail: string;
};

export type PremiseCounts = {
  judge?: string | undefined;
  /** Claims received, including the ones discarded. */
  claims: number;
  /** Claims whose verdict reached a finding. `claims = applied + rejected`. */
  applied: number;
  rejected: number;
  /** The rest count findings that carry a premise afterwards, carried ones included. */
  upheld: number;
  downgraded: number;
  challenged: number;
  ownerDecision: number;
  /** `challenged + ownerDecision`: findings waiting for an operator decision. */
  held: number;
  findingsIn: number;
};

export type PremiseMergeResult<T> = {
  /** Every input finding, in order: nothing is removed here. */
  findings: T[];
  rejections: PremiseRejection[];
  counts: PremiseCounts;
};

/** A parsed claims file: the judge named once, the claims flattened. */
export type ParsedPremiseClaims = {
  judge?: string | undefined;
  model?: string | undefined;
  claims: PremiseClaimInput[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Marks an entry of `premises` that was not an object, with its position. A symbol, so no claim can spell it. */
const MALFORMED_CLAIM = Symbol("malformed-claim");
type MalformedClaim = PremiseClaimInput & { [MALFORMED_CLAIM]: number };
/** How a claim without a usable `finding_id` is named in a rejection row. */
const UNNAMED_CLAIM = "<unnamed>";
/** The reviewer whose findings a premise judge may hold but never downgrade. */
const SECURITY_REVIEWER = "review-security-code";
/** Width of a one-line problem statement in scope.md, ellipsis included. */
const MAX_LINE_CHARS = 160;
const ELLIPSIS = "...";

/**
 * Read a premise claims file: a bare object `{ judge, model?, premises: [...] }`. A bare array is refused
 * because it names no judge, and the never-judge-your-own-finding rule cannot be checked against nobody.
 */
export function parsePremiseClaims(source: unknown): ParsedPremiseClaims | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (!isRecord(source)) {
    throw new Error(
      "A premise result must be an object `{ judge, model?, premises: [...] }`, not an array or a bare value. Nothing was merged.",
    );
  }
  const extra = Object.keys(source).filter((key) => !(PREMISE_FILE_PROPERTIES as readonly string[]).includes(key));
  if (extra.length > 0) {
    throw new Error(
      `A premise result carries ${extra.sort().join(", ")}, which it may not: only ${PREMISE_FILE_PROPERTIES.join(", ")}. Nothing was merged.`,
    );
  }
  if (!Array.isArray(source.premises)) {
    throw new Error("A premise result needs `premises: [...]`. Nothing was merged.");
  }
  // An entry that is not an object still counts as a claim received, and the merge rejects it as `malformed-claim`
  // naming its position: dropping it here would make `claims = applied + rejected` false.
  const claims = source.premises.map((claim, index): PremiseClaimInput => (isRecord(claim) ? { ...claim } : ({ [MALFORMED_CLAIM]: index } as MalformedClaim)));
  return {
    ...(present(source.judge) ? { judge: source.judge.trim() } : {}),
    ...(present(source.model) ? { model: source.model.trim() } : {}),
    claims,
  };
}

export function isPremiseVerdict(value: unknown): value is PremiseVerdict {
  return typeof value === "string" && (PREMISE_VERDICTS as readonly string[]).includes(value);
}

/** Whether a verdict holds the finding for the operator. */
export function isHeldVerdict(verdict: unknown): boolean {
  return typeof verdict === "string" && (HELD_PREMISE_VERDICTS as readonly string[]).includes(verdict);
}

function severityRank(severity: ReviewFindingSeverity): number {
  // REVIEW_FINDING_SEVERITIES is ordered blocker-first, so a lower index is worse.
  return REVIEW_FINDING_SEVERITIES.length - REVIEW_FINDING_SEVERITIES.indexOf(severity);
}

function isSeverity(value: unknown): value is ReviewFindingSeverity {
  return typeof value === "string" && (REVIEW_FINDING_SEVERITIES as readonly string[]).includes(value);
}

function isMalformed(claim: PremiseClaimInput): claim is MalformedClaim {
  return MALFORMED_CLAIM in claim;
}

function claimName(claim: PremiseClaimInput): string {
  if (isMalformed(claim)) return `premises[${claim[MALFORMED_CLAIM]}]`;
  return typeof claim.finding_id === "string" && claim.finding_id !== "" ? claim.finding_id : UNNAMED_CLAIM;
}

/**
 * Whether `key` (a `merged_from` entry, a global_id `<reviewId>#<id>`) names `id`: the key itself, or its display-id
 * part. The judge runs before ingest mints global_ids, so its claim names the display id it was shown.
 */
function mergedKeyNames(key: string, id: string): boolean {
  if (key === id) return true;
  const hash = key.lastIndexOf("#");
  return hash >= 0 && !id.includes("#") && key.slice(hash + 1) === id;
}

/**
 * The findings a claim names: by `global_id` or `id`, else (review LG8-002) the canonical finding whose `merged_from`
 * lists it, by its global_id or by the bare display id the judge saw. The judge runs before ingest's duplicate merge,
 * so a claim may name a key the merge folded into another record; it targets the record that survived, and two claims
 * landing there cancel as `duplicate-claim`.
 */
function claimTargets<T extends StructuredReviewFinding>(findings: readonly T[], id: unknown): T[] {
  const direct = findings.filter((finding) => finding.global_id === id || finding.id === id);
  if (direct.length > 0 || typeof id !== "string" || id === "") return direct;
  return findings.filter((finding) => finding.merged_from?.some((key) => mergedKeyNames(key, id)) === true);
}

/** The severities a `downgraded` premise may land on: `minor` is the floor, and nothing is downgraded to `blocker`. */
const DOWNGRADE_TARGETS: readonly ReviewFindingSeverity[] = ["major", "minor"];

/**
 * A finding that arrived already carrying a premise (carried into a delta round) keeps the judgement, never an operator
 * answer: an answer counts only from the package's decisions store, and `--findings` is written by an agent, which
 * cannot answer for the operator.
 *
 * A `premise.severity` that disagrees with `finding.severity` is stale (review LG2-002). A `downgraded` premise keeps
 * the finding's severity only while that is still a downgrade the merge could have made (major or minor, strictly
 * below `original_severity`); otherwise the downgrade no longer describes the finding, and the premise is dropped so
 * the finding stands unjudged at its own severity, never as a downgrade the schema rejects. Any other verdict carries
 * no severity, so a stray one is removed.
 */
function normaliseCarriedPremise<T extends StructuredReviewFinding>(finding: T): T {
  const premise = finding.premise;
  if (premise === undefined) return finding;
  const stale = premise.severity !== undefined && premise.severity !== finding.severity;
  const stray = premise.verdict !== "downgraded" && (premise.severity !== undefined || premise.original_severity !== undefined);
  if (premise.operator === undefined && !stale && !stray) return finding;
  const { operator: _operator, ...judgement } = premise;
  if (premise.verdict !== "downgraded") {
    const { severity: _severity, original_severity: _original, ...rest } = judgement;
    return { ...finding, premise: rest } as T;
  }
  if (!stale) return { ...finding, premise: judgement } as T;
  const original = premise.original_severity;
  const stillADowngrade = DOWNGRADE_TARGETS.includes(finding.severity) && isSeverity(original) && severityRank(finding.severity) < severityRank(original);
  if (!stillADowngrade) {
    const { premise: _dropped, ...unjudged } = finding;
    return unjudged as T;
  }
  return { ...finding, premise: { ...judgement, severity: finding.severity } } as T;
}

type Field<V> = { ok: true; value: V | undefined } | { ok: false; detail: string };

function signalList<V extends Record<string, string>>(value: unknown, field: string, keys: readonly [string, string]): Field<V[]> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return { ok: false, detail: `\`${field}\` must be an array of { ${keys[0]}, ${keys[1]} }.` };
  }
  const out: V[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !keys.includes(key)) || !present(entry[keys[0]]) || !present(entry[keys[1]])) {
      return { ok: false, detail: `every \`${field}\` entry needs exactly a non-empty ${keys[0]} and ${keys[1]}.` };
    }
    out.push({ [keys[0]]: (entry[keys[0]] as string).trim(), [keys[1]]: (entry[keys[1]] as string).trim() } as V);
  }
  return { ok: true, value: out };
}

type Accepted<T> = { finding: T; premise: ReviewFindingPremise };

/**
 * Apply premise claims to findings, deleting nothing and adding nothing.
 *
 * The findings are not mutated: each returned entry is the original, or a new object built from the
 * original plus a `premise` (and, for `downgraded`, the lower severity). A finding that already carries
 * a premise (carried into a delta round) keeps it, and a claim naming it is rejected as `already-judged`.
 */
export function mergePremises<T extends StructuredReviewFinding>(
  findings: readonly T[],
  parsed: ParsedPremiseClaims | undefined,
): PremiseMergeResult<T> {
  const claims = parsed?.claims ?? [];
  const judge = parsed?.judge;
  const rejections: PremiseRejection[] = [];
  const accepted = new Map<string, Array<Accepted<T>>>();

  for (const claim of claims) {
    const name = claimName(claim);
    const reject = (reason: PremiseRejectionReason, detail: string): void => {
      rejections.push({ finding: name, reason, detail });
    };
    if (isMalformed(claim)) {
      reject("malformed-claim", "this entry of `premises` is not an object, so it names no finding and carries no verdict.");
      continue;
    }
    if (judge === undefined || actorKey(judge) === "") {
      reject("no-judge", "the premise file names no judge, so the never-judge-your-own-finding rule cannot be checked.");
      continue;
    }
    const extra = Object.keys(claim)
      .filter((key) => !(PREMISE_CLAIM_PROPERTIES as readonly string[]).includes(key))
      .sort();
    if (extra.length > 0) {
      // Discarded WHOLE: a judge that tried to carry a property it has no authority over has told us what it
      // believes it may do, and taking the verdict from it anyway would accept the half we happen to allow.
      reject("unknown-property", `the claim carried ${extra.join(", ")}. A premise judge can only hold or lower; it cannot add a finding, raise a severity, or change a finding's text.`);
      continue;
    }

    const matches = claimTargets(findings, claim.finding_id);
    if (matches.length === 0) {
      reject("unknown-finding", "this round reported no such finding. A premise judge cannot introduce one.");
      continue;
    }
    if (matches.length > 1) {
      reject("ambiguous-finding", `names ${matches.length} findings; use the global_id (${matches.map((finding) => finding.global_id ?? finding.id).join(", ")}).`);
      continue;
    }
    const target = matches[0] as T;
    if (target.premise !== undefined) {
      reject("already-judged", "this finding already carries a premise (carried from an earlier round); it is kept, not re-judged.");
      continue;
    }
    if (target.severity === "info") {
      reject("below-minor", "premise judgement covers findings of severity minor and above; an `info` finding asks for nothing to act on.");
      continue;
    }
    if (!isPremiseVerdict(claim.verdict)) {
      reject("unknown-verdict", `verdict ${JSON.stringify(claim.verdict)} is not one of ${PREMISE_VERDICTS.join(", ")}.`);
      continue;
    }
    const verdict = claim.verdict;
    const raisedBy = [target.reviewer, ...(target.reported_by ?? [])];
    if (raisedBy.some((reviewer) => actorKey(reviewer) === actorKey(judge))) {
      reject("self-judgement", `${judge} raised this finding (recorded as ${raisedBy.join(", ")}) and cannot judge its premise. Dispatch a different judge.`);
      continue;
    }

    let severity: ReviewFindingSeverity | undefined;
    if (claim.severity !== undefined && verdict !== "downgraded") {
      reject("severity-without-downgrade", `\`severity\` is only meaningful with \`downgraded\`, and this verdict is \`${verdict}\`.`);
      continue;
    }
    if (verdict === "downgraded") {
      if (target.source === "external") {
        reject("external-downgrade", "a comment somebody else left on the PR is not re-graded by a machine: challenge it with a question instead.");
        continue;
      }
      // A security finding's severity measures exposure; a sign that the shape was chosen does not make it less
      // exploitable. It may be held with a question, and then the operator decides.
      if (raisedBy.some((reviewer) => actorKey(reviewer) === actorKey(SECURITY_REVIEWER))) {
        reject("security-downgrade", `a ${SECURITY_REVIEWER} finding is never downgraded by a premise judge: uphold it, or hold it with \`challenged\` / \`owner-decision\` for the operator.`);
        continue;
      }
      if (!isSeverity(claim.severity)) {
        reject("not-a-downgrade", `\`downgraded\` needs a \`severity\` (one of ${REVIEW_FINDING_SEVERITIES.join(", ")}) strictly lower than ${target.severity}.`);
        continue;
      }
      if (severityRank(claim.severity) > severityRank(target.severity)) {
        reject("raise-severity", `${claim.severity} is higher than the finding's ${target.severity}. A premise judge can only lower a severity.`);
        continue;
      }
      if (claim.severity === target.severity) {
        reject("not-a-downgrade", `\`downgraded\` to ${claim.severity} changes nothing: the finding is already ${target.severity}. Use \`upheld\`.`);
        continue;
      }
      // `minor` is the fix-loop threshold (flow-orchestrator Phase 4): a downgrade may shrink a
      // finding, never take it out of the fix loop. Below it only the operator decides.
      if (claim.severity === "info") {
        reject("downgrade-below-threshold", "`downgraded` stops at `minor`, the fix-loop threshold: a premise judge may shrink a finding, never take it out of the fix. Hold it with `challenged` or `owner-decision` instead.");
        continue;
      }
      severity = claim.severity;
    }

    const signals = signalList<PremiseIntentSignal>(claim.intent_signals, "intent_signals", ["ref", "says"]);
    if (!signals.ok) {
      reject("malformed-field", signals.detail);
      continue;
    }
    const sources = signalList<PremisePracticeSource>(claim.practice_sources, "practice_sources", ["name", "says"]);
    if (!sources.ok) {
      reject("malformed-field", sources.detail);
      continue;
    }
    if (claim.reasoning !== undefined && typeof claim.reasoning !== "string") {
      reject("malformed-field", "`reasoning` must be a string.");
      continue;
    }

    // A downgrade is a premise judgement too, never a re-grade against the severity rubric: the
    // reviewer and the verifier already own the rubric. Without a cited intent signal or practice
    // source, a downgrade is the judge re-scoring a finding it has no new evidence about.
    if (verdict === "downgraded" && (signals.value?.length ?? 0) + (sources.value?.length ?? 0) === 0) {
      reject("downgrade-without-evidence", "`downgraded` needs at least one intent signal (a cited ref) or practice source (a named guideline) showing the defect is smaller than reported. Re-grading against the severity rubric is not the premise judge's call: use `upheld`.");
      continue;
    }

    let question: string | undefined;
    let options: string[] | undefined;
    if (isHeldVerdict(verdict)) {
      if (verdict === "challenged" && (signals.value?.length ?? 0) + (sources.value?.length ?? 0) === 0) {
        reject("challenged-without-evidence", "`challenged` needs at least one intent signal (a cited ref) or practice source (a named guideline). A challenge with neither is the reviewer's argument turned around.");
        continue;
      }
      if (!present(claim.question)) {
        reject("held-without-question", `\`${verdict}\` holds the finding for the operator, who needs a question to answer.`);
        continue;
      }
      question = claim.question.trim();
      if (verdict === "owner-decision") {
        const raw = claim.options;
        if (!Array.isArray(raw) || raw.length < 2 || !raw.every(present)) {
          reject("owner-decision-without-options", "`owner-decision` needs at least two options, each a non-empty string, so the operator is choosing rather than guessing.");
          continue;
        }
        options = raw.map((option: string) => option.trim());
      } else if (Array.isArray(claim.options) && claim.options.length >= 2 && claim.options.every(present)) {
        options = (claim.options as string[]).map((option) => option.trim());
      }
    }

    const premise: ReviewFindingPremise = {
      verdict,
      judge,
      ...(parsed?.model === undefined ? {} : { model: parsed.model }),
      ...(severity === undefined ? {} : { severity, original_severity: target.severity }),
      ...(signals.value === undefined || signals.value.length === 0 ? {} : { intent_signals: signals.value }),
      ...(sources.value === undefined || sources.value.length === 0 ? {} : { practice_sources: sources.value }),
      ...(present(claim.reasoning) ? { reasoning: claim.reasoning.trim() } : {}),
      ...(question === undefined ? {} : { question }),
      ...(options === undefined ? {} : { options }),
    };
    const key = target.global_id ?? target.id;
    accepted.set(key, [...(accepted.get(key) ?? []), { finding: target, premise }]);
  }

  // A finding claimed twice keeps neither claim. Taking the first would let claim order decide whether a
  // finding is held, and the safe resolution of a conflict is the one that holds nothing.
  const applied = new Map<string, ReviewFindingPremise>();
  let appliedClaims = 0;
  for (const [key, group] of accepted) {
    if (group.length === 1) {
      applied.set(key, (group[0] as Accepted<T>).premise);
      appliedClaims += 1;
      continue;
    }
    // One row per discarded claim: `claims = applied + rejected` counts every claim.
    for (let index = 0; index < group.length; index += 1) {
      rejections.push({ finding: key, reason: "duplicate-claim", detail: `${group.length} claims name this finding. None is applied: claim order must not decide whether it is held.` });
    }
  }

  const out = findings.map((finding) => {
    const premise = applied.get(finding.global_id ?? finding.id);
    if (premise === undefined) {
      return normaliseCarriedPremise(finding);
    }
    // The ORIGINAL plus a premise and, for `downgraded`, the lower severity. Nothing else from the claim reaches it.
    return { ...finding, ...(premise.severity === undefined ? {} : { severity: premise.severity }), premise } as T;
  });

  const counts: PremiseCounts = {
    ...(judge === undefined ? {} : { judge }),
    claims: claims.length,
    applied: appliedClaims,
    rejected: rejections.length,
    upheld: 0,
    downgraded: 0,
    challenged: 0,
    ownerDecision: 0,
    held: 0,
    findingsIn: findings.length,
  };
  for (const finding of out) {
    const verdict = finding.premise?.verdict;
    if (verdict === "upheld") counts.upheld += 1;
    else if (verdict === "downgraded") counts.downgraded += 1;
    else if (verdict === "challenged") counts.challenged += 1;
    else if (verdict === "owner-decision") counts.ownerDecision += 1;
  }
  counts.held = counts.challenged + counts.ownerDecision;
  return { findings: out, rejections, counts };
}

// ---------------------------------------------------------------------------
// Held findings and the operator's answer
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

/** The finding keys a decision may name: `global_id` first, then `id`. */
function keysOf(record: Loose): string[] {
  return [record.global_id, record.id].filter((key): key is string => typeof key === "string" && key !== "");
}

/** Dispositions that say the finding was fixed (the verdict's own set). */
const RESOLVED_DISPOSITIONS: ReadonlySet<string> = new Set(["acted-on", "fixed"]);

/**
 * Whether the record already has an outcome that lifts a premise hold: refuted by the verifier, or acted on. A
 * `dismissed*` disposition does not (review SEC2-002): it is text in findings.json, which an agent writes, and the hold
 * exists to keep exactly that decision for the operator. Only the operator's decisions store dismisses a held finding.
 */
function hasTerminalOutcome(record: Loose): boolean {
  if (isRecord(record.verification) && record.verification.verdict === "refuted") return true;
  const state = isRecord(record.disposition) ? record.disposition.state : undefined;
  return typeof state === "string" && RESOLVED_DISPOSITIONS.has(state);
}

/** sha256 hex of a problem statement, whitespace-normalised so a re-wrapped line hashes the same. */
function problemSha256(problem: unknown): string {
  return createHash("sha256").update(typeof problem === "string" ? problem.replace(/\s+/g, " ").trim() : "").digest("hex");
}

/**
 * What the operator is shown of a held finding, and what a decision is bound to: its severity, the judge's verdict and
 * its problem text. `undefined` for a finding without a premise.
 */
export function premiseSubjectOf(record: Loose): PremiseDecisionSubject | undefined {
  const premise = isRecord(record.premise) ? record.premise : undefined;
  if (premise === undefined || typeof premise.verdict !== "string") return undefined;
  return { severity: typeof record.severity === "string" ? record.severity : "unknown", verdict: premise.verdict, problemSha256: problemSha256(record.problem) };
}

function sameSubject(a: PremiseDecisionSubject, b: PremiseDecisionSubject | undefined): boolean {
  return b !== undefined && a.severity === b.severity && a.verdict === b.verdict && a.problemSha256 === b.problemSha256;
}

/**
 * The latest decision that answers THIS finding: it names one of the finding's keys and was given for what the finding
 * still is (see {@link premiseSubjectOf}). A decision recorded for another finding under a reused id, or before the
 * finding's severity, verdict or problem changed, answers nothing.
 */
export function latestPremiseDecision(record: Loose, decisions: readonly PremiseQuestionDecision[]): PremiseQuestionDecision | undefined {
  const keys = keysOf(record);
  const subject = premiseSubjectOf(record);
  return decisions.filter((decision) => keys.includes(decision.finding) && sameSubject(decision.subject, subject)).at(-1);
}

export type PremiseHoldState =
  /** No premise, one that does not hold the finding, or a held finding that already has another outcome. */
  | "none"
  /** Held, and the operator has not answered. */
  | "awaiting"
  /** Held, and the operator said uphold: the finding is kept at its original severity. */
  | "upheld"
  /** Held, and the operator said dismiss. */
  | "dismissed";

/**
 * Where a finding stands against its premise judgement: the one rule the verdict, readiness, the flow gate and the
 * answer commands share. A hold is lifted only by an operator decision from the package's decisions store
 * (`decisions`). `premise.operator` on the record is the audit trail of an answer already applied, never an answer of
 * its own: a finding record an agent wrote cannot answer for the operator. A held finding with no answer that the
 * verifier refuted, or that was acted on, waits for nobody, and is `none`, as the verdict classifies it; a `dismissed*`
 * disposition without an operator decision leaves it `awaiting`.
 */
export function premiseHoldState(record: Loose, decisions: readonly PremiseQuestionDecision[] = []): PremiseHoldState {
  const premise = isRecord(record.premise) ? record.premise : undefined;
  if (premise === undefined || !isHeldVerdict(premise.verdict)) {
    return "none";
  }
  const decided = latestPremiseDecision(record, decisions);
  if (decided !== undefined) {
    return decided.answer === "uphold" ? "upheld" : "dismissed";
  }
  return hasTerminalOutcome(record) ? "none" : "awaiting";
}

/** Ids (`global_id` when there is one) of the findings that wait for an operator decision. */
export function awaitingOperator(records: readonly Loose[], decisions: readonly PremiseQuestionDecision[] = []): string[] {
  return records.filter((record) => premiseHoldState(record, decisions) === "awaiting").map((record) => keysOf(record)[0] ?? UNNAMED_CLAIM);
}

/**
 * Apply the operator's answer to a finding. Pure; `answerPremiseQuestion` (./premise-question.ts) writes the result to
 * findings.json, so the readers that know nothing of premises (the round-to-round carry, the published round block)
 * see it.
 *
 * - `uphold` — the finding is kept at its ORIGINAL severity: a premise that was held by `challenged` carries no
 *   severity change, and the answer is recorded on `premise.operator`.
 * - `dismiss` — the finding is recorded `dismissed-incorrect` with the operator's reason as the evidence, unless
 *   it already carries a disposition (an outcome somebody recorded is not overwritten by an answer).
 *
 * A later answer replaces an earlier one, including the `dismissed-incorrect` an earlier `dismiss` wrote. A finding
 * that is not held, or that the decision does not answer (see {@link latestPremiseDecision}), is returned unchanged.
 */
export function applyPremiseDecision<T extends object>(finding: T, decision: PremiseQuestionDecision): T {
  const record = finding as unknown as Loose;
  const premise = isRecord(record.premise) ? record.premise : undefined;
  if (premise === undefined || !isHeldVerdict(premise.verdict) || latestPremiseDecision(record, [decision]) === undefined) {
    return finding;
  }
  const operator: PremiseOperatorAnswer = {
    answer: decision.answer,
    reason: decision.reason,
    quote: decision.quote,
    at: decision.at,
    actor: decision.actor,
    confirmedVia: decision.confirmedVia,
  };
  const { disposition: existing, ...rest } = record;
  const current = isRecord(existing) ? existing : undefined;
  // A `dismissed-incorrect` an earlier premise answer wrote belongs to that answer, and goes with it.
  const ownDismissal = isRecord(premise.operator) && premise.operator.answer === "dismiss" && current?.state === "dismissed-incorrect";
  const open = ownDismissal || current === undefined || current.state === undefined || current.state === "unknown";
  return {
    ...(ownDismissal ? rest : record),
    premise: { ...premise, operator },
    ...(decision.answer === "dismiss" && open
      ? { disposition: { state: "dismissed-incorrect", evidence: `operator (${decision.confirmedVia}, ${decision.at}) on the premise question: ${decision.reason}` } }
      : {}),
  } as unknown as T;
}

/** {@link applyPremiseDecision} over a list, with the LATEST decision that answers each finding. */
export function applyPremiseDecisions<T extends object>(findings: readonly T[], decisions: readonly PremiseQuestionDecision[]): T[] {
  return findings.map((finding) => {
    const decision = latestPremiseDecision(finding as unknown as Loose, decisions);
    return decision === undefined ? finding : applyPremiseDecision(finding, decision);
  });
}

// ---------------------------------------------------------------------------
// scope.md
// ---------------------------------------------------------------------------

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function oneLine(value: string): string {
  const first = (value.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
  return first.length > MAX_LINE_CHARS ? `${first.slice(0, MAX_LINE_CHARS - ELLIPSIS.length)}${ELLIPSIS}` : first;
}

export type PremiseRenderInput = {
  counts: PremiseCounts;
  rejections: readonly PremiseRejection[];
  /** The round's findings, after the merge: the held ones are listed. */
  findings: readonly StructuredReviewFinding[];
};

/**
 * The `## Premise check` block of scope.md. Empty when no premise judge ran and no finding carries one: a
 * heading that always says `0` is noise, and its absence is the record that the stage did not run.
 */
export function renderPremiseMarkdown(input: PremiseRenderInput): string {
  const { counts, rejections } = input;
  const judged = counts.upheld + counts.downgraded + counts.held;
  if (counts.claims === 0 && judged === 0) {
    return "";
  }
  const lines: string[] = ["", "## Premise check", ""];
  lines.push(`premise_judge: ${counts.judge ?? "not named"}`);
  lines.push(`premise_claims_received: ${counts.claims}`);
  lines.push(`premise_claims_applied: ${counts.applied}`);
  lines.push(`premise_claims_rejected: ${counts.rejected}`);
  lines.push(`premise_upheld: ${counts.upheld}`);
  lines.push(`premise_downgraded: ${counts.downgraded}`);
  lines.push(`premise_challenged: ${counts.challenged}`);
  lines.push(`premise_owner_decision: ${counts.ownerDecision}`);
  lines.push(`premise_held: ${counts.held}`);
  lines.push("");
  lines.push("### Held for the operator (premise)");
  lines.push("");
  const held = input.findings.filter((finding) => isHeldVerdict(finding.premise?.verdict));
  if (held.length === 0) {
    lines.push("_none_");
  } else {
    lines.push("| finding | severity | verdict | question |");
    lines.push("|---|---|---|---|");
    for (const finding of held) {
      const premise = finding.premise as ReviewFindingPremise;
      const options = premise.options === undefined ? "" : ` Options: ${premise.options.join(" / ")}`;
      lines.push(`| ${escapePipes(finding.global_id ?? finding.id)} | ${finding.severity} | ${premise.verdict} | ${escapePipes(`${premise.question ?? oneLine(finding.problem)}${options}`)} |`);
    }
    lines.push("");
    lines.push("A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:");
    lines.push("`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason \"<why>\"`.");
  }
  lines.push("");
  lines.push("### Premise claims discarded");
  lines.push("");
  if (rejections.length === 0) {
    lines.push("_none_");
  } else {
    lines.push("| finding | reason | why |");
    lines.push("|---|---|---|");
    for (const rejection of rejections) {
      lines.push(`| ${escapePipes(rejection.finding)} | ${rejection.reason} | ${escapePipes(rejection.detail)} |`);
    }
    lines.push("");
    lines.push("Every discarded claim leaves its finding as it was: a claim can cost a verdict, never a finding.");
  }
  lines.push("");
  return lines.join("\n");
}
