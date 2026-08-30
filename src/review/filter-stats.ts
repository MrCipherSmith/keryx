// `filter_stats` — what the round filtered, in a form a machine can check
// (roadmap §5.1, flow 207 AC1-AC3).
//
// WHY THIS FILE EXISTS
//
// Every stage of this pipeline already counted what it removed, and every one of
// those counts reached exactly one place: `scope.md`, as prose. A person could
// read "files_dropped: 2"; nothing else could. The roadmap states the stake in
// its own words — without a structured record, **no claim made in Phase 2 can be
// checked after the fact, and the roadmap becomes the next document asserting an
// unenforced property.**
//
// So the numbers are produced HERE, by {@link buildFilterStats}, from the stage
// results themselves — the pre-filter's drop rows, the verifier's counts, the
// scope-B screen's rejections, the findings cap's truncations. Nothing in this
// module parses `scope.md`. Re-deriving a count from the prose a renderer wrote
// would make the record a description of the renderer rather than of the round,
// and the renderer is the part most likely to change.
//
// THE ONE RULE
//
// **A stage that did not run reports `null`, never `0`.** Instrumentation that
// reports zero because nothing measured reads as a clean result, which is worse
// than no instrumentation at all. `review ingest` already says this out loud on
// the terminal — "pre-filter: not recorded (no --scope supplied; this is not
// `dropped 0`)" — and this module is that distinction made structural: every
// `null` count has a matching row in {@link ReviewFilterStats.not_measured}
// saying WHY it is null, and {@link checkFilterStats} refuses a record where the
// two disagree.
//
// UNITS, STATED ONCE
//
// `dropped_prefilter` counts DIFF material — whole files and change blocks
// removed before any reviewer read them. Every other count is FINDINGS. They are
// deliberately in one record because they are the same round's stages, and
// deliberately not summed together: the arithmetic {@link checkFilterStats}
// enforces runs over the finding stages alone.

import type { FindingsCapCounts, FindingsCapDrop } from "./caps";
import type { VerificationCounts } from "./verification";
import type { ReviewScopeCountsLike, ReviewScopeDropLike } from "./types";

/**
 * The stages that can remove something from a round.
 *
 * `low_confidence` is named by the roadmap and has no implementation, which is a
 * fact about the pipeline rather than an omission here: `confidence` is recorded
 * on every finding and nothing filters on it. It is carried as a permanent
 * `null` so that the day a confidence threshold IS added, the field it writes
 * into already exists and every record written before it says "not measured"
 * rather than "dropped nothing".
 */
export const REVIEW_FILTER_STAGES = [
  "prefilter",
  "low_confidence",
  "round_dismissed",
  "refuted",
  "scope_b",
  "findings_cap",
] as const;
export type ReviewFilterStage = (typeof REVIEW_FILTER_STAGES)[number];

/** The finding stages, in pipeline order. `retained` is `total` minus these. */
export const FINDING_FILTER_STAGES = ["refuted", "scope_b", "findings_cap"] as const;

/**
 * One stage that produced no number, and why.
 *
 * The reason is prose and it is the whole value of the row: `dropped_scope_b:
 * null` says a number is missing, and only "no blast-radius record reached this
 * ingest, so the screen did not run" says whether that is a defect or the normal
 * state.
 */
export type ReviewFilterNotMeasured = {
  stage: ReviewFilterStage;
  reason: string;
};

/**
 * What the round filtered.
 *
 * The five names the roadmap specifies — `total`, `dropped_prefilter`,
 * `dropped_low_confidence`, `dropped_refuted`, `retained`, `by_reason` — are
 * present verbatim. The rest is the superset the criterion allows, and it is
 * there because this pipeline genuinely has two more finding stages than the
 * roadmap knew about (the scope-B screen and the per-reviewer findings cap) and
 * one input channel that records dismissals rather than performing them.
 */
