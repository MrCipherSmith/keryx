// Shared, pure instrumentation + aggregation for the comparative mutating-ablation benchmark
// (flow 387 T13a, AC10/AC11). No I/O, no network: the four runners
// (run-ablation-mutating*.ts) feed raw harness output through the parsers below, and
// build-comparative-report.ts feeds the resulting per-task samples through the aggregation
// and verdict functions. Every number is either measured or `null` — a harness that does
// not expose a figure records `null`, never a guess.
//
// Token semantics (all fields are per TASK RUN, summed over every model request of the run):
//   uncachedInputTokens  input tokens NOT served from the prompt cache (billed at full rate).
//   cachedInputTokens    input tokens served from the prompt cache (cache read).
//   cacheWriteTokens     input tokens written to the cache (a subset of the input; billed at
//                        a premium by some providers). null when the harness does not say.
//   outputTokens         generated tokens (reasoning tokens included where the harness folds
//                        them into output; recorded as the harness reports them).
//   requests             number of model requests the harness made for the task.

import type { AblationSeedSample, AblationTaskInput, AblationVariant } from "../../src/metrics/ablation-runner";
import type { NormalizedUsage } from "../../src/harness/provider/types";

export type TaskTokenMetrics = {
  readonly uncachedInputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly requests: number | null;
};

export const EMPTY_TOKEN_METRICS: TaskTokenMetrics = {
  uncachedInputTokens: null,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
  requests: null,
};

/** Repeated-read counts for one keryx task run (AC11). `null` on harnesses that expose no tool-call arguments. */
export type RepeatedReadMetrics = {
  /** read_file/search_code calls whose name + arguments exactly repeat an earlier call in the task. */
  readonly repeated: number;
  /** Repeats with a context compaction between the earlier identical call and this one. */
  readonly repeatedAfterCompaction: number;
  /** Repeats with a context prune between the earlier identical call and this one. */
  readonly repeatedAfterPrune: number;
  /** Repeats with a compaction OR a prune between the earlier identical call and this one (the AC11 count). */
  readonly repeatedAfterCompactionOrPrune: number;
  /** Name of the prune hook registered on the agent deps, or null when none was (prune counts are then structurally 0). */
  readonly pruneHook: string | null;
};

/** A seed sample extended with the AC10/AC11 instrumentation. Structurally an {@link AblationSeedSample}. */
export type InstrumentedSeedSample = AblationSeedSample & {
  readonly model: string;
  readonly metrics: TaskTokenMetrics;
  readonly repeatedReads: RepeatedReadMetrics | null;
};

/* ------------------------------------------------------------------ keryx */

/** Sums {@link NormalizedUsage} across every model request of one keryx task run. */
export class KeryxUsageAccumulator {
  private requests = 0;
  private input = 0;
  private inputReported = 0;
  private cacheRead = 0;
  private cacheReadReported = 0;
  private cacheWrite = 0;
  private cacheWriteReported = 0;
  private output = 0;
  private outputReported = 0;

  addUsage(usage: NormalizedUsage): void {
    this.requests += 1;
    if (typeof usage.inputTokens === "number") {
      this.input += usage.inputTokens;
      this.inputReported += 1;
    }
    if (typeof usage.cacheReadTokens === "number") {
      this.cacheRead += usage.cacheReadTokens;
      this.cacheReadReported += 1;
    }
    if (typeof usage.cacheWriteTokens === "number") {
      this.cacheWrite += usage.cacheWriteTokens;
      this.cacheWriteReported += 1;
    }
    if (typeof usage.outputTokens === "number") {
      this.output += usage.outputTokens;
      this.outputReported += 1;
    }
  }

  /**
   * A figure is reported only when EVERY request reported it — a partial sum would silently
   * understate it. Uncached input additionally needs the cache-read figure (cacheReadTokens
   * is a SUBSET of inputTokens, see NormalizedUsage), so a provider that reports input but
   * not cache reads yields `null` uncached, not "all input is uncached".
   */
  metrics(): TaskTokenMetrics {
    if (this.requests === 0) return EMPTY_TOKEN_METRICS;
    const all = (n: number): boolean => n === this.requests;
    const inputKnown = all(this.inputReported);
    const cacheReadKnown = all(this.cacheReadReported);
    return {
      uncachedInputTokens: inputKnown && cacheReadKnown ? Math.max(0, this.input - this.cacheRead) : null,
      cachedInputTokens: cacheReadKnown ? this.cacheRead : null,
      cacheWriteTokens: all(this.cacheWriteReported) ? this.cacheWrite : null,
      outputTokens: all(this.outputReported) ? this.output : null,
      requests: this.requests,
    };
  }
}

