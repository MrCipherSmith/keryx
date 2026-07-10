import type { ValidationResult } from "./types";

export type BaselineStatus = "pass" | "fail" | "unknown";
export type BaselineClassification = "baseline-green" | "baseline-red" | "baseline-unknown";

export type BaselineComparison = {
  classification: BaselineClassification;
  prIntroducedFailure: boolean;
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
  if (baseline === "unknown") {
    return {
      classification: "baseline-unknown",
      prIntroducedFailure: false,
      reasons: ["baseline validation is unavailable or lacks provenance"],
    };
  }
  if (baseline === "fail") {
    return {
      classification: "baseline-red",
      prIntroducedFailure: false,
      reasons: ["main already fails standard validation; PR result is diagnostic"],
    };
  }
  return {
    classification: "baseline-green",
    prIntroducedFailure: pr === "fail",
    reasons: pr === "fail"
      ? ["main passes and PR fails; candidate PR regression"]
      : ["main passes; no PR validation regression observed"],
  };
}
