export type LightweightPlan = {
  profile: "lightweight";
  phases: ["gdgraph-affected", "focused-tests", "review"];
  reviewer: string;
  requiredGates: ["tests", "security"];
  skipped: Array<{ phase: string; reason: string }>;
  changedFiles: string[];
};

export function selectLightweightPlan(input: {
  changedFiles: string[];
  reviewers?: string[];
}): LightweightPlan {
  const allowedReviewers = new Set([
    "review-logic",
    "review-security-code",
    "review-testing-practices",
    "review-architecture",
    "review-style",
  ]);
  const reviewer = input.reviewers?.find((candidate) => allowedReviewers.has(candidate)) ?? "review-logic";
  return {
    profile: "lightweight",
    phases: ["gdgraph-affected", "focused-tests", "review"],
    reviewer,
    requiredGates: ["tests", "security"],
    changedFiles: [...input.changedFiles].sort(),
    skipped: [
      { phase: "job-initialization", reason: "bounded profile for a small task" },
      { phase: "broad-context-collection", reason: "affected context is sufficient for selected scope" },
      { phase: "additional-reviewers", reason: "exactly one reviewer is required by lightweight mode" },
      { phase: "benchmark", reason: "benchmark is not part of a task execution" },
    ],
  };
}
