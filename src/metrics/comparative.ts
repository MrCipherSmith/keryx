// Comparative-ladder report builder (docs/requirements/keryx-benchmark-suite/plan.md,
// "M2 — Comparative: one third-party agent harness"; specification.md §1.3, AC-6).
//
// AC-6: "A comparative cell holds the model constant across targets and records each
// target's adapter and fairness-review status; an unreviewed adapter's numbers are
// marked non-publishable." This module is a pure synthesis layer over already-validated
// `paired-3-5-v2` manifests (keryx's own harness legs + a third-party harness leg) — it
// never runs an agent or a provider itself (that's each leg's own producer script, e.g.
// scripts/benchmark/run-ablation.ts, run-ablation-raw.ts, run-ablation-codex.ts). It
// deliberately does NOT merge those manifests into one `PairedBenchmarkManifestV2`:
// validatePairedBenchmarkV2's paired-cell invariant is built around exactly two
// complementary variants per task, and a comparative row needs up to four cells
// (keryx-on, keryx-off, raw, <harness>) — trying to force that into the paired schema
// would either break the invariant or require gutting it. Each leg stays its own
// independently-valid manifest; this module only reads their `runs` and re-presents them
// side by side, exactly like every prior ablation leg in this project ("reported
// separately, never averaged").

import { deriveRate, wilsonInterval, type PairedBenchmarkManifestV2, type PairedBenchmarkRunV2, type RateWithCI } from "./benchmark";

/** Review status of a target's adapter (AC-6): was it built and reviewed against its own idiomatic interface? */
export type AdapterReviewStatus = "native-reviewed" | "pending";

/**
 * Fairness-protocol status for a target (plan.md M2 scope: "same task, same model, same
 * environment; parity review recorded"). `met` means the protocol held exactly; `caveat`
 * means a disclosed, bounded deviation was accepted; `not-met` means a real deviation
 * exists and was not waived (e.g. the model was not held constant).
 */
export type FairnessStatus = "met" | "caveat" | "not-met";

export type ComparativeTargetStatus = {
  /** Short target name, e.g. "keryx" or "codex" — matches ComparativeCellResult.target. */
  readonly target: string;
  readonly adapter: AdapterReviewStatus;
  readonly fairness: FairnessStatus;
  /** Required when fairness is not "met" — the concrete, disclosed reason. */
  readonly fairnessNote?: string;
  /** The model this target actually ran, so a reader can see the constant (or the deviation) directly. */
  readonly model: string;
};

const ADAPTER_STATUSES = new Set<AdapterReviewStatus>(["native-reviewed", "pending"]);
const FAIRNESS_STATUSES = new Set<FairnessStatus>(["met", "caveat", "not-met"]);

/** One comparative cell: a single target's result on a single task. */
export type ComparativeCellResult = {
  readonly taskId: string;
  /** Which of the four cell kinds this is — `harness` is always the reviewed third-party target. */
  readonly cell: "keryx-on" | "keryx-off" | "raw" | "harness";
  /** The target this cell's numbers belong to — looked up in `ComparativeReport.targets`. */
  readonly target: string;
  readonly model: string;
  readonly successRate: RateWithCI;
  readonly medianToolCalls: number | null;
  readonly medianTokens: number | null;
  /**
   * Per AC-6: false whenever the owning target's fairness status is not "met" (or its
   * adapter is not "native-reviewed") — computed by `buildComparativeReport`, never set
   * by hand, so a caller cannot silently mark a caveated result publishable.
   */
  readonly publishable: boolean;
};

export type ComparativeReport = {
  readonly ladder: "comparative";
  /** The model keryx-on/keryx-off/raw all share — the constant the protocol is measured against. */
  readonly referenceModel: string;
  readonly targets: readonly ComparativeTargetStatus[];
  readonly cells: readonly ComparativeCellResult[];
};

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

/** Recover a run's success count/n from its `rates.taskSuccess` (as ablation-runner.ts writes it). */
function successRateFromRun(run: PairedBenchmarkRunV2): RateWithCI {
  const rate = run.rates?.taskSuccess;
  if (rate) return rate;
  // Deterministic single-run fallback: derive directly from correctness, one trial.
  const success = run.correctness?.value === 1 ? 1 : 0;
  return deriveRate(success, 1, run.correctness?.reliability ?? "unknown");
}

function medianToolCallsFromRun(run: PairedBenchmarkRunV2): number | null {
  return run.distribution?.median ?? null;
}

function medianTokensFromRun(run: PairedBenchmarkRunV2): number | null {
  return run.cost?.tokens?.raw.value ?? null;
}

function findRun(manifest: PairedBenchmarkManifestV2, taskId: string, variant: PairedBenchmarkRunV2["variant"]): PairedBenchmarkRunV2 | undefined {
  return manifest.runs.find((run) => run.task_id === taskId && run.variant === variant);
}

