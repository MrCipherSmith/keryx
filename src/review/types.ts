// Type-only, and therefore erased: `review/verification` imports runtime values
// from this module, so a value import back would be a real cycle. The merge
// result types live there because they describe what the merge does, not what a
// finding is.
import type { VerificationCap, VerificationCounts, VerificationRejection } from "./verification";
// Type-only for the same reason, in the other direction: `review/caps` imports
// `ReviewFindingSeverity` from here as a type, and this imports the caps record
// as a type. Both are erased, so neither is a runtime cycle.
import type { ReviewCapsRecord } from "./caps";
// Type-only for the third time, and for the reason the other two give: the
// filter-stats producer imports the pre-filter shapes declared below, so a value
// import back would close a runtime cycle. Both directions are erased.
import type { ReviewFilterStats } from "./filter-stats";
import type { ReviewNoteResult } from "./review-notes";

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
  /**
   * The commit the round ran against.
   *
   * Optional in the type and NOT optional in practice: the review completion gate
   * (`src/flow/review-gate.ts`, condition 3) compares this against the pull
   * request's head, and a round whose SHA is unknown proves nothing about what
   * will merge. It stayed `undefined` on every package this repository has ever
   * written — the property existed, the schema accepted it, and no producer set
   * it — so the gate reported `head-commit (unobserved)` for every flow and
   * `flow complete` could not pass. {@link ManagedReviewInput.resolveHead} is the
   * producer that ends that; `undefined` now means only "there was no git
   * checkout to ask", which the gate still refuses.
   */
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
  /**
   * What this round filtered, in a form a machine can check (roadmap §5.1).
   *
   * It lives on the MANIFEST rather than in a seventh artifact file for the same
   * reason the stage counts went into `scope.md`: `missingArtifacts` names the
   * six files a package must have, and adding a seventh would strand every
   * package already on disk. The manifest is read back by
   * {@link module:review/managed.getManagedReviewStatus} and by the review
   * completion gate, so a record put here already has readers.
   *
   * Optional because every package written before flow 207 has none, and absent
   * is the honest reading of those: nothing measured them. It is NOT optional in
   * practice — every ingest writes it — which is exactly the state `target.head`
   * was in before a producer was built for it, so `keryx review status` reads it
   * back and says `not recorded` rather than letting the silence pass.
   */
  filter_stats?: ReviewFilterStats | undefined;
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
  "answered-disagree",
] as const;
export type FindingDispositionState = (typeof FINDING_DISPOSITION_STATES)[number];

/** The dismissal states: a finding that was raised and then not acted on. */
export const FINDING_DISMISSAL_STATES = FINDING_DISPOSITION_STATES.filter((state) =>
  state.startsWith("dismissed-"),
) as ReadonlyArray<FindingDispositionState>;

/**
 * The states that end an external comment's life, and therefore the states the
 * reply pass will speak.
 *
 * `answered-disagree` is deliberately NOT a `dismissed-*` state and is therefore
 * not in {@link FINDING_DISMISSAL_STATES}. The distinction is the whole content
 * of AC10: a `refuted` verdict from our own verifier is a machine deciding a
 * human's question was invalid, and calling that `dismissed-incorrect` would let
 * the finding leave the pipeline with nobody speaking to the person who raised
 * it. `answered-disagree` says the same thing about the code and a different
 * thing about our obligation — it still requires a reply.
 */
export const EXTERNAL_TERMINAL_DISPOSITIONS = [
  "acted-on",
  "answered-disagree",
  "dismissed-incorrect",
  "dismissed-wont-fix",
  "dismissed-out-of-scope",
  "dismissed-deprioritised",
] as const satisfies ReadonlyArray<FindingDispositionState>;

/** Where a finding came from. Absent reads as `internal` — see {@link StructuredReviewFinding.source}. */
export const REVIEW_FINDING_SOURCES = ["internal", "external"] as const;
export type ReviewFindingSource = (typeof REVIEW_FINDING_SOURCES)[number];

/**
 * The GitHub comment an external finding is the record of.
 *
 * Every property here exists to make ONE operation possible after the fact:
 * replying in the right place, to the right person, once. `thread_id` is what
 * routes the reply into the existing conversation instead of opening a new one;
 * `submitted_at` is what decides whether a later reply from someone else reopens
 * a comment we already answered. `path` and `line` are nullable because a review
 * submission body and a PR-level comment are anchored to the pull request rather
 * than to a line, and inventing a location for them would put our reply on a file
 * the reviewer never mentioned.
 */
