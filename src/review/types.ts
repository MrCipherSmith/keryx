export const MANAGED_REVIEW_MODES = ["attach-review", "review-flow", "ingest"] as const;
export type ManagedReviewMode = (typeof MANAGED_REVIEW_MODES)[number];

export const REVIEW_TARGET_KINDS = ["pr", "issue", "branch", "path", "report"] as const;
export type ReviewTargetKind = (typeof REVIEW_TARGET_KINDS)[number];

export const REVIEW_PACKAGE_STATUSES = ["draft", "reviewed", "decided", "learned", "closed"] as const;
export type ReviewPackageStatus = (typeof REVIEW_PACKAGE_STATUSES)[number];

export const REVIEW_COVERAGE_STATUSES = ["run", "skipped", "failed", "needs_context"] as const;
export type ReviewCoverageStatus = (typeof REVIEW_COVERAGE_STATUSES)[number];

export const FINDING_CLASSIFICATIONS = [
  "missed_by_flow_gate",
  "valid_followup",
  "out_of_scope",
  "skill_learning_candidate",
  "false_positive",
] as const;
export type FindingClassification = (typeof FINDING_CLASSIFICATIONS)[number];

export type ManagedReviewTarget = {
  kind: ReviewTargetKind;
  ref: string;
  repository?: string | undefined;
  base?: string | undefined;
  head?: string | undefined;
};

export type ManagedReviewFlowRef = {
  id: string;
  path: string;
  issueUrl?: string | undefined;
  prUrl?: string | undefined;
};

export type ReviewCoverageEntry = {
  reviewer: string;
  status: ReviewCoverageStatus;
  reason: string;
};

export type ManagedReviewManifest = {
  schemaVersion: 1;
  reviewId: string;
  mode: ManagedReviewMode;
  status: ReviewPackageStatus;
  target: ManagedReviewTarget;
  flow?: ManagedReviewFlowRef | undefined;
  artifacts: {
    scope: string;
    coverage: string;
    report: string;
    findings: string;
    learning: string;
    decisions: string;
  };
  coverage: ReviewCoverageEntry[];
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type NormalizedReviewFinding = {
  id: string;
  severity: "blocker" | "major" | "minor" | "info";
  reviewer: string;
  summary: string;
  classification: FindingClassification;
  flow_relevance: "active_flow_feedback" | "post_flow_feedback" | "standalone_review";
  file?: string | undefined;
  line?: number | undefined;
};

export type ManagedReviewInput = {
  cwd: string;
  mode: ManagedReviewMode;
  target: ManagedReviewTarget;
  flowId?: string | undefined;
  reviewId?: string | undefined;
  reviewers?: string[] | undefined;
  coverage?: ReviewCoverageEntry[] | undefined;
  reportPath?: string | undefined;
  reportText?: string | undefined;
  now?: Date | undefined;
};

export type ManagedReviewPackageResult = {
  reviewId: string;
  path: string;
  manifest: ManagedReviewManifest;
};

export type FlowMatchResult = {
  id: string;
  dir: string;
  reason: "explicit-flow-id" | "pr-url" | "issue-url" | "branch" | "none";
};

export type ManagedReviewValidationResult = {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
};