export type ReviewFilterStats = {
  schema_version: 1;
  /**
   * Findings that entered the filter pipeline: everything the reviewers
   * reported, internal and external, before any stage removed anything.
   *
   * NOT the size of `findings.json`, which also holds what the round dismissed.
   * See {@link dismissed_by_round}.
   */
  total: number | null;
  /**
   * Diff material the pre-filter removed before review — one per drop row, a
   * whole file or one change block.
   *
   * `null` when no `keryx review scope --json` document reached the ingest. It
   * is in a different unit from every other count here and is deliberately NOT
   * part of the `total`/`retained` arithmetic.
   */
  dropped_prefilter: number | null;
  /** Always `null` today. See {@link REVIEW_FILTER_STAGES}. */
  dropped_low_confidence: number | null;
  /** Findings a `refuted` verdict removed. `0` in `annotate`; `null` in `off`. */
  dropped_refuted: number | null;
  /** Findings the scope-B screen refused. `null` when the screen did not run. */
  dropped_scope_b: number | null;
  /** Findings the per-reviewer reading cap truncated. Always measured. */
  dropped_findings_cap: number | null;
  /** Findings the round reports as open: what a completion gate must act on. */
  retained: number | null;
  /**
   * Findings the round raised and dismissed itself, via the `--refuted` channel.
   *
   * Not a filter stage — these never entered {@link total}, so they are outside
   * the retained arithmetic. `null` when the caller passed no channel at all,
   * which is NOT `dismissed 0`: it is the unlogged triage flow 202 measured, in
   * which a corpus of survivors reported 100% precision.
   */
  dismissed_by_round: number | null;
  /**
   * Counted drops broken down by the reason the stage gave, keyed
   * `<stage>:<reason>`.
   *
   * A breakdown of what WAS counted, never the record of what was measured — a
   * stage that ran and dropped nothing contributes no key here and reports `0`
   * in its own field. The measured/not-measured distinction lives in the
   * `dropped_*` fields and in {@link not_measured}, and nowhere else.
   */
  by_reason: Record<string, number>;
  /** Every stage reporting `null`, with the reason. Sorted by stage. */
  not_measured: ReviewFilterNotMeasured[];
};

/**
 * The stage results, as the producer that ran them holds them.
 *
 * Structural rather than imported from `review/managed`, which is what imports
 * this module: the shapes are small, and a type-only cycle back into the writer
 * would make this module unusable by anything else.
 */
export type BuildFilterStatsInput = {
  /** The whole `keryx review scope --json` document, when one was supplied. */
  scope?: { drops: readonly ReviewScopeDropLike[] } | undefined;
  /** The counts half, for a caller that holds nothing else. */
  scopeCounts?: ReviewScopeCountsLike | undefined;
  /**
   * True when a `## Pre-filter scope` block already in the package is being
   * carried forward. The block is prose; this producer cannot count it, and
   * re-parsing it is precisely what AC1 forbids.
   */
  preFilterCarried?: boolean | undefined;
  verification: VerificationCounts;
  /** The scope-B screen, or `undefined` when no blast-radius record reached it. */
  scopeB?: { rejected: readonly { rule: string }[] } | undefined;
  findingsCap: { counts: FindingsCapCounts; drops: readonly FindingsCapDrop[] };
  /** External findings, which bypass the scope-B screen and the reading cap. */
  externalRetained: number;
  /** `--refuted` findings, or `undefined` when the caller supplied no channel. */
  roundDismissed?: number | undefined;
};

/**
 * The record, from the stage results and from nothing else.
 *
 * Every `null` written here is accompanied by its `not_measured` row in the same
 * pass, so the two cannot drift apart: there is no path that sets a count to
 * `null` without saying why.
 */