export type ExternalCommentRef = {
  /** Namespaced (`review-comment:12`), because the three GitHub endpoints number independently. */
  id: string;
  author: string;
  url: string;
  path?: string | null | undefined;
  line?: number | null | undefined;
  thread_id?: string | null | undefined;
  submitted_at: string;
};

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

// ---------------------------------------------------------------------------
// Verification (flow 202, AC7-AC11)
// ---------------------------------------------------------------------------

/**
 * What an independent check found when it went looking for the finding.
 *
 * Three verdicts and no fourth. `confirmed` says something was executed or
 * inspected and the finding held; `refuted` says the same procedure showed it
 * does not; `unverifiable` says no procedure was available. The third is not a
 * failure state — it is the honest majority answer, and giving it a name is what
 * stops "I thought about it and it seems right" from being recorded as
 * `confirmed`.
 */
export const VERIFICATION_VERDICTS = ["confirmed", "refuted", "unverifiable"] as const;
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

/**
 * How the verdict was reached, strongest first. The order is the contract, not a
 * preference: {@link module:review/verification.mergeVerifications} caps what the
 * weakest one may conclude.
 *
 * - `execution` — a command or test was run that FAILS IF THE FINDING IS REAL.
 *   Verification that executes rejects 85-96% of false reports against 4-15%
 *   unaided while finding 30-44% more true bugs (AnyPoC, arXiv:2604.11950), and
 *   TestGen-LLM's build -> pass -> improves-coverage funnel (75% -> 57% -> 25%)
 *   is what makes the surviving quarter reach 73% human acceptance
 *   (arXiv:2402.09171). keryx is a Bun project; running something is cheap.
 * - `site-check` — the sites named in `class_scope` were looked for and either
 *   exist or do not. Weaker than execution: it establishes that the code the
 *   finding describes is there, not that the behaviour it claims occurs.
 * - `reasoning` — neither of the above was possible. By construction this
 *   produces NO new evidence, which is why it is capped: see
 *   `REASONING_CAPPED_VERDICT`.
 */