const REPEATABLE_TOOLS: ReadonlySet<string> = new Set(["read_file", "search_code"]);

/** Order-independent canonical form of a tool-call argument string, so `{"a":1,"b":2}` equals `{"b":2,"a":1}`. */
export function canonicalArgs(input: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(input) as unknown));
  } catch {
    return input.trim();
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Counts exact-repeat read_file/search_code calls within ONE task run, and those separated from their original by a compaction/prune. */
export class RepeatedReadTracker {
  private compactions = 0;
  private prunes = 0;
  private readonly lastSeen = new Map<string, { compactions: number; prunes: number }>();
  private repeated = 0;
  private afterCompaction = 0;
  private afterPrune = 0;
  private afterEither = 0;

  constructor(private readonly pruneHook: string | null = null) {}

  onToolCall(name: string, input: string): void {
    if (!REPEATABLE_TOOLS.has(name)) return;
    const key = `${name}\u0000${canonicalArgs(input)}`;
    const prior = this.lastSeen.get(key);
    if (prior !== undefined) {
      this.repeated += 1;
      const compacted = this.compactions > prior.compactions;
      const pruned = this.prunes > prior.prunes;
      if (compacted) this.afterCompaction += 1;
      if (pruned) this.afterPrune += 1;
      if (compacted || pruned) this.afterEither += 1;
    }
    this.lastSeen.set(key, { compactions: this.compactions, prunes: this.prunes });
  }

  onCompaction(): void {
    this.compactions += 1;
  }

  onPrune(): void {
    this.prunes += 1;
  }

  result(): RepeatedReadMetrics {
    return {
      repeated: this.repeated,
      repeatedAfterCompaction: this.afterCompaction,
      repeatedAfterPrune: this.afterPrune,
      repeatedAfterCompactionOrPrune: this.afterEither,
      pruneHook: this.pruneHook,
    };
  }
}

/* ------------------------------------------------------------- other CLIs */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * codex `exec --json`: `turn.completed.usage` is {input_tokens, cached_input_tokens,
 * cache_write_input_tokens?, output_tokens, reasoning_output_tokens} (codex-rs/exec/src/exec_events.rs).
 * input_tokens INCLUDES the cached portion (TokenUsage::non_cached_input = input - cached).
 * One `turn.completed` is emitted per turn; a headless exec is one turn but all are summed.
 * codex exposes no per-request count in this stream, so `requests` is null.
 */
export function codexMetrics(events: readonly { type: string; [key: string]: unknown }[]): TaskTokenMetrics {
  let input = 0;
  let cached = 0;
  let write = 0;
  let output = 0;
  let sawTurn = false;
  let writeReported = true;
  for (const event of events) {
    if (event.type !== "turn.completed") continue;
    const usage = event.usage as Record<string, unknown> | undefined;
    const inTok = num(usage?.input_tokens);
    const outTok = num(usage?.output_tokens);
    const cachedTok = num(usage?.cached_input_tokens);
    if (usage === undefined || inTok === null || outTok === null || cachedTok === null) return EMPTY_TOKEN_METRICS;
    sawTurn = true;
    input += inTok;
    cached += cachedTok;
    output += outTok;
    const w = num(usage.cache_write_input_tokens);
    if (w === null) writeReported = false;
    else write += w;
  }
  if (!sawTurn) return EMPTY_TOKEN_METRICS;
  return {
    uncachedInputTokens: Math.max(0, input - cached),
    cachedInputTokens: cached,
    cacheWriteTokens: writeReported ? write : null,
    outputTokens: output,
    requests: null,
  };
}

/**
 * opencode `run --format json`: each `step_finish` event carries `part.tokens` =
 * {input, output, reasoning, cache:{read, write}, total}. opencode's `input` is ALREADY the
 * uncached portion (session.ts: adjustedInputTokens = input - cacheRead - cacheWrite), and
 * cache.read / cache.write are reported separately. One `step_finish` per model request.
 */
export function opencodeMetrics(events: readonly { type: string; part?: Record<string, unknown> }[]): TaskTokenMetrics {
  let requests = 0;
  let uncached = 0;
  let cached = 0;
  let write = 0;
  let output = 0;
  let cacheKnown = true;
  for (const event of events) {
    if (event.type !== "step_finish") continue;
    const tokens = event.part?.tokens as { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } } | undefined;
    const inTok = num(tokens?.input);
    const outTok = num(tokens?.output);
    if (tokens === undefined || inTok === null || outTok === null) return EMPTY_TOKEN_METRICS;
    requests += 1;
    uncached += inTok;
    output += outTok;
    const r = num(tokens.cache?.read);
    const w = num(tokens.cache?.write);
    if (r === null || w === null) cacheKnown = false;
    else {
      cached += r;
      write += w;
    }
  }
  if (requests === 0) return EMPTY_TOKEN_METRICS;
  return {
    uncachedInputTokens: uncached,
    cachedInputTokens: cacheKnown ? cached : null,
    cacheWriteTokens: cacheKnown ? write : null,
    outputTokens: output,
    requests,
  };
}