export function buildFilterStats(input: BuildFilterStatsInput): ReviewFilterStats {
  const byReason: Record<string, number> = {};
  const notMeasured: ReviewFilterNotMeasured[] = [];
  const unmeasured = (stage: ReviewFilterStage, reason: string): null => {
    notMeasured.push({ stage, reason });
    return null;
  };
  const count = (key: string, by = 1): void => {
    byReason[key] = (byReason[key] ?? 0) + by;
  };

  // --- The pre-filter, in diff units -------------------------------------
  let droppedPrefilter: number | null;
  if (input.scope !== undefined) {
    droppedPrefilter = input.scope.drops.length;
    for (const drop of input.scope.drops) {
      count(`prefilter:${drop.reason}`);
    }
  } else if (input.scopeCounts !== undefined) {
    // The counts-only channel: how much, never why. The number is real, so it is
    // recorded; `by_reason` gains nothing, which is the difference between this
    // and the whole document.
    droppedPrefilter = input.scopeCounts.filesDropped + input.scopeCounts.blocksDropped;
  } else if (input.preFilterCarried === true) {
    droppedPrefilter = unmeasured(
      "prefilter",
      "a `## Pre-filter scope` block written by `keryx review scope --append` is carried forward in scope.md, but its counts did not reach this ingest. The block is prose and this record is not assembled from prose; pass the `keryx review scope --json` document to `--scope` and the numbers land here.",
    );
  } else {
    droppedPrefilter = unmeasured(
      "prefilter",
      "no `--scope` was supplied to this ingest. Nothing ran, so nothing is known — this is NOT `dropped 0`.",
    );
  }

  // --- The stage the roadmap names and this pipeline does not have --------
  const droppedLowConfidence = unmeasured(
    "low_confidence",
    "this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.",
  );

  // --- What the round dismissed itself ------------------------------------
  const dismissedByRound =
    input.roundDismissed === undefined
      ? unmeasured(
          "round_dismissed",
          "the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.",
        )
      : input.roundDismissed;
  if (input.roundDismissed !== undefined && input.roundDismissed > 0) {
    count("round_dismissed:raised-and-dismissed-by-the-round", input.roundDismissed);
  }

  // --- The verifier --------------------------------------------------------
  const verification = input.verification;
  const droppedRefuted =
    verification.mode === "off"
      ? unmeasured(
          "refuted",
          "`verification_mode: off` — no verdict was read, so no finding could be removed by one. `annotate` records verdicts and removes nothing, which is a measured zero; this is not.",
        )
      : verification.findingsRefuted;
  if (droppedRefuted !== null && droppedRefuted > 0) {
    count("refuted:verifier-refuted", droppedRefuted);
  }

  // --- The scope-B screen ---------------------------------------------------
  let droppedScopeB: number | null;
  if (input.scopeB === undefined) {
    droppedScopeB = unmeasured(
      "scope_b",
      "no blast-radius record reached this ingest, so the scope-B screen did not run. `rejected: 0` after a screen that ran is a different fact, and the record keeps them apart.",
    );
  } else {
    droppedScopeB = input.scopeB.rejected.length;
    for (const rejection of input.scopeB.rejected) {
      count(`scope_b:${rejection.rule}`);
    }
  }

  // --- The per-reviewer reading cap ----------------------------------------
  // Always measured: `applyFindingsCap` runs on every ingest, with a default
  // that lives in code precisely so a caller that says nothing still gets a
  // bound. There is no "the cap did not run" state to report.
  const droppedFindingsCap = input.findingsCap.counts.truncated;
  for (const drop of input.findingsCap.drops) {
    if (drop.truncated > 0) {
      count(`findings_cap:${drop.reviewer}`, drop.truncated);
    }
  }

  const total = verification.findingsIn;
  const retained = input.findingsCap.counts.retained + input.externalRetained;

  notMeasured.sort((left, right) => left.stage.localeCompare(right.stage));

  return {
    schema_version: 1,
    total,
    dropped_prefilter: droppedPrefilter,
    dropped_low_confidence: droppedLowConfidence,
    dropped_refuted: droppedRefuted,
    dropped_scope_b: droppedScopeB,
    dropped_findings_cap: droppedFindingsCap,
    retained,
    dismissed_by_round: dismissedByRound,
    by_reason: byReason,
    not_measured: notMeasured,
  };
}

// ---------------------------------------------------------------------------
// The consumer (AC3)
// ---------------------------------------------------------------------------

/**
 * What a reader can hold in its hand, from a manifest written by any version.
 *
 * `unknown` in, problems out. The record is read off disk by a different process
 * from the one that wrote it, so nothing here may assume its shape.
 */
export type FilterStatsProblem = {
  code: "not-recorded" | "shape" | "contradiction" | "arithmetic";
  message: string;
};

