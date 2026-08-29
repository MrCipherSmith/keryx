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
 * What became of a finding.
 *
 * Six states, and the split is the point. Only `acted-on` and
 * `dismissed-incorrect` say anything about whether the reviewer was RIGHT; the
 * other three dismissals say the finding was correct and not worth doing now.
 * Collapsing them into one `dismissed` bucket produces a dismissal rate that
 * cannot be read, which is why they are separate here and separate in
 * `scripts/review-precision-baseline.ts`, whose categories these mirror exactly.
 *
 * `unknown` is the default AND the reading of an absent disposition, so the 83
 * pre-contract findings on disk report as unknown rather than as anything
 * flattering.
 */
export const FINDING_DISPOSITION_STATES = [
  "unknown",
  "acted-on",
  "dismissed-incorrect",
  "dismissed-wont-fix",
  "dismissed-out-of-scope",
  "dismissed-deprioritised",
] as const;
export type FindingDispositionState = (typeof FINDING_DISPOSITION_STATES)[number];

/** The dismissal states: a finding that was raised and then not acted on. */
export const FINDING_DISMISSAL_STATES = FINDING_DISPOSITION_STATES.filter((state) =>
  state.startsWith("dismissed-"),
) as ReadonlyArray<FindingDispositionState>;

/**
 * A disposition, which is a state plus the evidence for it.
 *
 * `evidence` is not optional in practice: every state except `unknown` requires
 * it, enforced by `review-finding.schema.json` and again by the writers in
 * `managed.ts`. It is typed optional only so `{ state: "unknown" }` is
 * expressible.
 */
export type ReviewFindingDisposition = {
  state: FindingDispositionState;
  evidence?: string | undefined;
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
  /**
   * The join key: `<reviewId>#<id>`, unique across packages and stable across
   * rounds.
   *
   * `id` stays the display form because it is load-bearing for humans and for
   * the legacy parser — it is read out of a markdown heading, printed into
   * `decisions.md` and `learning.md`, quoted in flow journals and commit
   * messages, and carried by all 83 records already on disk. It is also
   * per-report: `F-001` denotes six different findings across the corpus, so it
   * cannot be a key. The two jobs are separated rather than merged.
   *
   * Minted once, by {@link module:review/managed}, when a finding is first
   * recorded; carried verbatim when the producer already supplies one, which is
   * what makes it stable across rounds — round N+1 hands round N's finding back
   * through `prior_findings[].finding`, key included.
   *
   * Optional because the pre-contract corpus has none and must still read.
   */
  global_id?: string | undefined;
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
  /**
   * What became of the finding. Absent reads as `unknown` — see
   * {@link module:review/managed.findingDispositionState}.
   *
   * This is the one keryx-local judgement that DOES belong on the persisted
   * record rather than in `decisions.md`, and the reason is the measurement:
   * `decisions.md` is prose, so the disposition of 83 findings had to be
   * reconstructed from commit messages and flow journals by a curated ledger,
   * and the reconstruction could not find a single wrong finding because none
   * was ever written down. A field on the record is the thing that ends that.
   */
  disposition?: ReviewFindingDisposition | undefined;
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
  /**
   * What this round RAISED AND THEN DISMISSED — the half that was never written
   * down.
   *
   * Rounds 3 and 5 of PR #220 each carry a section headed "Where a reviewer was
   * wrong", describing findings refuted during the round. Neither refuted
   * finding became a record. PR #220's consolidated review abridged thirteen
   * further observations and deferred to a "full set" that is not on disk, and
   * the owning flow then declared the whole class out of scope — textbook
   * `dismissed-out-of-scope` dispositions, correctly reasoned, and zero of them
   * recorded. What survives to `findings.json` is therefore the survivors of an
   * unlogged triage, which is why measuring the corpus measures the triage and
   * returns 100% by construction.
   *
   * These are normalized, contract-gated and written exactly like reported
   * findings, into the same `findings.json`, so nothing has to remember to read
   * a second file. Each one is stamped with a dismissal disposition —
   * `dismissed-incorrect` unless it names another `dismissed-*` state — and
   * each one must carry `disposition.evidence`. Refusal becomes a write.
   */
  refuted?: ReviewFindingsSource | undefined;
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