/**
 * grok `--output-format json`: one final object {usage, num_turns, modelUsage}. The shape of
 * `usage` beyond `total_tokens` is not documented in this repo, so the cached figure is read
 * from the few spellings OpenAI-/Anthropic-style APIs use and is `null` when none is present.
 * Input is treated as INCLUDING cached tokens (OpenAI-style) only when a cached count exists;
 * without one, uncached input is `null` rather than assumed.
 */
export function grokMetrics(result: { usage?: Record<string, unknown>; num_turns?: unknown }): TaskTokenMetrics {
  const usage = result.usage;
  const requests = num(result.num_turns);
  if (usage === undefined) return { ...EMPTY_TOKEN_METRICS, requests };
  const input = num(usage.input_tokens) ?? num(usage.prompt_tokens);
  const output = num(usage.output_tokens) ?? num(usage.completion_tokens);
  const details = (usage.input_tokens_details ?? usage.prompt_tokens_details) as { cached_tokens?: unknown } | undefined;
  const cached = num(usage.cached_input_tokens) ?? num(usage.cache_read_input_tokens) ?? num(usage.cached_tokens) ?? num(details?.cached_tokens);
  return {
    uncachedInputTokens: input !== null && cached !== null ? Math.max(0, input - cached) : null,
    cachedInputTokens: cached,
    cacheWriteTokens: num(usage.cache_write_input_tokens) ?? num(usage.cache_creation_input_tokens),
    outputTokens: output,
    requests,
  };
}

/* -------------------------------------------------------------- filenames */

/**
 * Fixture filename keyed on the model (real incident: a `--provider`-only suffix let a second
 * model on the same provider clobber a committed fixture). The legacy name is kept ONLY for
 * the leg's default model; any other model gets its own slugged suffix.
 */
export function fixtureFilename(legacyName: string, defaultModel: string, model: string): string {
  if (model === defaultModel) return legacyName;
  const slug = model.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  return legacyName.replace(/\.json$/, `-${slug}.json`);
}

/* ------------------------------------------------------------ aggregation */

/** A leg's raw per-seed fixture as written by the mutating runners. */
export type LegFixture = {
  readonly provider: string;
  readonly model: string;
  readonly tasks: readonly AblationTaskInput[];
};

export type LegLabel = { readonly harness: string; readonly model: string };

export type LegAggregate = LegLabel & {
  readonly variant: AblationVariant;
  readonly taskIds: readonly string[];
  readonly runs: number;
  /** Runs carrying instrumentation (legacy fixtures captured before T13a have none). */
  readonly instrumentedRuns: number;
  readonly successRate: number | null;
  readonly meanUncachedInput: number | null;
  readonly meanCachedInput: number | null;
  readonly meanOutput: number | null;
  readonly meanRequests: number | null;
  /** Totals over the whole task set (AC11), null unless every run was instrumented with repeated-read data. */
  readonly repeatedReadTotals: { readonly repeated: number; readonly afterCompactionOrPrune: number } | null;
  /** Why a mean is null, when it is. */
  readonly gaps: readonly string[];
};

function asInstrumented(sample: AblationSeedSample): InstrumentedSeedSample | null {
  const candidate = sample as Partial<InstrumentedSeedSample>;
  return candidate.metrics !== undefined ? (sample as InstrumentedSeedSample) : null;
}