export const VERIFICATION_METHODS = ["execution", "site-check", "reasoning"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/**
 * The only verdict a reasoning-only check may carry.
 *
 * AC7 requires that reasoning alone can never reach `confirmed`. The cap is
 * applied to `refuted` as well, and that is a deliberate extension of the
 * criterion in the one direction that is safe to extend it: `refuted` is the
 * ONLY verdict with a destructive consequence — in `filter` mode it removes the
 * finding — so allowing the weakest method to reach it would reinstate
 * `review-strict` with the sign flipped. Re-reading a finding and changing what
 * happens to it with no new evidence is the operation this whole phase removes;
 * it does not become safe by pointing downward.
 *
 * Nothing checkable is lost. "The line this finding cites does not exist" is not
 * reasoning — it is `site-check`, and it is available. `reasoning` is the
 * residual: the cases where nothing was run and nothing was looked up. The
 * honest thing for that residual to say is "I could not verify this."
 */
export const REASONING_CAPPED_VERDICT: VerificationVerdict = "unverifiable";

/**
 * One verification, as it is recorded on the finding.
 *
 * `verifier` is beyond the three properties AC7 names, and it is here because
 * without it AC9 leaves no trace: the merge refuses a self-verification at write
 * time, but a record that does not say who verified cannot be audited for the
 * rule afterwards — which is the same defect as `reviewer` being hardcoded to
 * `review-orchestrator` on all 83 recorded findings. It is optional only so a
 * hand-written record is not rejected for lacking it; the writer always fills it.
 */
export type ReviewFindingVerification = {
  verdict: VerificationVerdict;
  method: VerificationMethod;
  evidence: string;
  verifier?: string | undefined;
};

/**
 * Whether the verifier's verdicts are recorded, or acted on.
 *
 * `annotate` is the default and stays the default for one release. The verifier
 * records `refuted` without removing anything, so the drop rate is a measured
 * number before it costs a real finding. The risk is named rather than assumed
 * away: SWE-agent keeps its equivalent opt-in because it sometimes rejects
 * correct patches, and a filter that silently removes a true blocker is worse
 * than the noise it removes.
 *
 * - `off` — no verification at all. Claims are refused rather than ignored.
 * - `annotate` — verdicts are recorded on every finding; nothing is removed.
 * - `filter` — a `refuted` finding is removed from the reported set and recorded
 *   as `dismissed-incorrect`, with the verification evidence as its evidence.
 */
export const VERIFICATION_MODES = ["off", "annotate", "filter"] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** The default, asserted by a test rather than by this comment. */
export const DEFAULT_VERIFICATION_MODE: VerificationMode = "annotate";

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
  /**
   * What an independent check found. Absent means nobody checked.
   *
   * Absent is NOT "unverified and therefore droppable": the 83 pre-contract
   * findings on disk have none, and neither does any finding produced with
   * `verification_mode: off`. Only an applied `refuted` verdict removes
   * anything, and only in `filter` mode.
   *
   * Declared here and NOT in the bundled `reviewer-finding.schema.json`, on the
   * same basis as `disposition` — see that field. A reviewer states what is
   * wrong; whether someone else could reproduce it is not something the reviewer
   * knows, and AC9 says the reviewer that raised the finding is precisely the one
   * that may never answer it. Declaring the property in the shape reviewers emit
   * would be an invitation to fill in the one field they are forbidden to fill.
   */
  verification?: ReviewFindingVerification | undefined;
  /**
   * Who raised this: one of our reviewers, or somebody on the pull request.
   *
   * Absent reads as `internal`, which is what all 83 pre-contract records are and
   * what every reviewer emits. It is written only for `external`, on the same
   * rule as `disposition` and `verification`: a property present on every record
   * says nothing, and a property present on a few says exactly one thing.
   *
   * The value is load-bearing rather than descriptive. Three mechanisms read it
   * and change behaviour: the verifier cannot refute an external finding (AC10),
   * the per-reviewer findings cap does not truncate one (AC9 — "may never
   * silently drop it"), and the completion gate refuses while one is unanswered
   * (AC5). A finding that lost this property would quietly acquire all three of
   * the behaviours the criteria forbid.
   */
  source?: ReviewFindingSource | undefined;
  /** Required when `source` is `external`, meaningless otherwise. */
  external_ref?: ExternalCommentRef | undefined;
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
  /**
   * What `review-verifier` returned: one claim per finding it checked.
   *
   * Typed loosely on purpose. The merge is delete-only and enforces that by
   * reading ONLY the verdict out of a claim, so it has to be able to receive —
   * and visibly reject — a claim that tried to carry a severity. A narrow type
   * here would move that rejection to compile time for callers inside this
   * repository and leave it absent for every caller outside it.
   */
  verifications?: readonly VerificationClaimInput[] | undefined;
  /** Defaults to {@link DEFAULT_VERIFICATION_MODE}. */
  verificationMode?: VerificationMode | undefined;
  /**
   * What the pre-filter removed, from `keryx review scope --json`: the counts
   * AND the reason for every individual drop.
   *
   * This is the supported channel. {@link ManagedReviewInput.scopeCounts} is the
   * counts-only form kept for callers that hold nothing else; when both are
   * present this one wins, because it is the only one that satisfies AC5.
   *
   * Optional, and its absence is recorded as "not recorded" rather than as
   * zero: "the pre-filter dropped nothing" and "no pre-filter ran" are different
   * facts, and a stage count that cannot tell them apart is the same defect as
   * `dismissed-out-of-scope = 0` meaning "not written down".
   */
  scope?: ReviewScopeRecordLike | undefined;
  /** The counts half of {@link ManagedReviewInput.scope}, when that is all the caller has. */
  scopeCounts?: ReviewScopeCountsLike | undefined;
  /**
   * Findings cap, per reviewer. Defaults to
   * {@link module:review/caps.DEFAULT_MAX_FINDINGS_PER_REVIEWER} — the default
   * lives in code precisely so a caller that says nothing still gets a bound.
   *
   * Blockers and anything flagged `blocking_merge` are exempt and do not consume
   * it. Whatever it truncates is named in `scope.md` under `## Caps`.
   */
  maxFindingsPerReviewer?: number | undefined;
  /**
   * What this round cost so far, in US dollars.
   *
   * Absent is recorded as `not recorded`, NOT as `0`: a round that never
   * reported its spend has not demonstrated it stayed inside the ceiling.
   */
  spend?: number | undefined;
  /** Defaults to {@link module:review/caps.DEFAULT_SPEND_CEILING_USD}. */
  spendCeiling?: number | undefined;
  /**
   * The parallel dispatch plan, when the caller has one.
   *
   * `outstanding` is the subagent count the CALLER declares it already has in
   * flight. It is the only thing that lets the cap say anything about the
   * `job-orchestrator` -> `flow-orchestrator` -> `review-orchestrator` nesting,
   * and it is a declaration rather than an observation — see
   * {@link module:review/caps.ConcurrencyPlan.holdsAcrossNesting}.
   */
  concurrency?:
    | {
        cap?: number | undefined;
        outstanding?: number | undefined;
        /** Defaults to the coverage entries whose status is `run`. */
        reviewers?: readonly string[] | undefined;
      }
    | undefined;
  /**
   * How `target.head` is filled in when the caller supplied none.
   *
   * Injectable for one reason and not for configurability: the default reads the
   * real git checkout, and a test that hands the resolver a literal SHA is
   * testing its own fixture rather than the producer. Every test that wants to
   * prove the producer WORKS therefore leaves this alone and runs against a real
   * repository; this seam exists so a caller with a different source of truth
   * (a remote checkout, a worktree, a replayed round) can say so.
   *
   * Returning `null` means "there was nothing to ask", and the head is left
   * absent rather than invented.
   */
  resolveHead?: ((input: { cwd: string; target: ManagedReviewTarget }) => Promise<string | null>) | undefined;
  now?: Date | undefined;
};

