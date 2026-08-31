// Flow 209, AC2 — `cross_family_review`, read back.
//
// # The defect this closes
//
// `keryx providers cross-family` computed a correct, opt-in, reasoned decision
// and printed it. Nothing read it. It shipped that way in `63b340d1`, whose own
// AC3 reads: *"A field nothing reads is the `attempts.count` defect repeated,
// and this flow exists to stop that class."* The measurement of 2026-08-31 found
// six occurrences of the name in `src/`, all in the command that emits it and
// its own test.
//
// Two options were on the table — give it a consumer or delete the field — and
// the field is kept, because the decision it carries is the only thing that can
// later answer "were these findings produced by a model of the same family that
// wrote the code?". Deleting it deletes the question.
//
// # What makes this a consumer and not a second producer
//
// `attempts.count` was green for a release while being written and read inside
// one process. So the rule here is stricter than "something calls it":
//
//   - `keryx review ingest --cross-family-review <file>` writes the block into
//     `manifest.json`, where it is durable and schema-validated.
//   - `keryx review status <ref>` — a LATER, SEPARATE invocation that shares no
//     memory with the ingest — reads it off disk, checks it, and **exits
//     non-zero** when the record contradicts itself.
//
// A reader that can only agree is not a reader. {@link checkCrossFamilyReview}
// is the half that can disagree.
//
// # Absent is not clean
//
// A package written before this existed carries no block, and a round that never
// ran `keryx providers cross-family` carries none either. Both report
// `not recorded` and exit 0 — that is a fact about the round, not a
// contradiction inside it — and neither is ever printed as `single-family`.

import type { CrossFamilyReviewDecision } from "../lib/provider-config";

/** One thing wrong with a persisted `cross_family_review` block. */
export type CrossFamilyReviewProblem = {
  /** `not-recorded` is reported and never fails; every other code fails. */
  code: "not-recorded" | "shape" | "contradiction";
  message: string;
};

const CROSS_FAMILY_MODES = ["cross-family", "single-family"] as const;

/**
 * Parse an emitted block into the decision it carries.
 *
 * Accepts both spellings the producer prints: the wrapper
 * `{"cross_family_review": {...}}` that `keryx providers cross-family --json`
 * writes, and the bare decision object. A caller that piped the command's output
 * to a file holds the first; a caller that extracted the block by hand holds the
 * second, and refusing that would be a trap rather than a check.
 *
 * Throws with the reason rather than returning `undefined`: an unreadable
 * `--cross-family-review` file must not degrade into "no block was supplied",
 * which is a different fact and the one that reads as clean.
 */
export function parseCrossFamilyReviewInput(raw: unknown, source: string): CrossFamilyReviewDecision {
  const candidate =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && "cross_family_review" in raw
      ? (raw as { cross_family_review: unknown }).cross_family_review
      : raw;
  const problems = checkCrossFamilyReview(candidate);
  if (problems.length > 0) {
    throw new Error(
      `${source} is not a usable cross_family_review block: ${problems
        .map((problem) => `[${problem.code}] ${problem.message}`)
        .join("; ")}. Produce one with \`keryx providers cross-family --json\`.`,
    );
  }
  return candidate as CrossFamilyReviewDecision;
}

/**
 * Read a persisted `cross_family_review` back and say whether it holds together.
 *
 * Shaped after {@link module:review/filter-stats.checkFilterStats}, deliberately:
 * the same rule that makes `filter_stats` a real record makes this one — the
 * consumer must be able to REFUSE, or it is a printer.
 *
 * Every contradiction below is a state the producer
 * ({@link module:lib/provider-config.decideCrossFamilyReview}) cannot reach. That
 * is the point: they are the states a hand-edited, hand-assembled or
 * wrong-version block reaches, and those are the ones that would otherwise let a
 * round claim a cross-family review that never happened.
 */