function meanOrNull(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return (values as number[]).reduce((a, b) => a + b, 0) / values.length;
}

/** Harness name for a fixture's provider field: keryx's own providers are everything not a `*-cli`. */
export function harnessOf(provider: string): string {
  return provider.endsWith("-cli") ? provider.replace(/-cli$/, "") : "keryx";
}

/**
 * Aggregate one leg for one ablation variant. A mean is `null` (never a partial mean) as soon as
 * one run lacks that figure, and the reason is recorded in `gaps`.
 */
export function aggregateLeg(fixture: LegFixture, variant: AblationVariant = "context-on"): LegAggregate {
  const samples: AblationSeedSample[] = [];
  for (const task of fixture.tasks) {
    const cell = variant === "context-on" ? task.contextOn : task.contextOff;
    samples.push(...cell.samples);
  }
  const instrumented = samples.map(asInstrumented);
  const present = instrumented.filter((s): s is InstrumentedSeedSample => s !== null);
  const gaps: string[] = [];
  if (present.length < samples.length) {
    gaps.push(`${samples.length - present.length}/${samples.length} runs carry no token instrumentation (captured before T13a)`);
  }
  const pick = (f: (m: TaskTokenMetrics) => number | null, label: string): number | null => {
    if (present.length === 0 || present.length < samples.length) return null;
    const mean = meanOrNull(present.map((s) => f(s.metrics)));
    if (mean === null) gaps.push(`${label} not reported by the harness for every run`);
    return mean;
  };
  const meanUncachedInput = pick((m) => m.uncachedInputTokens, "uncached input");
  const meanCachedInput = pick((m) => m.cachedInputTokens, "cached input");
  const meanOutput = pick((m) => m.outputTokens, "output");
  const meanRequests = pick((m) => m.requests, "request count");

  let repeatedReadTotals: LegAggregate["repeatedReadTotals"] = null;
  if (present.length > 0 && present.length === samples.length && present.every((s) => s.repeatedReads !== null)) {
    repeatedReadTotals = {
      repeated: present.reduce((a, s) => a + (s.repeatedReads?.repeated ?? 0), 0),
      afterCompactionOrPrune: present.reduce((a, s) => a + (s.repeatedReads?.repeatedAfterCompactionOrPrune ?? 0), 0),
    };
  }

  return {
    harness: harnessOf(fixture.provider),
    model: fixture.model,
    variant,
    taskIds: fixture.tasks.map((t) => t.taskId).sort(),
    runs: samples.length,
    instrumentedRuns: present.length,
    successRate: samples.length === 0 ? null : samples.filter((s) => s.success).length / samples.length,
    meanUncachedInput,
    meanCachedInput,
    meanOutput,
    meanRequests,
    repeatedReadTotals,
    gaps,
  };
}

export type Verdict = { readonly status: "met" | "not met" | "not comparable"; readonly line: string };

export const AC10_TOLERANCE = 0.05;

const label = (l: LegLabel): string => `${l.harness}/${l.model}`;

/**
 * AC10: keryx has the lowest mean uncached input tokens per task, or is within 5% of the lowest.
 * Evaluated per keryx leg against every leg (keryx legs included). "not comparable" when there is
 * no keryx leg, fewer than two legs, any compared leg lacks the figure, or the task sets differ.
 * Differing models do not block the verdict (the spec allows a disclosed mismatch) but are named.
 */