export type ComparativeLegs = {
  /** keryx's own harness leg — must contain both context-on and context-off runs per task. */
  readonly keryx: PairedBenchmarkManifestV2;
  /** The zero-tool raw-model floor leg — must contain a "baseline" run per task. */
  readonly raw: PairedBenchmarkManifestV2;
  /** The third-party harness leg (e.g. codex) — the cell used is its context-on run. */
  readonly harness: PairedBenchmarkManifestV2;
  readonly harnessTargetName: string;
  readonly harnessStatus: Omit<ComparativeTargetStatus, "target" | "model">;
};

/**
 * Build a `ComparativeReport` from three independently-validated legs. `taskIds` is the
 * shared task-id set to report on (the intersection is used if a leg is missing one —
 * silently dropped tasks are never reported, only tasks present in ALL THREE legs).
 */
export function buildComparativeReport(legs: ComparativeLegs): ComparativeReport {
  const keryxRun = legs.keryx.runs.find((run) => run.variant === "context-on");
  const referenceModel = keryxRun?.model ?? "unknown";

  const keryxTaskIds = new Set(legs.keryx.runs.map((run) => run.task_id));
  const rawTaskIds = new Set(legs.raw.runs.map((run) => run.task_id));
  const harnessTaskIds = new Set(legs.harness.runs.map((run) => run.task_id));
  const taskIds = [...keryxTaskIds].filter((id) => rawTaskIds.has(id) && harnessTaskIds.has(id)).sort();

  const targets: ComparativeTargetStatus[] = [
    { target: "keryx", adapter: "native-reviewed", fairness: "met", model: referenceModel },
    { target: legs.harnessTargetName, model: legs.harness.runs[0]?.model ?? "unknown", ...legs.harnessStatus },
  ];
  const targetByName = new Map(targets.map((status) => [status.target, status] as const));

  const publishableFor = (targetName: string): boolean => {
    const status = targetByName.get(targetName);
    if (!status) return false;
    return status.adapter === "native-reviewed" && status.fairness === "met";
  };

  const cell = (
    taskId: string,
    cellKind: ComparativeCellResult["cell"],
    target: string,
    run: PairedBenchmarkRunV2 | undefined,
  ): ComparativeCellResult | undefined => {
    if (!run) return undefined;
    return {
      taskId,
      cell: cellKind,
      target,
      model: run.model,
      successRate: successRateFromRun(run),
      medianToolCalls: medianToolCallsFromRun(run),
      medianTokens: medianTokensFromRun(run),
      publishable: publishableFor(target),
    };
  };

  const cells: ComparativeCellResult[] = [];
  for (const taskId of taskIds) {
    const keryxOn = cell(taskId, "keryx-on", "keryx", findRun(legs.keryx, taskId, "context-on"));
    const keryxOff = cell(taskId, "keryx-off", "keryx", findRun(legs.keryx, taskId, "context-off"));
    const raw = cell(taskId, "raw", "keryx", findRun(legs.raw, taskId, "baseline"));
    const harness = cell(taskId, "harness", legs.harnessTargetName, findRun(legs.harness, taskId, "context-on"));
    for (const c of [keryxOn, keryxOff, raw, harness]) if (c) cells.push(c);
  }

  return { ladder: "comparative", referenceModel, targets, cells };
}

export type ComparativeReportValidation = { valid: boolean; errors: string[] };

/** Validate AC-6's hard invariant: a cell whose target is not (native-reviewed AND fairness:met) must be non-publishable. */
export function validateComparativeReport(report: ComparativeReport): ComparativeReportValidation {
  const errors: string[] = [];
  const targetByName = new Map(report.targets.map((status) => [status.target, status] as const));

  for (const [index, status] of report.targets.entries()) {
    if (!ADAPTER_STATUSES.has(status.adapter)) errors.push(`targets[${index}].adapter: invalid`);
    if (!FAIRNESS_STATUSES.has(status.fairness)) errors.push(`targets[${index}].fairness: invalid`);
    if (status.fairness !== "met" && !status.fairnessNote) {
      errors.push(`targets[${index}] (${status.target}): fairness "${status.fairness}" requires a fairnessNote`);
    }
  }

  for (const [index, cellResult] of report.cells.entries()) {
    const status = targetByName.get(cellResult.target);
    if (!status) {
      errors.push(`cells[${index}] (${cellResult.taskId}/${cellResult.cell}): target "${cellResult.target}" has no status entry`);
      continue;
    }
    const shouldBePublishable = status.adapter === "native-reviewed" && status.fairness === "met";
    if (cellResult.publishable !== shouldBePublishable) {
      errors.push(
        `cells[${index}] (${cellResult.taskId}/${cellResult.cell}): publishable=${cellResult.publishable} ` +
          `inconsistent with target "${cellResult.target}" status (adapter=${status.adapter}, fairness=${status.fairness}) — AC-6`,
      );
    }
    const rate = cellResult.successRate;
    if (!rate || rate.n <= 0) {
      errors.push(`cells[${index}]: successRate reported without an explicit n`);
    } else {
      const expected = wilsonInterval(rate.successes, rate.n);
      if (Math.abs(rate.ci95.lower - expected.lower) > 1e-6 || Math.abs(rate.ci95.upper - expected.upper) > 1e-6) {
        errors.push(`cells[${index}]: successRate confidence interval does not match the 95% Wilson interval`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
