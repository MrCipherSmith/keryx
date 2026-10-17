export const READY_DISPATCH = {
  version: 1, mode: "all", override: { operatorQuote: "synthetic fixture", reason: "lifecycle fixture, not a production review" },
  selected: ["synthetic-reviewer"], unresolvedRules: [],
  runs: [{ reviewer: "synthetic-reviewer", executionId: "synthetic-independent-run", status: "complete",
    scopeComplete: true, rawEvidence: "synthetic fixture report", ruleEvidence: ["synthetic fixture contract"],
    executionRequired: false, executionReason: "Synthetic package lifecycle test; no production code under review" }],
};

/** The coverage.md an ingest writes for a package whose research is {@link READY_DISPATCH}: it lists the reviewer that ran. */
export const READY_COVERAGE_MD = "# Reviewer Coverage\n\nreviewer: synthetic-reviewer\nstatus: run\nreason: lifecycle fixture\n";
