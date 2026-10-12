/** Declared evidence for synthetic lifecycle fixtures, not a production review. */
export function readyResearchFixture(reviewers: string[] = ["synthetic-reviewer"], findings: string[] = []) {
  return {
    version: 1,
    scopeReviewed: true,
    rawReconciled: true,
    obligations: findings.map((finding) => ({
      id: `fixture-${finding}`,
      source: `synthetic-report#${finding}`,
      question: "Does this fixture finding survive canonical serialization?",
      status: "finding",
      finding,
      evidence: `Synthetic report explicitly supplies ${finding}; assertions inspect serialization`,
      reason: "Retained synthetic finding; research closure is separate from its later disposition",
    })),
    dispatch: {
      version: 1,
      mode: "all",
      override: { operatorQuote: "synthetic fixture", reason: "lifecycle fixture, not a production review" },
      selected: reviewers,
      unresolvedRules: [],
      runs: reviewers.map((reviewer) => ({
        reviewer,
        executionId: `synthetic-${reviewer}`,
        status: "complete",
        scopeComplete: true,
        rawEvidence: "Synthetic report supplied by this lifecycle fixture",
        ruleEvidence: ["Synthetic package lifecycle contract; no production change under review"],
        executionRequired: false,
        executionReason: "Synthetic serialization/CLI fixture, not a production reviewer execution",
      })),
    },
  };
}
