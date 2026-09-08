import type { ValidationResult } from "./types";

export type BaselineStatus = "pass" | "fail" | "unknown";
export type BaselineClassification = "baseline-green" | "baseline-red" | "baseline-unknown";

export type BaselineComparison = {
  classification: BaselineClassification;
  prIntroducedFailure: boolean;
  /**
   * F-240-04 (flow 240 T7). The PR's own validation produced no verdict — the
   * command did not run. Distinct from `prIntroducedFailure`, which is a claim
   * about a verdict that exists.
   */
  prNotRun: boolean;
  /**
   * Whether this comparison should fail the job (`keryx standard baseline`
   * exits 1 iff this is true).
   *
   * F-240-04: the exit rule used to be "exit 0 unless baseline-green + pr-fail",
   * which handed TWO free passes to a check that never ran:
   *
   *   --baseline unknown --pr fail  -> baseline-unknown, exit 0
   *   --baseline <any>   --pr fail  -> exit 0 whenever the baseline job's own
   *                                    `standard validate` had merely failed to
   *                                    execute and was recorded as `fail`
   *
   * A red baseline is still a legitimate excuse — `baseline-red` means main was
   * MEASURED and found failing, so a PR failure is diagnostic rather than an
   * isolated regression, and that is the whole point of the two-job protocol.
   * An UNKNOWN baseline is not that: nothing was measured, so nothing excuses
   * anything, and a PR failure blocks. A PR status that is itself unknown always
   * blocks: the gate exists to run a check, and a check that did not run has not
   * passed.
   */
  blocking: boolean;
  reasons: string[];
};

export function classifyBaseline(
  baseline: ValidationResult | null,
  pr: ValidationResult | null,
): BaselineComparison {
  return classifyBaselineStatuses(
    baseline === null ? "unknown" : baseline.ok ? "pass" : "fail",
    pr === null ? "unknown" : pr.ok ? "pass" : "fail",
  );
}

export function classifyBaselineStatuses(
  baseline: BaselineStatus,
  pr: BaselineStatus,
): BaselineComparison {
  const prNotRun = pr === "unknown";
  // `baseline === "fail"` — and only that — is a measured red main. An unknown
  // baseline excuses nothing.
  const blocking = prNotRun || (pr === "fail" && baseline !== "fail");

  const prReasons: string[] = [];
  if (prNotRun) {
    prReasons.push("PR validation produced no verdict; a check that did not run has not passed");
  }

  if (baseline === "unknown") {
    return {
      classification: "baseline-unknown",
      prIntroducedFailure: false,
      prNotRun,
      blocking,
      reasons: [
        "baseline validation is unavailable or lacks provenance",
        ...prReasons,
        ...(pr === "fail"
          ? ["PR fails and the baseline was never measured, so the failure cannot be excused"]
          : []),
      ],
    };
  }
  if (baseline === "fail") {
    return {
      classification: "baseline-red",
      prIntroducedFailure: false,
      prNotRun,
      blocking,
      reasons: [
        "main already fails standard validation; PR result is diagnostic",
        ...prReasons,
      ],
    };
  }
  return {
    classification: "baseline-green",
    prIntroducedFailure: pr === "fail",
    prNotRun,
    blocking,
    reasons: [
      pr === "fail"
        ? "main passes and PR fails; candidate PR regression"
        : prNotRun
          ? "main passes; the PR check produced no verdict"
          : "main passes; no PR validation regression observed",
      ...prReasons,
    ],
  };
}