export function checkCrossFamilyReview(value: unknown): CrossFamilyReviewProblem[] {
  if (value === undefined || value === null) {
    return [
      {
        code: "not-recorded",
        message:
          "cross_family_review: not recorded. The round did not run `keryx providers cross-family`, or the package predates the field. This is NOT `single-family` — nobody decided.",
      },
    ];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [{ code: "shape", message: "cross_family_review is not an object." }];
  }
  const record = value as Record<string, unknown>;
  const problems: CrossFamilyReviewProblem[] = [];
  const shape = (message: string): void => {
    problems.push({ code: "shape", message });
  };
  const contradiction = (message: string): void => {
    problems.push({ code: "contradiction", message });
  };

  if (record.schemaVersion !== 1) {
    shape(`schemaVersion must be 1; found ${JSON.stringify(record.schemaVersion)}.`);
  }
  const mode = record.mode;
  if (typeof mode !== "string" || !(CROSS_FAMILY_MODES as readonly string[]).includes(mode)) {
    shape(`mode must be one of ${CROSS_FAMILY_MODES.join(", ")}; found ${JSON.stringify(mode)}.`);
  }
  if (typeof record.requested !== "boolean") {
    shape(`requested must be a boolean; found ${JSON.stringify(record.requested)}.`);
  }
  for (const field of ["author_family", "reviewer_family", "reviewer_provider", "reviewer_model"]) {
    const held = record[field];
    if (held !== null && typeof held !== "string") {
      shape(`${field} must be a string or null; found ${JSON.stringify(held)}.`);
    }
  }
  if (typeof record.reason !== "string" || record.reason.trim() === "") {
    // The one field with no honest empty value. `mode` alone cannot be audited
    // later; the reason is what makes `single-family` distinguishable from a
    // decision nobody took.
    shape("reason must be a non-empty string — the decision is unreadable later without it.");
  }
  const candidates = record.candidates;
  if (!Array.isArray(candidates)) {
    shape(`candidates must be an array; found ${JSON.stringify(candidates)}.`);
  }
  if (problems.length > 0) {
    return problems;
  }

  const reviewerFamily = record.reviewer_family as string | null;
  const reviewerProvider = record.reviewer_provider as string | null;
  const authorFamily = record.author_family as string | null;
  const options = candidates as Array<Record<string, unknown>>;

  if (mode === "cross-family") {
    if (record.requested !== true) {
      contradiction(
        "mode is `cross-family` while requested is false. Cross-family review is opt-in; a granted review nobody asked for means the record was assembled rather than decided.",
      );
    }
    if (reviewerFamily === null || reviewerProvider === null) {
      contradiction(
        "mode is `cross-family` but the reviewer family or provider is null. `cross-family` without naming the other side cannot be grouped later, which is the whole reason the block exists.",
      );
    }
    if (reviewerFamily !== null && reviewerFamily === authorFamily) {
      contradiction(
        `mode is \`cross-family\` and the reviewer family (${reviewerFamily}) is the family that authored the change. That is a single-family review recorded as a cross-family one.`,
      );
    }
    if (
      reviewerFamily !== null &&
      !options.some((option) => option.family === reviewerFamily && option.provider === reviewerProvider)
    ) {
      contradiction(
        `the chosen reviewer (${reviewerFamily} via ${reviewerProvider}) is not among the ${options.length} candidate(s) recorded on the decision. A reviewer that was never an option was not chosen from them.`,
      );
    }
  } else {
    if (reviewerFamily !== null || reviewerProvider !== null || record.reviewer_model !== null) {
      contradiction(
        "mode is `single-family` while a reviewer family, provider or model is named. Single-family review has no other side; naming one says a dispatch happened that the mode denies.",
      );
    }
  }

  return problems;
}

/** The one-line form, for the terminal. `not recorded` is never printed as a decision. */
export function renderCrossFamilyReviewLine(decision: CrossFamilyReviewDecision | undefined): string {
  if (decision === undefined) {
    return "cross_family_review: not recorded (no --cross-family-review supplied to this ingest; this is NOT `single-family`)";
  }
  const reviewer =
    decision.mode === "cross-family"
      ? `${decision.reviewer_family ?? "?"} via ${decision.reviewer_provider ?? "?"}${
          decision.reviewer_model === null ? "" : ` (${decision.reviewer_model})`
        }`
      : "none (single-family review)";
  return `cross_family_review: mode=${decision.mode} requested=${decision.requested ? "yes" : "no"} author_family=${
    decision.author_family ?? "not classified"
  } reviewer=${reviewer} candidates=${decision.candidates.length}`;
}