export function ac10Verdict(legs: readonly LegAggregate[]): Verdict {
  const keryxLegs = legs.filter((l) => l.harness === "keryx");
  if (keryxLegs.length === 0) return { status: "not comparable", line: "AC10: not comparable — no keryx leg present" };
  if (legs.length < 2) return { status: "not comparable", line: "AC10: not comparable — only one leg present, nothing to compare against" };
  const missing = legs.filter((l) => l.meanUncachedInput === null);
  if (missing.length > 0) {
    const why = missing.map((l) => `${label(l)} (${l.gaps[0] ?? "uncached input not reported"})`).join("; ");
    return { status: "not comparable", line: `AC10: not comparable — uncached input tokens unavailable for: ${why}` };
  }
  const refTasks = legs[0]!.taskIds.join("|");
  const differing = legs.filter((l) => l.taskIds.join("|") !== refTasks);
  if (differing.length > 0) {
    return { status: "not comparable", line: `AC10: not comparable — task sets differ for: ${differing.map(label).join(", ")}` };
  }
  const lowest = legs.reduce((a, b) => ((a.meanUncachedInput as number) <= (b.meanUncachedInput as number) ? a : b));
  const lowestValue = lowest.meanUncachedInput as number;
  const models = new Set(legs.map((l) => l.model));
  const caveat = models.size > 1 ? ` (model mismatch disclosed: ${[...models].join(", ")})` : "";
  const parts: string[] = [];
  let allMet = true;
  for (const k of keryxLegs) {
    const value = k.meanUncachedInput as number;
    const within = value <= lowestValue * (1 + AC10_TOLERANCE);
    if (!within) allMet = false;
    const pct = lowestValue === 0 ? (value === 0 ? 0 : Infinity) : ((value - lowestValue) / lowestValue) * 100;
    parts.push(`${label(k)} ${value.toFixed(0)} vs lowest ${lowestValue.toFixed(0)} (${label(lowest)}), ${pct >= 0 ? "+" : ""}${Number.isFinite(pct) ? pct.toFixed(1) : "inf"}%`);
  }
  const status = allMet ? "met" : "not met";
  return {
    status,
    line: `AC10: ${status} — keryx lowest or within ${AC10_TOLERANCE * 100}% of lowest on mean uncached input tokens per task: ${parts.join("; ")}${caveat}`,
  };
}

/**
 * AC11: keryx success rate not lower than the baseline's, and the count of repeated identical
 * reads after a compaction/prune not higher, on the same task set. `current` and `baseline` are
 * keryx legs (the baseline being a run on `main` before the flow).
 */
export function ac11Verdict(current: LegAggregate | undefined, baseline: LegAggregate | undefined): Verdict {
  if (current === undefined) return { status: "not comparable", line: "AC11: not comparable — no keryx leg present" };
  if (baseline === undefined) return { status: "not comparable", line: "AC11: not comparable — no baseline result file (pass --baseline <file>)" };
  if (current.taskIds.join("|") !== baseline.taskIds.join("|")) {
    return { status: "not comparable", line: "AC11: not comparable — current and baseline task sets differ" };
  }
  if (current.successRate === null || baseline.successRate === null) {
    return { status: "not comparable", line: "AC11: not comparable — a run set is empty" };
  }
  const successOk = current.successRate >= baseline.successRate;
  const successText = `success ${(current.successRate * 100).toFixed(0)}% vs baseline ${(baseline.successRate * 100).toFixed(0)}%`;
  if (current.repeatedReadTotals === null || baseline.repeatedReadTotals === null) {
    const who = [current.repeatedReadTotals === null ? "current" : null, baseline.repeatedReadTotals === null ? "baseline" : null].filter(Boolean).join(" and ");
    return {
      status: "not comparable",
      line: `AC11: not comparable — repeated-read counts missing for ${who} (${successText}; success criterion ${successOk ? "holds" : "fails"})`,
    };
  }
  const repeatOk = current.repeatedReadTotals.afterCompactionOrPrune <= baseline.repeatedReadTotals.afterCompactionOrPrune;
  const status = successOk && repeatOk ? "met" : "not met";
  return {
    status,
    line:
      `AC11: ${status} — ${successText}; repeated identical reads after compaction/prune ` +
      `${current.repeatedReadTotals.afterCompactionOrPrune} vs baseline ${baseline.repeatedReadTotals.afterCompactionOrPrune} ` +
      `(all repeats ${current.repeatedReadTotals.repeated} vs ${baseline.repeatedReadTotals.repeated})`,
  };
}

/** Markdown table of the per-leg means — short numeric cells only. */
export function renderTokenTable(legs: readonly LegAggregate[]): string {
  const f = (v: number | null): string => (v === null ? "n/a" : v.toFixed(0));
  const rows = legs.map(
    (l) =>
      `| ${l.harness} | ${l.model} | ${l.variant} | ${f(l.meanUncachedInput)} | ${f(l.meanCachedInput)} | ${f(l.meanOutput)} | ${f(l.meanRequests)} | ` +
      `${l.successRate === null ? "n/a" : `${(l.successRate * 100).toFixed(0)}%`} (n=${l.runs}) |`,
  );
  return [
    "| harness | model | variant | mean uncached input | mean cached input | mean output | mean requests | success |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
