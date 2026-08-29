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

export const REVIEW_FINDING_SEVERITIES = ["blocker", "major", "minor", "info"] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export const REVIEW_FINDING_CONFIDENCES = ["high", "medium", "low"] as const;
export type ReviewFindingConfidence = (typeof REVIEW_FINDING_CONFIDENCES)[number];

export type ReviewFindingClassScope = {
  sites: string[];
  enumeration_method: string;
};

/**
 * One finding, in exactly the shape `review-finding.schema.json` accepts.
 *
 * This type is the persisted record: `findings.json` is an array of these and
 * nothing else, because the schema is `additionalProperties: false` and a round
 * that cannot be fed back into `prior_findings[].finding` is a round that ends
 * the conversation. Every keryx-local judgement about a finding — how it was
 * classified, how it relates to a flow — lives on {@link NormalizedReviewFinding}
 * and is rendered into `decisions.md`, NOT smuggled into this object.
 *
 * `confidence` is a string enum because that is what the committed schema says
 * today. The roadmap moves it to a number in [0,1] in a later phase; carrying
 * the current shape is deliberate so the two changes do not collide.
 */
export type StructuredReviewFinding = {
  id: string;
  reviewer: string;
  severity: ReviewFindingSeverity;
  problem: string;
  impact: string;
  suggested_fix: string;
  evidence: string;
  confidence: ReviewFindingConfidence;
  file?: string | null | undefined;
  line?: number | null | undefined;
  symbol?: string | null | undefined;
  dedupe_key?: string | null | undefined;
  blocking_merge?: boolean | undefined;
  related_skill?: string | null | undefined;
  learning_candidate?: boolean | undefined;
  class_scope?: ReviewFindingClassScope | undefined;
};

/**
 * A finding plus the triage the managed-review pipeline assigns to it.
 *
 * The split matters: the reviewer states the finding, the pipeline states what
 * it intends to do about it. Merging the two is what produced a `findings.json`
 * that no contract accepted.
 */
export type NormalizedReviewFinding = StructuredReviewFinding & {
  /** The heading text; kept for rendering. `problem` is the contract field. */
  summary: string;
  classification: FindingClassification;
  flow_relevance: "active_flow_feedback" | "post_flow_feedback" | "standalone_review";
  /**
   * Whether the finding carried a `class_scope` — every site of the shape, and
   * how the set was enumerated.
   *
   * Always the same answer as `class_scope !== undefined` on the record about to
   * be written, on both the structured and the legacy path. It was once a
   * separate shape check over the markdown prose, which could pass on a block
   * whose `class_scope` extraction returned null; a `major` in that state was
   * accepted by the guard and persisted without the property
   * `review-finding.schema.json` requires.
   */
  class_scope_present?: boolean | undefined;
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
  /**
   * The structured findings the reviewers produced, when the caller still has
   * them.
   *
   * The markdown report is lossy by construction — no reviewer report format in
   * this repository carries `impact`, `suggested_fix`, `evidence` or
   * `confidence` under a label a parser can rely on — so re-deriving these from
   * prose is not a parsing problem to be solved but a fact that has already been
   * destroyed. When a caller has the reviewer payloads it passes them here and
   * nothing is re-derived. See `parseEmbeddedFindings` for the same array
   * travelling inside the report itself.
   */
  findings?: ReviewFindingsSource | undefined;
  now?: Date | undefined;
};

/**
 * The shapes a structured findings payload arrives in.
 *
 * A bare array is the normalized contract. The wrapper forms are what a reviewer
 * actually returns (`reviewer-finding.schema.json`: `{ reviewer, findings }`),
 * accepted so an orchestrator can hand over what it already holds instead of
 * transcribing it — transcription being the step that lost the fields.
 */
export type ReviewFindingsSource =
  | ReadonlyArray<Partial<StructuredReviewFinding>>
  | ReviewerResultLike
  | ReadonlyArray<ReviewerResultLike>;

export type ReviewerResultLike = {
  reviewer?: string | undefined;
  findings: ReadonlyArray<Partial<StructuredReviewFinding>>;
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
