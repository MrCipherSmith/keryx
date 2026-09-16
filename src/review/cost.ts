// What a round costs, before and after.
//
// `keryx review budget` has printed a ceiling and `spent: not recorded` since it
// was written, and it says so honestly — "`not recorded` is not `under`". What
// it has never had is anything feeding it. Nothing estimated a round before it
// was dispatched and nothing recorded what it actually used, so the one number
// the fan-out has to justify itself with did not exist: the round on flow 260
// spent roughly 450k subagent tokens on a 707-line diff and found a blocker,
// and neither half of that sentence is written down anywhere a later reader
// could find it.
//
// Three points, deliberately small:
//
//   - `review scope` estimates from the scoped diff, BEFORE the dispatch, so the
//     price is known while it is still a decision.
//   - `review ingest` records what the caller reports it used.
//   - `review complete` prints the cost per retained finding.
//
// None of it guesses. An estimate is labelled an estimate; an unreported spend
// stays `not recorded` and never becomes `0`, on the same rule the rest of this
// package follows — a zero says somebody measured.

/** What a round reports having used. Every field independent and optional. */
export type ReviewRoundCost = {
  /** Prompt tokens across every dispatch the round made. */
  input_tokens?: number;
  /** Completion tokens across the same. */
  output_tokens?: number;
  /** What it cost in USD, when the caller knows the rates. */
  spent_usd?: number;
};

/**
 * Characters ÷ 4.
 *
 * The standard rough heuristic, and rough is the honest word: real tokenisation
 * is model-specific and this runs before a model is chosen. It exists to answer
 * "is this round a thousand tokens or a million" while that is still a question
 * somebody can act on, and it is labelled `≈` everywhere it is printed so no
 * reader mistakes it for a measurement.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** `12,345` — digits a person reads, not `12345`. */
function grouped(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * The line `review scope` prints under the scoped diff.
 *
 * `reviewers` multiplies because every reviewer receives the scoped diff: the
 * fan-out is the cost model, so a per-round estimate that ignored it would
 * understate the thing this exists to surface.
 */
export function renderScopeEstimate(scopedDiff: string, reviewers: number): string {
  const per = estimateTokens(scopedDiff);
  const lines = [
    `### Estimated cost`,
    "",
    `- ≈ ${grouped(per)} prompt tokens of scoped diff per reviewer (characters ÷ 4 — an estimate, not a measurement)`,
  ];
  if (reviewers > 0) {
    lines.push(
      `- ≈ ${grouped(per * reviewers)} across ${reviewers} reviewer${reviewers === 1 ? "" : "s"}, before their own prompts, tools and any verifier wave`,
    );
  } else {
    lines.push(
      "- reviewer count not supplied, so the fan-out is not multiplied in — pass `--reviewers a,b` to see the round's total",
    );
  }
  return lines.join("\n");
}

/** Nothing reported is recorded as nothing, never as zero. */
export function costFrom(input: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  spentUsd?: number | undefined;
}): ReviewRoundCost | undefined {
  const cost: ReviewRoundCost = {};
  if (typeof input.inputTokens === "number") {
    cost.input_tokens = input.inputTokens;
  }
  if (typeof input.outputTokens === "number") {
    cost.output_tokens = input.outputTokens;
  }
  if (typeof input.spentUsd === "number") {
    cost.spent_usd = input.spentUsd;
  }
  return Object.keys(cost).length === 0 ? undefined : cost;
}

/**
 * What the round cost per finding that survived it.
 *
 * Printed at `review complete`, which is the first moment both halves are
 * known. A round that retained nothing is reported as its whole cost against
 * zero findings rather than as a division — "38,000 tokens, 0 findings
 * retained" is the fact; a per-finding figure there would be an infinity
 * dressed as a metric.
 */
export function renderCostPerFinding(cost: ReviewRoundCost | undefined, retained: number): string[] {
  if (cost === undefined) {
    return [
      "cost: not recorded",
      "  Nothing reported what this round used. That is NOT zero: pass --tokens-in/--tokens-out",
      "  or --spent at ingest so the price of a round is a number somebody can weigh.",
    ];
  }
  const tokens =
    cost.input_tokens === undefined && cost.output_tokens === undefined
      ? undefined
      : (cost.input_tokens ?? 0) + (cost.output_tokens ?? 0);
  const lines: string[] = [];
  if (tokens !== undefined) {
    lines.push(`tokens: ${grouped(tokens)}`);
  }
  if (cost.spent_usd !== undefined) {
    lines.push(`spent: ${cost.spent_usd} USD`);
  }
  lines.push(`retained findings: ${retained}`);
  if (retained === 0) {
    lines.push("  Nothing was retained, so there is no per-finding figure — only the bill.");
    return lines;
  }
  if (tokens !== undefined) {
    lines.push(`per retained finding: ${grouped(Math.round(tokens / retained))} tokens`);
  }
  if (cost.spent_usd !== undefined) {
    lines.push(`per retained finding: ${(cost.spent_usd / retained).toFixed(4)} USD`);
  }
  return lines;
}