/**
 * A verification claim as it arrives, before anything is checked.
 *
 * The index signature is what lets an attempted escalation reach the merge and
 * be rejected by name instead of being silently dropped by the type system.
 */
export type VerificationClaimInput = {
  finding?: string | undefined;
  verdict?: string | undefined;
  method?: string | undefined;
  evidence?: string | undefined;
  verifier?: string | undefined;
  [key: string]: unknown;
};

/** The shape a verifier result arrives in: a bare array or the wrapper. */
export type VerificationSource =
  | readonly VerificationClaimInput[]
  | { verifier?: string | undefined; verifications: readonly VerificationClaimInput[] };

/**
 * The pre-filter counts this module needs, structurally.
 *
 * Declared here rather than imported from `review/scope` so `review/types` keeps
 * no dependency on the pre-filter: the two stages are independent and a review
 * record can carry either half alone.
 */
export type ReviewScopeCountsLike = {
  filesSeen: number;
  filesRetained: number;
  filesDropped: number;
  blocksSeen: number;
  blocksRetained: number;
  blocksDropped: number;
  changedLinesRetained: number;
  changedLinesDropped: number;
};

/**
 * One thing the pre-filter removed, structurally — the row AC5 asks for.
 *
 * `reason` is a bare `string` rather than `ScopeDropReason` for the same reason
 * the counts are declared here rather than imported: this module keeps no
 * dependency on `review/scope`. The value written is whatever the pre-filter
 * produced, verbatim, so a new reason added there reaches the record without a
 * change here — and a hand-written record is not rejected for using a word this
 * file has not heard of.
 */
export type ReviewScopeDropLike = {
  path: string;
  reason: string;
  detail: string;
  granularity: "file" | "block";
  startLine?: number | undefined;
  endLine?: number | undefined;
  changedLines: number;
};

/**
 * The WHOLE pre-filter result, counts and per-drop reasons together.
 *
 * The counts alone were the only thing that could reach a review package, and
 * that was the defect: AC5 asks for "a reason per drop", and eight integers
 * carry no reason. The drop rows travelled by a different route — `keryx review
 * scope --append` writing straight into `scope.md` — which `review ingest` then
 * overwrote, replacing a recorded drop table with the sentence "no pre-filter
 * scope was supplied". One input, one writer, one file.
 */
export type ReviewScopeRecordLike = {
  mode?: string | undefined;
  contextLines?: number | undefined;
  files?: readonly string[] | undefined;
  drops: readonly ReviewScopeDropLike[];
  counts: ReviewScopeCountsLike;
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
  /** AC11. Present on every package, whether or not a verifier ran. */
  verification: VerificationCounts;
  verificationRejections: readonly VerificationRejection[];
  verificationCaps: readonly VerificationCap[];
  /**
   * What the findings, spend and concurrency caps did (flow 203 AC5–AC7, AC10).
   *
   * Returned as well as written into `scope.md` so the CLI can say STOP on a
   * spend ceiling without re-reading the package it just wrote.
   */
  caps: ReviewCapsRecord;
  /** Flow 207 AC1. The same object the manifest carries; see there for why. */
  filterStats: ReviewFilterStats;
  /**
   * The learning notes this round wrote, and the dismissals it refused to write
   * one for (flow 207 AC5/AC6).
   *
   * Returned so the CLI can print both halves. A dismissal that reached no note
   * is the interesting half: it means a finding was filed as model error with
   * nobody standing behind the decision.
   */
  reviewNotes: ReviewNoteResult;
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