/**
 * Read a `filter_stats` back and say whether it holds together.
 *
 * This is the half AC3 exists for. `attempts.count` and `metrics.steps[].retries`
 * were declared and never written for a whole release because nothing read them;
 * a field with no reader has no way to be found wrong. So this runs on every
 * `keryx review status`, and a record that fails it exits non-zero.
 *
 * Three classes of problem, and the third is the one that catches a broken
 * producer:
 *
 * 1. **shape** — a count that is neither a number nor `null`, or a negative one.
 * 2. **contradiction** — a `null` count with no `not_measured` row, or a
 *    measured count that claims to be unmeasured. This is the AC2 invariant made
 *    enforceable: a producer that starts writing `0` where it used to write
 *    `null` fails here rather than reading as a clean round.
 * 3. **arithmetic** — `total` minus the measured finding-stage drops must equal
 *    `retained`.
 *
 * An unmeasured finding stage contributes nothing to the sum, and that is sound
 * rather than the "absent means zero" reading this whole module rejects: when
 * the scope-B screen does not run `screenScopeBFindings` returns every finding it
 * was given, and when `verification_mode` is `off` `mergeVerifications` removes
 * nothing. The stage did not merely fail to count — it structurally cannot have
 * removed anything. The RECORD still says `null`, because what the code can
 * prove and what the round observed are different claims.
 */
export function checkFilterStats(value: unknown): FilterStatsProblem[] {
  if (value === undefined || value === null) {
    return [
      {
        code: "not-recorded",
        message:
          "filter_stats: not recorded. Packages written before `review ingest` produced it carry none; re-ingest the round to record what it filtered.",
      },
    ];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [{ code: "shape", message: "filter_stats is not an object." }];
  }
  const stats = value as Record<string, unknown>;
  const problems: FilterStatsProblem[] = [];

  const rows = Array.isArray(stats["not_measured"]) ? (stats["not_measured"] as unknown[]) : [];
  if (!Array.isArray(stats["not_measured"])) {
    problems.push({ code: "shape", message: "filter_stats.not_measured is missing or not an array." });
  }
  const declaredUnmeasured = new Set<string>();
  for (const row of rows) {
    const record = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
    const stage = typeof record?.["stage"] === "string" ? (record["stage"] as string) : null;
    const reason = typeof record?.["reason"] === "string" ? (record["reason"] as string).trim() : "";
    if (stage === null) {
      problems.push({ code: "shape", message: "filter_stats.not_measured holds a row with no `stage`." });
      continue;
    }
    if (reason === "") {
      problems.push({
        code: "shape",
        message: `filter_stats.not_measured names \`${stage}\` with no reason. "A number is missing" and "the screen did not run" are different facts and only the second is useful.`,
      });
    }
    declaredUnmeasured.add(stage);
  }

  const counts: Array<{ stage: ReviewFilterStage; field: string }> = [
    { stage: "prefilter", field: "dropped_prefilter" },
    { stage: "low_confidence", field: "dropped_low_confidence" },
    { stage: "round_dismissed", field: "dismissed_by_round" },
    { stage: "refuted", field: "dropped_refuted" },
    { stage: "scope_b", field: "dropped_scope_b" },
    { stage: "findings_cap", field: "dropped_findings_cap" },
  ];

  const measured = new Map<ReviewFilterStage, number>();
  for (const { stage, field } of counts) {
    const raw = stats[field];
    if (raw === null) {
      if (!declaredUnmeasured.has(stage)) {
        problems.push({
          code: "contradiction",
          message: `filter_stats.${field} is null but no not_measured row names \`${stage}\`. A count that is absent without a stated reason is indistinguishable from one nobody wrote.`,
        });
      }
      continue;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      problems.push({ code: "shape", message: `filter_stats.${field} is not a non-negative integer: ${JSON.stringify(raw)}.` });
      continue;
    }
    if (declaredUnmeasured.has(stage)) {
      problems.push({
        code: "contradiction",
        message: `filter_stats.${field} records ${raw} while not_measured says \`${stage}\` was not measured. Reporting a number for a stage that did not run is the failure this record exists to make impossible.`,
      });
      continue;
    }
    measured.set(stage, raw);
  }

  const total = stats["total"];
  const retained = stats["retained"];
  if (typeof total !== "number" || typeof retained !== "number") {
    // Only a defect when neither is declared unmeasured; a round can legitimately
    // record neither, and then there is no arithmetic to do.
    if (total !== null || retained !== null) {
      problems.push({
        code: "shape",
        message: `filter_stats.total and filter_stats.retained must each be a number or null; got ${JSON.stringify(total)} and ${JSON.stringify(retained)}.`,
      });
    }
    return problems;
  }

  const dropped = FINDING_FILTER_STAGES.reduce((sum, stage) => sum + (measured.get(stage) ?? 0), 0);
  if (total - dropped !== retained) {
    problems.push({
      code: "arithmetic",
      message: `filter_stats does not add up: total ${total} minus the measured finding-stage drops (${dropped}) is ${
        total - dropped
      }, but retained is ${retained}. Either a stage removed findings without counting them, or a count is wrong.`,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STAGE_FIELDS: ReadonlyArray<{ label: string; field: keyof ReviewFilterStats; stage: ReviewFilterStage }> = [
  { label: "dropped_prefilter", field: "dropped_prefilter", stage: "prefilter" },
  { label: "dropped_low_confidence", field: "dropped_low_confidence", stage: "low_confidence" },
  { label: "dropped_refuted", field: "dropped_refuted", stage: "refuted" },
  { label: "dropped_scope_b", field: "dropped_scope_b", stage: "scope_b" },
  { label: "dropped_findings_cap", field: "dropped_findings_cap", stage: "findings_cap" },
  { label: "dismissed_by_round", field: "dismissed_by_round", stage: "round_dismissed" },
];

/**
 * The same numbers, for a person, beside the ones already in `scope.md`.
 *
 * The JSON in `manifest.json` is the record; this is the copy a reader opens.
 * Neither is derived from the other — both come from the same
 * {@link ReviewFilterStats} — so the markdown cannot say something the record
 * does not.
 */
export function renderFilterStatsMarkdown(stats: ReviewFilterStats): string {
  const reasons = new Map(stats.not_measured.map((row) => [row.stage, row.reason]));
  const lines: string[] = [];
  lines.push("## filter_stats");
  lines.push("");
  lines.push("The machine-readable copy is `filter_stats` in `manifest.json`; this block is");
  lines.push("rendered from the same record, never re-parsed out of the prose above.");
  lines.push("`null` means the stage did not run. It never means `0`.");
  lines.push("");
  lines.push(`total: ${stats.total ?? "null"}`);
  for (const { label, field, stage } of STAGE_FIELDS) {
    const value = stats[field] as number | null;
    lines.push(value === null ? `${label}: null — ${reasons.get(stage) ?? "no reason recorded"}` : `${label}: ${value}`);
  }
  lines.push(`retained: ${stats.retained ?? "null"}`);
  lines.push("");
  lines.push("### by_reason");
  lines.push("");
  const keys = Object.keys(stats.by_reason).sort();
  if (keys.length === 0) {
    lines.push("_no drop was attributed to a reason; every stage that ran removed nothing_");
  } else {
    for (const key of keys) {
      lines.push(`${key}: ${stats.by_reason[key] ?? 0}`);
    }
  }
  lines.push("");
  lines.push("`dropped_prefilter` counts diff material — whole files and change blocks removed");
  lines.push("before any reviewer read them. Every other count is findings, and only those are");
  lines.push("summed against `retained`.");
  lines.push("");
  return lines.join("\n");
}

/** The one-line form `review ingest` and `review status` print. */
export function renderFilterStatsLine(stats: ReviewFilterStats): string {
  const show = (value: number | null): string => (value === null ? "not-measured" : String(value));
  return `filter_stats: total=${show(stats.total)} prefilter=${show(stats.dropped_prefilter)} low_confidence=${show(
    stats.dropped_low_confidence,
  )} refuted=${show(stats.dropped_refuted)} scope_b=${show(stats.dropped_scope_b)} findings_cap=${show(
    stats.dropped_findings_cap,
  )} dismissed_by_round=${show(stats.dismissed_by_round)} retained=${show(stats.retained)}`;
}
