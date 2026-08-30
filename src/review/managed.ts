import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { flowsRoot, listFlowDirs, readFlow, resolveFlowDir, slugify } from "../flow/store";
import type { FlowState } from "../flow/types";
import {
  mergeVerifications,
  renderStageCountsMarkdown,
  type VerificationMergeResult,
} from "./verification";
import {
  applyExternalVerdictRule,
  partitionExternalFindings,
  type ExternalReclaim,
} from "./pr-comments";
import {
  applyFindingsCap,
  evaluateSpendCap,
  planReviewerWaves,
  renderCapsMarkdown,
  type ConcurrencyPlan,
  type ReviewCapsRecord,
} from "./caps";
import {
  DEFAULT_VERIFICATION_MODE,
  FINDING_DISMISSAL_STATES,
  MANAGED_REVIEW_MODES,
  REVIEW_COVERAGE_STATUSES,
  REVIEW_FINDING_CONFIDENCES,
  REVIEW_PACKAGE_STATUSES,
  REVIEW_TARGET_KINDS,
  type FindingClassification,
  type FindingDispositionState,
  type FlowMatchResult,
  type ManagedReviewInput,
  type ManagedReviewManifest,
  type ManagedReviewMode,
  type ManagedReviewPackageResult,
  type ManagedReviewValidationResult,
  type NormalizedReviewFinding,
  type ReviewCoverageEntry,
  type ReviewFindingClassScope,
  type ReviewFindingConfidence,
  type ReviewFindingDisposition,
  type ManagedReviewTarget,
  type ReviewFindingsSource,
  type ReviewerResultLike,
  type ReviewScopeCountsLike,
  type ReviewScopeDropLike,
  type StructuredReviewFinding,
} from "./types";

const REQUIRED_ARTIFACTS = ["scope", "coverage", "report", "findings", "learning", "decisions"] as const;

export function reviewsRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "reviews");
}

/**
 * `git rev-parse HEAD` in `cwd`, or `null` when there is no checkout to ask.
 *
 * `null` rather than a throw, and `null` rather than `""`: the caller has to be
 * able to tell "this round ran against no recorded commit" from "this round ran
 * against the empty string", and only the first of those is an honest record.
 * The output is checked against the shape git prints, so a `git` that answers
 * with a warning, a prompt, or a symbolic name cannot become a SHA.
 */
export async function resolveGitHead(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) {
      return null;
    }
    const sha = stdout.trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The commit this round ran against, recorded on the manifest.
 *
 * Precedence, and the reasoning for it:
 *
 * 1. **What the caller said.** `keryx review start|attach|ingest --head <sha>`,
 *    or a library caller that already knows. Nothing here second-guesses it.
 * 2. **The local checkout.** The reviewers read a working tree; the commit that
 *    tree is at is what they reviewed. For a `pr` target this is deliberately
 *    preferred over the pull request's own head: if the two differ, the round
 *    ran on something other than what will merge, and recording the PR head
 *    would make the completion gate PASS on exactly that discrepancy. The gate
 *    compares the two, so the honest value is the one that lets it.
 * 3. **Nothing.** `null`, left off the manifest, and the gate reports
 *    `head-commit (unobserved)` — which is a failure, not a pass.
 *
 * The pull request's own head is resolved one layer up, in `keryx review`, and
 * only when there is no checkout to ask (reviewing a PR from outside a clone).
 * Keeping the network call out of here is what lets this function run in every
 * test without one.
 */
export async function resolveTargetHead(input: ManagedReviewInput): Promise<string | null> {
  const declared = input.target.head;
  if (typeof declared === "string" && declared.trim() !== "") {
    return declared.trim();
  }
  return (input.resolveHead ?? ((args) => resolveGitHead(args.cwd)))({
    cwd: input.cwd,
    target: input.target,
  });
}

/** {@link ManagedReviewTarget} with the resolved head folded in. */
function targetWithHead(target: ManagedReviewTarget, head: string | null): ManagedReviewTarget {
  return head === null ? target : { ...target, head };
}

export async function findRelatedFlow(input: {
  cwd: string;
  flowId?: string | undefined;
  target: { kind: string; ref: string };
}): Promise<FlowMatchResult | null> {
  if (input.flowId) {
    const dir = await resolveFlowDir(input.cwd, input.flowId);
    const flow = await readFlow(input.cwd, dir);
    return { id: flow.id, dir, reason: "explicit-flow-id" };
  }

  const dirs = await listFlowDirs(input.cwd);
  for (const dir of dirs) {
    const flow = await readFlow(input.cwd, dir);
    if (matchesTarget(flow, dir, input.target.kind, input.target.ref)) {
      return { id: flow.id, dir, reason: matchReason(flow, dir, input.target.kind, input.target.ref) };
    }
  }

  return null;
}

export async function createManagedReviewPackage(
  input: ManagedReviewInput,
): Promise<ManagedReviewPackageResult> {
  const at = (input.now ?? new Date()).toISOString();
  const flowMatch = await resolvePackageFlow(input);
  const { reviewId, packageDir } = await allocatePackage(input, flowMatch, at);
  const coverage = normalizeCoverage(input.coverage, input.reviewers);
  const report = await readReport(input);
  const reviewers = coverage.filter((entry) => entry.status === "run").map((entry) => entry.reviewer);
  const reported = await normalizeFindings({
    report,
    reportLabel: reportLabel(input),
    mode: input.mode,
    attachedToFlow: flowMatch !== null,
    source: input.findings,
    reviewers,
  });
  // Minted BEFORE the verifier runs, because a claim names a finding by
  // `global_id` and the key has to exist for it to be resolvable. Round N+1
  // carries round N's key verbatim; only a finding without one is minted here.
  assignGlobalIds(reported, reviewId);

  // The verifier, which can only delete. In `annotate` — the default for one
  // release — nothing is removed and a `refuted` verdict is recorded on a finding
  // that is still reported, so the drop rate is a measured number before it costs
  // a real finding.
  const merged = mergeVerifications(reported, input.verifications ?? [], {
    mode: input.verificationMode ?? DEFAULT_VERIFICATION_MODE,
  });

  // AC10. A `refuted` verdict on an EXTERNAL finding does not remove it and does
  // not dismiss it — it becomes `answered-disagree`, which still owes a reply. A
  // human asked a question; a machine deciding the question was invalid is not an
  // answer, and in `filter` mode the finding would otherwise have left the
  // package entirely with nobody speaking to the person who raised it.
  const { result: verification, reclaimed: externalReclaims } = applyExternalVerdictRule(merged);

  // The findings cap (AC5): 10 per reviewer, blockers exempt, default in code.
  //
  // It runs over the SURVIVING reported findings only, and over neither of the
  // other two channels, for a reason that is the whole point of this pipeline:
  // `fromVerifierRefutations` and `input.refuted` are the record of what was
  // raised and then DISMISSED. Truncating those would rebuild by hand the exact
  // state flow 202 measured — a corpus holding only the survivors of an unlogged
  // triage, which reports 100% precision whatever the reviewers got right.
  // A reading cap belongs on the report, never on the dismissals.
  //
  // Whatever it removes is named, by reviewer and by id, in `scope.md`. A cap
  // that truncated silently would read as "there was nothing more".
  //
  // External findings do NOT enter the cap. AC9 says an external comment may
  // never be silently dropped, and this cap drops silently by design — it is a
  // READING cap over what one reviewer reported. `reviewer` on an external
  // finding is the commenter's login, so thirty CodeRabbit comments would
  // truncate to ten and twenty people would go unanswered, with the truncation
  // recorded under a heading nobody opens. Externals are bounded instead by
  // `max_replies_total`, which reports its backlog out loud and still answers it.
  const scoped = partitionExternalFindings(verification.retained);
  const findingsCap = applyFindingsCap(scoped.internal, {
    limit: input.maxFindingsPerReviewer,
  });

  // What the round reported, then what the verifier removed, then what the round
  // itself refuted — one array, one file, one gate. A separate `refuted.json`
  // would be a second thing every consumer has to remember to read, and the
  // consumer that forgets keeps counting zero wrong findings, which is the state
  // this exists to leave.
  const findings = [
    ...findingsCap.retained,
    ...scoped.external,
    ...fromVerifierRefutations(verification.refuted),
    ...fromRefutedSource(input.refuted, reviewers, flowMatch !== null),
  ];
  assignGlobalIds(findings, reviewId);
  // The commit this round ran against. Resolved HERE rather than left to the
  // caller because leaving it to the caller is what produced a repository full
  // of packages with no head at all: `ManagedReviewTarget.head` existed, the
  // schema accepted it, the completion gate compared against it, and nothing on
  // the writing side ever set it. See {@link resolveTargetHead}.
  const head = await resolveTargetHead(input);
  const manifest = buildManifest({
    input,
    target: targetWithHead(input.target, head),
    reviewId,
    packageDir,
    flowMatch,
    coverage,
    at,
  });

  const validation = await validateManagedReviewManifest(input.cwd, manifest);
  if (!validation.valid) {
    throw new Error(`Invalid managed review manifest: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  }

  const collisions = findingKeyCollisions(findings);
  if (collisions.length > 0) {
    throw new Error(
      `Refusing to record two findings under one key: ${collisions.join(
        "; ",
      )}. \`global_id\` is \`<reviewId>#<id>\`, so two findings sharing a display id in one package share a key — and a key that denotes two findings is the defect this field exists to remove.`,
    );
  }

  const unevidenced = unevidencedDispositions(findings);
  if (unevidenced.length > 0) {
    throw new Error(
      `Refusing to record a disposition with no evidence: ${unevidenced.join(
        ", ",
      )}. A disposition without evidence is an assertion, and a corpus of assertions is what measured 100% precision while recording zero wrong findings. Give the commit, the test, or the decision — or record nothing and let it read as unknown.`,
    );
  }

  const violations = classScopeViolations(findings);
  if (violations.length > 0) {
    // Before the package is written, so a refused ingest leaves nothing behind
    // that a later round could mistake for a recorded review.
    throw new Error(
      `Refusing to record findings that do not enumerate their class: ${violations
        .map((finding) => `${finding.id} (${finding.severity})`)
        .join(", ")}. A blocker or major must carry class_scope with sites and enumeration_method — every site holding the shape, and how the set was derived.`,
    );
  }

  // The contract gate, applied to the projection that is about to be written and
  // applied the SAME WAY whichever source produced it. It used to live inside
  // `fromStructuredSource`, which meant the legacy parser wrote unvalidated
  // records: `class_scope_present` was a shape check over prose while
  // `class_scope` came from a separate extraction, so a `major` whose block
  // named class_scope in sentences passed the guard and was persisted without
  // the property the schema requires — and the round-2 input built from it was
  // rejected by the same schema. One gate, one place, both paths.
  const contractErrors = await schemaErrors(findings);
  if (contractErrors.length > 0) {
    throw new Error(
      `Refusing to record findings that do not satisfy review-finding.schema.json: ${contractErrors
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")}`,
    );
  }

  // Read BEFORE the write, because the write is what used to destroy it. The
  // orchestrator is told to run `keryx review scope --append <package>/scope.md`
  // at Step 3 and `review ingest` after Step 12; ingest rewrote scope.md
  // unconditionally, and what replaced the drop table was not a blank — it was
  // "no pre-filter scope was supplied to this package", a false statement of the
  // same class as `dismissed-out-of-scope: 0`. When this ingest was handed its
  // own scope the carried block is superseded and dropped; when it was not, the
  // block is the only record of the drops and is carried forward verbatim.
  const carried = input.scope === undefined ? await readPreFilterScopeBlock(packageDir) : undefined;

  // AC10. Every cap that ran is on the record with a count, and every cap that
  // did NOT run is on the record as `not recorded` rather than as a zero.
  //
  // The spend ceiling is EVALUATED here and does not refuse the write. The
  // package is the record of what the round did, including the record of it
  // running out of money, and a cap that stopped the write would delete the
  // evidence that it fired — the same class of failure as an ingest overwriting
  // the pre-filter's drop table. The refusal is the caller's: the CLI exits
  // non-zero and says STOP, and `keryx review budget` refuses BEFORE the spend.
  const concurrency = concurrencyPlan(input, coverage);
  const caps: ReviewCapsRecord = {
    findings: { counts: findingsCap.counts, drops: findingsCap.drops },
    ...(input.spend === undefined && input.spendCeiling === undefined
      ? {}
      : { spend: evaluateSpendCap(input.spend, { ceiling: input.spendCeiling }) }),
    ...(concurrency === undefined ? {} : { concurrency }),
  };

  await mkdir(packageDir, { recursive: true });
  await writeFileAtomic(path.join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileAtomic(
    path.join(packageDir, "scope.md"),
    renderScope(input, flowMatch, at, verification, carried, caps, externalReclaims),
  );
  await writeFileAtomic(path.join(packageDir, "coverage.md"), renderCoverage(coverage));
  await writeFileAtomic(path.join(packageDir, "report.md"), renderReport(report, input.mode));
  await writeFileAtomic(
    path.join(packageDir, "findings.json"),
    `${JSON.stringify(findings.map(toContractFinding), null, 2)}\n`,
  );
  await writeFileAtomic(path.join(packageDir, "learning.md"), renderLearning(findings));
  await writeFileAtomic(path.join(packageDir, "decisions.md"), renderDecisions(findings));

  return {
    reviewId,
    path: path.relative(input.cwd, packageDir),
    manifest,
    verification: verification.counts,
    verificationRejections: verification.rejections,
    verificationCaps: verification.caps,
    caps,
  };
}

/**
 * The dispatch plan the caps record carries, or `undefined` when the caller
 * supplied no concurrency input at all.
 *
 * `undefined` is deliberately distinct from "a plan with one wave". A package
 * whose caller said nothing about dispatch renders `not recorded`; a package
 * whose caller planned four reviewers into one wave renders `queued: 0`. Only
 * the second is a statement that nothing was deferred.
 *
 * The reviewer list defaults to the coverage entries that actually ran, because
 * that is the set `review-orchestrator` dispatched and the set whose waves the
 * record is about.
 */
function concurrencyPlan(input: ManagedReviewInput, coverage: ReviewCoverageEntry[]): ConcurrencyPlan | undefined {
  const requested = input.concurrency;
  if (requested === undefined) {
    return undefined;
  }
  const reviewers =
    requested.reviewers ?? coverage.filter((entry) => entry.status === "run").map((entry) => entry.reviewer);
  return planReviewerWaves(reviewers, {
    cap: requested.cap,
    outstanding: requested.outstanding,
  });
}

/**
 * The findings a `refuted` verdict removed from the reported set, on their way to
 * `findings.json`.
 *
 * This is the ONE place `verification` and `disposition` meet, and the direction
 * is one-way. They answer different questions: `verification` is an OBSERVATION
 * about whether the finding is real, made during the round by someone other than
 * its author; `disposition` is a DECISION about what the project did, recorded
 * when the round closes. `refuted` and `dismissed-incorrect` are therefore not
 * synonyms — a refutation can itself be wrong (the command did not exercise the
 * path), and a `dismissed-incorrect` can be reached with no verification at all,
 * which is what the `refuted` input channel already does.
 *
 * The composition rule, stated so neither field silently becomes the other:
 *
 * - `annotate` writes NO disposition. That is the whole content of the mode:
 *   the verdict is measured for a release without acting on it.
 * - `filter` writes `dismissed-incorrect` for an applied `refuted` verdict ONLY,
 *   carrying the verification evidence forward so the decision is traceable to
 *   the command that produced it.
 * - A `confirmed` verdict is never a disposition. Verification says the finding
 *   is real; it says nothing about whether anyone fixed it.
 * - Nothing reads in the other direction: a disposition never implies a
 *   verification.
 */
function fromVerifierRefutations(findings: readonly NormalizedReviewFinding[]): NormalizedReviewFinding[] {
  return findings.map((finding) => ({
    ...finding,
    classification: "false_positive" as FindingClassification,
    disposition: {
      state: "dismissed-incorrect" as FindingDispositionState,
      evidence: `refuted by ${finding.verification?.verifier ?? "the verifier"} (${
        finding.verification?.method ?? "unknown method"
      }): ${finding.verification?.evidence ?? "no evidence recorded"}`,
    },
  }));
}

export async function getManagedReviewStatus(cwd: string, ref: string): Promise<ManagedReviewManifest> {
  const manifestPath = ref.endsWith("manifest.json")
    ? path.resolve(cwd, ref)
    : path.join(await resolveReviewPackagePath(cwd, ref), "manifest.json");
  return JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
}

/**
 * One recorded outcome, naming the finding it is about.
 *
 * `finding` accepts either the `global_id` or the display `id`. The display form
 * is what a human writing a fix-round note has in front of them; it is resolved
 * against this package alone, and an ambiguous one is refused rather than
 * guessed — which is the whole reason `global_id` exists.
 */
export type FindingDispositionRecord = {
  finding: string;
  state: FindingDispositionState;
  evidence?: string | undefined;
};

export type CompleteManagedReviewOptions = {
  dispositions?: readonly FindingDispositionRecord[] | undefined;
};

/**
 * Close a review package, and record what became of its findings.
 *
 * This is where the disposition is written because this is the ONE place the
 * pipeline already says a round is finished with something; inventing a second
 * writer would mean a round could close without ever passing through it, which
 * is how the outcome went unrecorded for 83 findings in the first place.
 *
 * The findings are re-read from disk and only the named ones are touched, so a
 * package written before the finding contract existed can still be annotated. Its
 * records are NOT re-validated as a whole — the ingest gate is where a finding's
 * shape is decided, and re-running it at close time would make the entire
 * pre-contract corpus impossible to disposition, which is the opposite of the
 * point. The disposition itself IS validated, against the subschema in
 * `review-finding.schema.json`, so there is one definition of a valid one.
 */
export async function completeManagedReview(
  cwd: string,
  ref: string,
  options: CompleteManagedReviewOptions = {},
): Promise<ManagedReviewManifest> {
  const packageDir = await resolveReviewPackagePath(cwd, ref);
  const manifestPath = path.join(packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  const missing = await missingArtifacts(packageDir);
  if (missing.length > 0) {
    throw new Error(`Cannot complete managed review; missing artifacts: ${missing.join(", ")}`);
  }
  const dispositions = options.dispositions ?? [];
  if (dispositions.length > 0) {
    await recordDispositions(packageDir, dispositions);
  }
  const updated: ManagedReviewManifest = {
    ...manifest,
    status: "closed",
    updatedAt: new Date().toISOString(),
  };
  const validation = await validateManagedReviewManifest(cwd, updated);
  if (!validation.valid) {
    throw new Error(`Invalid managed review manifest: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  }
  await writeFileAtomic(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

export async function validateManagedReviewManifest(
  cwd: string,
  manifest: ManagedReviewManifest,
): Promise<ManagedReviewValidationResult> {
  const errors: ManagedReviewValidationResult["errors"] = [];

  // The committed JSON Schema is the source of truth. When it is present we run
  // the deterministic in-repo validator (src/contracts/validator) against it so
  // the schema file — not the hand-rolled checks below — governs the required
  // fields, enums, and additionalProperties rules. The hand-rolled checks are
  // kept as a floor: they still run so behavior does not regress if the schema
  // file is absent, and they catch cases the schema does not model (e.g. empty
  // artifact paths). Errors from both layers are merged and de-duplicated.
  const schema = await loadDocpackSchema(cwd);
  if (schema) {
    for (const error of validateAgainstSchemaObject(schema, manifest).errors) {
      errors.push(error);
    }
  }

  if (manifest.schemaVersion !== 1) {
    errors.push({ path: "$.schemaVersion", message: "Expected 1" });
  }
  if (!manifest.reviewId) {
    errors.push({ path: "$.reviewId", message: "Missing review id" });
  }
  if (!MANAGED_REVIEW_MODES.includes(manifest.mode)) {
    errors.push({ path: "$.mode", message: `Expected one of ${MANAGED_REVIEW_MODES.join(", ")}` });
  }
  if (!REVIEW_PACKAGE_STATUSES.includes(manifest.status)) {
    errors.push({ path: "$.status", message: `Expected one of ${REVIEW_PACKAGE_STATUSES.join(", ")}` });
  }
  if (!REVIEW_TARGET_KINDS.includes(manifest.target.kind)) {
    errors.push({ path: "$.target.kind", message: `Expected one of ${REVIEW_TARGET_KINDS.join(", ")}` });
  }
  if (!manifest.target.ref) {
    errors.push({ path: "$.target.ref", message: "Missing target ref" });
  }
  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!manifest.artifacts[artifact]) {
      errors.push({ path: `$.artifacts.${artifact}`, message: "Missing artifact path" });
    }
  }
  for (const [index, entry] of manifest.coverage.entries()) {
    if (!entry.reviewer) {
      errors.push({ path: `$.coverage[${index}].reviewer`, message: "Missing reviewer" });
    }
    if (!REVIEW_COVERAGE_STATUSES.includes(entry.status)) {
      errors.push({ path: `$.coverage[${index}].status`, message: `Expected one of ${REVIEW_COVERAGE_STATUSES.join(", ")}` });
    }
    if (entry.reason === undefined) {
      errors.push({ path: `$.coverage[${index}].reason`, message: "Missing reason" });
    }
  }

  const seen = new Set<string>();
  const deduped = errors.filter((error) => {
    const key = `${error.path}${error.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return { valid: deduped.length === 0, errors: deduped };
}

async function resolvePackageFlow(input: ManagedReviewInput): Promise<FlowMatchResult | null> {
  if (input.mode === "review-flow") {
    return null;
  }
  return findRelatedFlow({ cwd: input.cwd, flowId: input.flowId, target: input.target });
}

function packagePath(
  cwd: string,
  mode: ManagedReviewMode,
  reviewId: string,
  flowMatch: FlowMatchResult | null,
): string {
  if ((mode === "attach-review" || mode === "ingest") && flowMatch) {
    return path.join(flowsRoot(cwd), flowMatch.dir, "reviews", reviewId);
  }
  if (mode === "attach-review") {
    throw new Error("attach-review requires an explicit or matched flow");
  }
  return path.join(reviewsRoot(cwd), reviewId);
}

function buildManifest(args: {
  input: ManagedReviewInput;
  /** {@link ManagedReviewInput.target} with the resolved `head` folded in. */
  target: ManagedReviewTarget;
  reviewId: string;
  packageDir: string;
  flowMatch: FlowMatchResult | null;
  coverage: ReviewCoverageEntry[];
  at: string;
}): ManagedReviewManifest {
  const artifactPath = (name: string) => path.relative(args.input.cwd, path.join(args.packageDir, name));
  const manifest: ManagedReviewManifest = {
    schemaVersion: 1,
    reviewId: args.reviewId,
    mode: args.input.mode,
    status: "draft",
    target: args.target,
    artifacts: {
      scope: artifactPath("scope.md"),
      coverage: artifactPath("coverage.md"),
      report: artifactPath("report.md"),
      findings: artifactPath("findings.json"),
      learning: artifactPath("learning.md"),
      decisions: artifactPath("decisions.md"),
    },
    coverage: args.coverage,
    createdAt: args.at,
    updatedAt: args.at,
  };
  if (args.flowMatch) {
    manifest.flow = {
      id: args.flowMatch.id,
      path: `.metaproject/flows/${args.flowMatch.dir}`,
    };
  }
  return manifest;
}

function normalizeCoverage(
  coverage: ReviewCoverageEntry[] | undefined,
  reviewers: string[] | undefined,
): ReviewCoverageEntry[] {
  if (coverage && coverage.length > 0) {
    return coverage;
  }
  const selected = reviewers && reviewers.length > 0 ? reviewers : ["review-orchestrator"];
  return selected.map((reviewer) => ({
    reviewer,
    status: "run",
    reason: "selected for managed review package",
  }));
}

async function readReport(input: ManagedReviewInput): Promise<string> {
  if (input.reportText !== undefined) {
    return input.reportText;
  }
  if (input.reportPath) {
    return readFile(path.resolve(input.cwd, input.reportPath), "utf8");
  }
  if (input.mode === "ingest") {
    throw new Error("ingest requires --report or reportText");
  }
  return `# Managed Review Report\n\nNo reviewer findings recorded yet.\n`;
}

/** How to name the report in an error, so a refusal says which file to open. */
function reportLabel(input: ManagedReviewInput): string {
  return input.reportPath
    ? path.resolve(input.cwd, input.reportPath)
    : "the report text passed to keryx review";
}

type NormalizeFindingsArgs = {
  report: string;
  reportLabel: string;
  mode: ManagedReviewMode;
  attachedToFlow: boolean;
  source: ReviewFindingsSource | undefined;
  reviewers: string[];
};

/**
 * The findings of one review round, in order of decreasing fidelity.
 *
 * 1. `input.findings` — what the caller still holds.
 * 2. A `keryx:findings` block inside the report — the same array, travelling in
 *    the one artifact the CLI already moves.
 * 3. The markdown parser — legacy only.
 *
 * The ordering is the whole design and is worth stating rather than inferring.
 * A reviewer produces `reviewer-finding.schema.json`: id, severity, problem,
 * impact, suggested_fix, evidence, confidence, reviewer, class_scope. The
 * orchestrator then renders that to prose, and prose is where four of those
 * fields stop existing — not "become hard to parse", stop existing: read the
 * consolidated report in `fixtures/`, which carries no confidence anywhere and
 * no evidence field under any label. Re-parsing therefore cannot be made
 * lossless by a better regex, which is why the structured array is taken from
 * the producer and the parser is demoted to reading what is already on disk.
 */
async function normalizeFindings(args: NormalizeFindingsArgs): Promise<NormalizedReviewFinding[]> {
  if (args.source !== undefined) {
    return triage(fromStructuredSource(args.source, args.reviewers), args);
  }
  // PRESENCE, not the parsed value. Branching on the value cannot tell "no
  // block" from "a block holding null", and both then fell through to the prose
  // parser without a word — the silent degradation the fenced block exists to
  // prevent. `parseEmbeddedFindings` returns null only when no fence is there.
  const structured = parseEmbeddedFindings(args.report, args.reportLabel);
  if (structured !== null) {
    return triage(fromStructuredSource(structured, args.reviewers), args);
  }
  return triage(parseLegacyReport(args.report, args.reviewers), args);
}

function triage(
  findings: Array<StructuredReviewFinding & { summary: string; class_scope_present?: boolean | undefined }>,
  args: NormalizeFindingsArgs,
): NormalizedReviewFinding[] {
  const classification = args.mode === "ingest" ? "valid_followup" : "skill_learning_candidate";
  return findings.map((finding) => {
    const triaged: NormalizedReviewFinding = {
      ...finding,
      classification,
      flow_relevance: args.attachedToFlow ? "post_flow_feedback" : "standalone_review",
    };
    // `learning_candidate` is the one triage judgement the finding contract has
    // a slot for, so it is the one that survives into `findings.json`. Set only
    // when true: the schema defaults it to false, and writing the default onto
    // every finding says nothing while implying a decision was recorded.
    if (finding.learning_candidate === undefined && classification === "skill_learning_candidate") {
      triaged.learning_candidate = true;
    }
    return triaged;
  });
}

/** The persisted record: exactly the properties `review-finding.schema.json` allows. */
function toContractFinding(finding: StructuredReviewFinding): StructuredReviewFinding {
  const record: StructuredReviewFinding = {
    id: finding.id,
    reviewer: finding.reviewer,
    severity: finding.severity,
    problem: finding.problem,
    impact: finding.impact,
    suggested_fix: finding.suggested_fix,
    evidence: finding.evidence,
    confidence: finding.confidence,
  };
  if (finding.file !== undefined) {
    record.file = finding.file;
  }
  if (finding.line !== undefined) {
    record.line = finding.line;
  }
  if (finding.symbol !== undefined) {
    record.symbol = finding.symbol;
  }
  if (finding.dedupe_key !== undefined) {
    record.dedupe_key = finding.dedupe_key;
  }
  if (finding.blocking_merge !== undefined) {
    record.blocking_merge = finding.blocking_merge;
  }
  if (finding.related_skill !== undefined) {
    record.related_skill = finding.related_skill;
  }
  if (finding.learning_candidate !== undefined) {
    record.learning_candidate = finding.learning_candidate;
  }
  if (finding.class_scope !== undefined) {
    record.class_scope = finding.class_scope;
  }
  // Written only when present, on both. `global_id` is absent on nothing the
  // current pipeline writes but stays optional so a legacy record read back and
  // rewritten does not acquire an invented key; `disposition` is absent unless
  // an outcome was actually recorded, because writing `{state: "unknown"}` onto
  // every finding says nothing while implying somebody decided — the exact
  // failure `classification: valid_followup` on 82 of 83 records already is.
  if (finding.global_id !== undefined) {
    record.global_id = finding.global_id;
  }
  if (finding.disposition !== undefined) {
    record.disposition = finding.disposition;
  }
  // Same rule, same reason: written only when an independent check actually
  // happened. A finding with no `verification` is one nobody checked, which is
  // every one of the 83 records on disk — and is NOT the same as "unverified and
  // therefore droppable".
  if (finding.verification !== undefined) {
    record.verification = finding.verification;
  }
  // Same rule again, and this one is not cosmetic: `source` is what makes the
  // verifier unable to refute a comment (AC10), keeps the findings cap off it
  // (AC9), and keeps the completion gate closed while it is unanswered (AC5). A
  // projection that dropped it would leave a finding that looks internal and
  // silently acquires all three of the behaviours those criteria forbid.
  if (finding.source !== undefined) {
    record.source = finding.source;
  }
  if (finding.external_ref !== undefined) {
    record.external_ref = finding.external_ref;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Identity and disposition
// ---------------------------------------------------------------------------

/**
 * What became of a finding, with an absent disposition read as `unknown`.
 *
 * The reading rule, in one place, because 83 findings on disk have no
 * disposition property and every consumer must agree on what that means. It
 * means nobody recorded an outcome. It does NOT mean the finding was fine.
 */
export function findingDispositionState(finding: {
  disposition?: ReviewFindingDisposition | undefined;
}): FindingDispositionState {
  return finding.disposition?.state ?? "unknown";
}

/** The key a finding is joined by: `<reviewId>#<id>`. */
export function mintGlobalFindingId(reviewId: string, id: string): string {
  return `${reviewId}#${id}`;
}

/**
 * Give every finding a key, without overwriting one it already carries.
 *
 * The non-overwrite half is what makes the key STABLE. A finding re-reported in
 * round N+1 arrives through `prior_findings[].finding` carrying the key round N
 * minted; re-minting it under round N+1's `reviewId` would give the same finding
 * two keys and break the only join this field exists to provide.
 */
function assignGlobalIds(findings: NormalizedReviewFinding[], reviewId: string): void {
  for (const finding of findings) {
    if (typeof finding.global_id !== "string" || finding.global_id === "") {
      finding.global_id = mintGlobalFindingId(reviewId, finding.id);
    }
  }
}

/** Keys claimed by more than one finding in this package, described. */
function findingKeyCollisions(findings: readonly NormalizedReviewFinding[]): string[] {
  const byKey = new Map<string, NormalizedReviewFinding[]>();
  for (const finding of findings) {
    const key = finding.global_id ?? finding.id;
    byKey.set(key, [...(byKey.get(key) ?? []), finding]);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => `${key} claimed by ${group.length} findings`);
}

/** Findings carrying a disposition that asserts an outcome and cites nothing. */
function unevidencedDispositions(findings: readonly NormalizedReviewFinding[]): string[] {
  return findings
    .filter((finding) => {
      const disposition = finding.disposition;
      return (
        disposition !== undefined &&
        disposition.state !== "unknown" &&
        (typeof disposition.evidence !== "string" || disposition.evidence.trim() === "")
      );
    })
    .map((finding) => `${finding.global_id ?? finding.id} (${finding.disposition?.state})`);
}

/**
 * The findings a round raised and then dismissed, in the shape that reaches disk.
 *
 * Stamped rather than trusted: a payload arriving on this channel is a statement
 * that the round did NOT act on these, so `acted-on` and `unknown` are refused
 * outright instead of being silently rewritten. `dismissed-incorrect` is the
 * default because "refuted" is what the channel is for; the other dismissals are
 * allowed because `dismissed-out-of-scope = 0` in the recorded corpus means "not
 * written down" rather than "did not happen", and giving out-of-scope nowhere to
 * go is how it got there.
 */
function fromRefutedSource(
  source: ReviewFindingsSource | undefined,
  reviewers: string[],
  attachedToFlow: boolean,
): NormalizedReviewFinding[] {
  if (source === undefined) {
    return [];
  }
  return fromStructuredSource(source, reviewers).map((finding) => {
    const declared = finding.disposition?.state;
    if (declared !== undefined && !FINDING_DISMISSAL_STATES.includes(declared)) {
      throw new Error(
        `Refusing to record ${finding.id} as refuted with disposition "${declared}": findings passed as refuted were raised and NOT acted on. Use one of ${FINDING_DISMISSAL_STATES.join(
          ", ",
        )}, or report it as a finding instead.`,
      );
    }
    const state: FindingDispositionState = declared ?? "dismissed-incorrect";
    const evidence = finding.disposition?.evidence;
    const disposition: ReviewFindingDisposition =
      typeof evidence === "string" ? { state, evidence } : { state };
    return {
      ...finding,
      // The legacy mode-derived triage, made to agree with the disposition
      // rather than left saying `valid_followup` about a finding this round
      // just judged wrong. `disposition` is the field that means something;
      // `classification` is kept consistent so `decisions.md` does not contradict
      // `findings.json`.
      classification: refutedClassification(state),
      flow_relevance: attachedToFlow ? "post_flow_feedback" : "standalone_review",
      disposition,
    };
  });
}

function refutedClassification(state: FindingDispositionState): FindingClassification {
  return state === "dismissed-incorrect" ? "false_positive" : "out_of_scope";
}

/** Write the recorded outcomes into `findings.json`, or refuse and write nothing. */
async function recordDispositions(
  packageDir: string,
  records: readonly FindingDispositionRecord[],
): Promise<void> {
  const findingsPath = path.join(packageDir, "findings.json");
  const findings = JSON.parse(await readFile(findingsPath, "utf8")) as StructuredReviewFinding[];
  const schema = await loadSchema("review-finding");
  const dispositionSchema = schema.properties?.["disposition"];
  if (!dispositionSchema) {
    throw new Error(
      "review-finding.schema.json declares no `disposition` property; refusing to write one the contract does not describe.",
    );
  }

  // Validated and resolved in full BEFORE anything is assigned, so a batch that
  // is wrong anywhere leaves findings.json exactly as it was.
  const pending: Array<{ finding: StructuredReviewFinding; disposition: ReviewFindingDisposition }> = [];
  for (const record of records) {
    const matches = findings.filter(
      (finding) => finding.global_id === record.finding || finding.id === record.finding,
    );
    if (matches.length === 0) {
      throw new Error(
        `Cannot record a disposition for "${record.finding}": this package holds no such finding. It holds ${
          findings.length === 0
            ? "no findings at all"
            : findings.map((finding) => finding.global_id ?? finding.id).join(", ")
        }.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `"${record.finding}" names ${matches.length} findings in this package. Use the global_id: ${matches
          .map((finding) => finding.global_id ?? finding.id)
          .join(", ")}.`,
      );
    }
    const finding = matches[0] as StructuredReviewFinding;
    const disposition: ReviewFindingDisposition =
      record.evidence === undefined ? { state: record.state } : { state: record.state, evidence: record.evidence };
    const errors = await validateJson(disposition, dispositionSchema);
    if (errors.length > 0) {
      throw new Error(
        `Refusing to record a disposition for ${finding.global_id ?? finding.id}: ${errors
          .map((error) => `${error.path.replace(/^\$/, "disposition")} ${error.message}`)
          .join("; ")}. A disposition that is not \`unknown\` must cite where the outcome is written down.`,
      );
    }
    const existing = finding.disposition;
    if (existing !== undefined && existing.state !== "unknown") {
      if (existing.state !== disposition.state) {
        throw new Error(
          `${finding.global_id ?? finding.id} is already recorded as "${existing.state}" (${
            existing.evidence ?? "no evidence"
          }); refusing to overwrite it with "${disposition.state}". Reversing a recorded verdict silently is the same erasure this field exists to stop — record the reversal as a new round.`,
        );
      }
      // The state and the citation are one record, so guarding one and not the
      // other leaves half of it silently replaceable: re-recording `acted-on`
      // with a different commit swapped the evidence and the original citation
      // was gone without trace. The evidence is the whole reason a disposition
      // is more than an assertion, and a corpus of assertions is what measured
      // 100% precision while recording zero wrong findings. Re-recording the
      // IDENTICAL disposition stays a no-op, so a retried `review complete` is
      // safe.
      if ((existing.evidence ?? "") !== (disposition.evidence ?? "")) {
        throw new Error(
          `${finding.global_id ?? finding.id} is already recorded as "${existing.state}" and already cites "${
            existing.evidence ?? "no evidence"
          }"; refusing to replace that citation with "${
            disposition.evidence ?? "no evidence"
          }". The state and its evidence are one record — record the correction as a new round rather than overwriting where the outcome is written down.`,
        );
      }
    }
    pending.push({ finding, disposition });
  }

  for (const { finding, disposition } of pending) {
    finding.disposition = disposition;
  }
  await writeFileAtomic(findingsPath, `${JSON.stringify(findings, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Structured source
// ---------------------------------------------------------------------------

/**
 * The `keryx:findings` block: the structured array carried inside the report.
 *
 * The report is the artifact the pipeline already moves — `keryx review ingest
 * --report <path>` takes one file and nothing else — so a fenced block inside it
 * needs no new flag, no new convention for where a sidecar lives, and no way for
 * the two halves to be separated in transit. A legacy report simply has no such
 * block, which is what makes the fallback automatic rather than a mode switch
 * someone has to remember to set.
 *
 * The OPENING FENCE is what is matched, and presence is decided by it alone.
 * Up to three leading spaces are allowed because CommonMark allows a fence to be
 * indented that far; the previous column-0 anchor made an indented block — the
 * ordinary result of nesting one under a list item — invisible, and an invisible
 * block is a silent fall-through to the prose parser rather than an error.
 */
const EMBEDDED_FINDINGS_FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\bkeryx:findings\b[^\n]*$/gm;

/**
 * The one `keryx:findings` block in a report, or null when there is none.
 *
 * Every other outcome throws. A block that is present but does not yield a
 * findings payload is a producer bug, and the one thing that must never happen
 * is what used to: falling back to the prose parser while the report visibly
 * carries the structured array its author expected to be read.
 */
function parseEmbeddedFindings(report: string, reportLabel: string): ReviewFindingsSource | null {
  const fences = [...report.matchAll(EMBEDDED_FINDINGS_FENCE)];
  if (fences.length === 0) {
    return null;
  }
  if (fences.length > 1) {
    // An orchestrator that concatenates one block per reviewer produces exactly
    // this, and the non-global match silently kept the first and dropped the
    // rest — a report visibly holding findings ingested as zero.
    throw new Error(
      `${reportLabel} carries ${fences.length} keryx:findings blocks (at character ${fences
        .map((fence) => String(fence.index ?? 0))
        .join(" and ")}); exactly one is allowed. Concatenating one block per reviewer drops every block after the first — merge them into a single array.`,
    );
  }
  const fence = fences[0] as RegExpExecArray;
  let parsed: unknown;
  try {
    parsed = JSON.parse(embeddedBlockBody(report, fence)) as unknown;
  } catch (error) {
    throw new Error(
      `${reportLabel} carries a keryx:findings block that is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed) && !isReviewerResult(parsed)) {
    // Named for what it is. Passing a non-array through produced a schema
    // failure about missing `id`/`impact`/`evidence`, which sends the reader
    // looking for fields in a block that was never a finding.
    throw new Error(
      `${reportLabel} carries a keryx:findings block that is ${describeJson(
        parsed,
      )}, not an array of findings or a { reviewer, findings } result.`,
    );
  }
  return parsed as ReviewFindingsSource;
}

/** The text between an opening fence and its closing fence of the same marker. */
function embeddedBlockBody(report: string, fence: RegExpExecArray): string {
  const marker = fence[1] ?? "```";
  const char = marker.startsWith("~") ? "~" : "`";
  const afterOpen = report.slice((fence.index ?? 0) + fence[0].length).replace(/^\r?\n/, "");
  const closing = afterOpen.match(new RegExp(`^ {0,3}\\${char}{${marker.length},}\\s*$`, "m"));
  return closing?.index === undefined ? afterOpen : afterOpen.slice(0, closing.index);
}

function describeJson(value: unknown): string {
  if (value === null) {
    return "JSON null";
  }
  return `a JSON ${typeof value}`;
}

/**
 * Flatten whatever the producer handed over into one array of findings.
 *
 * Both the normalized array and the reviewer's own `{ reviewer, findings }`
 * result are accepted, because an orchestrator holding five reviewer payloads
 * should be able to pass the five rather than merge them by hand — and because
 * the wrapper is where the ORIGINATING reviewer is recorded. That name was
 * hardcoded to `review-orchestrator` for every finding this pipeline ever wrote,
 * which made every record claim the consolidator found it.
 */
function fromStructuredSource(
  source: ReviewFindingsSource,
  reviewers: string[],
): Array<StructuredReviewFinding & { summary: string; class_scope_present?: boolean }> {
  const flattened: Array<Partial<StructuredReviewFinding>> = [];
  for (const entry of Array.isArray(source) ? source : [source]) {
    if (isReviewerResult(entry)) {
      for (const finding of entry.findings) {
        if (finding.reviewer || entry.reviewer === undefined) {
          flattened.push(finding);
          continue;
        }
        flattened.push({ ...finding, reviewer: entry.reviewer });
      }
      continue;
    }
    flattened.push(entry as Partial<StructuredReviewFinding>);
  }

  // Nothing is filled in and nothing is validated here: the shared contract gate
  // in `createManagedReviewPackage` fails closed on whatever this returns, and
  // fails closed the same way for the legacy parser. A structured payload is a
  // claim that the fields exist, so an incomplete one is a producer bug — not
  // something to paper over with the placeholders the legacy path uses.
  return flattened.map((finding) => coerceStructured(finding, reviewers));
}

function isReviewerResult(value: unknown): value is ReviewerResultLike {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { findings?: unknown }).findings)
  );
}

async function schemaErrors(
  findings: readonly StructuredReviewFinding[],
): Promise<Array<{ path: string; message: string }>> {
  const schema = await loadSchema("review-finding");
  const errors: Array<{ path: string; message: string }> = [];
  for (const [index, finding] of findings.entries()) {
    // The PROJECTION is what gets written and what a later round reads, so it is
    // what the contract has to accept. Validating the in-memory object instead
    // would fail on the triage fields this function's whole purpose is to keep
    // out of the record.
    for (const error of await validateJson(toContractFinding(finding), schema)) {
      errors.push({ path: error.path.replace(/^\$/, `$[${index}]`), message: error.message });
    }
  }
  return errors;
}

/**
 * Carry a structured finding across, filling in NOTHING that the contract
 * requires.
 *
 * The one supplied value is `reviewer`, and only because the reviewer's own
 * result records it on the wrapper rather than on each finding. Everything else
 * is passed through as given, so an absent `impact` stays absent and
 * {@link schemaErrors} refuses the payload. Defaulting a required field here
 * would produce a record that validates and says nothing — which is how
 * `findings.json` came to be full of `review-orchestrator`.
 */
function coerceStructured(
  finding: Partial<StructuredReviewFinding>,
  reviewers: string[],
): StructuredReviewFinding & { summary: string; class_scope_present?: boolean } {
  const record = { ...finding } as StructuredReviewFinding & {
    summary: string;
    class_scope_present?: boolean;
  };
  if (typeof record.reviewer !== "string" || record.reviewer === "") {
    record.reviewer = defaultReviewer(reviewers);
  }
  record.summary = typeof finding.problem === "string" ? finding.problem : "";
  record.class_scope_present = finding.class_scope !== undefined;
  return record;
}

/**
 * Which reviewer a finding belongs to when the producer did not say.
 *
 * A single running reviewer is an unambiguous answer. Several is not, and
 * naming one of them would be a fabrication of exactly the kind the hardcoded
 * `review-orchestrator` was — so the consolidator is named, honestly, as the
 * only thing known to have handled it.
 */
function defaultReviewer(reviewers: string[]): string {
  return reviewers.length === 1 && reviewers[0] ? reviewers[0] : "review-orchestrator";
}

// ---------------------------------------------------------------------------
// Legacy markdown source
// ---------------------------------------------------------------------------

/**
 * Read a pre-existing markdown review report.
 *
 * Kept, not deleted: every review package already on disk is a markdown report,
 * and a pipeline that can only read what it wrote after today strands them all.
 *
 * What it produces is written in the structured shape, so a legacy round is
 * still round-trippable — but the four fields markdown does not carry are filled
 * with a stated provenance rather than an invention. A reader of
 * `findings.json` can tell a recorded `impact` from an absent one, which is the
 * property that matters: `confidence` in particular is `low` on this path
 * because a regex over prose is a low-confidence derivation, whatever the
 * reviewer's own confidence was.
 */
function parseLegacyReport(
  report: string,
  reviewers: string[],
): Array<StructuredReviewFinding & { summary: string; class_scope_present: boolean }> {
  const findings: Array<StructuredReviewFinding & { summary: string; class_scope_present: boolean }> = [];
  const lines = report.split("\n");
  for (const [index, line] of lines.entries()) {
    const heading = findingHeading(line);
    if (heading === null) {
      continue;
    }
    const id = heading.id;
    const summary = heading.summary || "Review finding";
    // The block is everything up to the next finding, because severity and
    // class_scope live on lines BELOW the heading in every report format the
    // reviewer skills emit. Reading only the heading line, as this did, made
    // severity depend on whether the word happened to appear in the title.
    const block = findingBlock(lines, index);
    const location = parseLocation(labelledField(block, ["file", "location"]));
    const classScope = parseClassScope(block);
    const finding: StructuredReviewFinding & { summary: string; class_scope_present: boolean } = {
      id,
      severity: severityFor(line, block),
      reviewer: legacyReviewer(block, reviewers),
      // `- [F-001] major: the summary` puts the severity in the title, so the
      // heading text is not the problem statement until that prefix comes off.
      problem: labelledField(block, ["problem", "issue"]) ?? summary.replace(SEVERITY_PREFIX, ""),
      impact: labelledField(block, ["impact", "why it matters"]) ?? NOT_RECORDED("impact"),
      suggested_fix:
        labelledField(block, ["suggested fix", "suggested_fix", "fix", "recommendation"]) ??
        NOT_RECORDED("suggested_fix"),
      // Attribution is not evidence. `Found independently by` also feeds
      // `legacyReviewer`, so reading it here made `evidence` a copy of the
      // reviewer list — a value that LOOKS recorded, which is precisely the
      // property this path exists to preserve: a reader can tell a recovered
      // field from one the report never carried.
      evidence: labelledField(block, ["evidence", "proof"]) ?? NOT_RECORDED("evidence"),
      confidence: legacyConfidence(block),
      summary,
      // The extracted value, not a separate shape check over the prose. When
      // these were two different tests they could disagree, and on a `major`
      // that disagreement wrote a record `review-finding.schema.json` rejects.
      class_scope_present: classScope !== null,
    };
    if (classScope !== null) {
      finding.class_scope = classScope;
    }
    if (location.file !== undefined) {
      finding.file = location.file;
    }
    if (location.line !== undefined) {
      finding.line = location.line;
    }
    findings.push(finding);
  }
  return findings;
}

const SEVERITY_PREFIX = /^\s*(?:\*\*|__)?(?:blocker|major|minor|info)(?:\*\*|__)?\s*[:—–-]\s*/i;

const NOT_RECORDED = (field: string): string =>
  `not recorded: derived from a markdown review report, which carried no ${field} field`;

/** `- **Label**: value`, continued onto following lines until a blank or a new label. */
function labelledField(block: string, labels: readonly string[]): string | undefined {
  const lines = block.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(LABEL_LINE);
    const label = match?.[1]?.trim().toLowerCase().replace(/\*\*|__|`/g, "");
    if (label === undefined || !labels.includes(label)) {
      continue;
    }
    const parts = [(match?.[2] ?? "").trim()];
    for (let i = index + 1; i < lines.length; i += 1) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || /^\s*[-*+]\s/.test(next) || /^\s*(?:\*\*|__)/.test(next)) {
        break;
      }
      parts.push(next.trim());
    }
    const value = parts.join(" ").trim().replace(/^[`*_]+|[`*_]+$/g, "").trim();
    if (value !== "") {
      return value;
    }
  }
  return undefined;
}

/** The label half and the value half of a `- **Label**: value` line. */
const LABEL_LINE = /^[\s>]*(?:[-*+]\s+)?((?:\*\*|__)?[A-Za-z][A-Za-z _-]*(?:\*\*|__)?)\s*[:=]\s*(.*)$/;

/** `src/lib/serve-server.ts:739` — with or without backticks, with or without a line. */
function parseLocation(value: string | undefined): { file?: string; line?: number } {
  if (value === undefined) {
    return {};
  }
  const match = value.replace(/`/g, "").trim().match(/^([^\s:]+?\.[A-Za-z0-9]+)(?::(\d+))?\b/);
  if (!match?.[1]) {
    return {};
  }
  const line = match[2] === undefined ? undefined : Number(match[2]);
  return line === undefined || Number.isNaN(line) ? { file: match[1] } : { file: match[1], line };
}

/**
 * The originating reviewer, read out of the report rather than assumed.
 *
 * Consolidated reports name it — `**Found independently by**: review-logic
 * (blocker), review-architecture (major)` — and the first name in that list is
 * the one that found it. When the report says nothing, {@link defaultReviewer}
 * answers, which is the same honest fallback the structured path uses.
 */
function legacyReviewer(block: string, reviewers: string[]): string {
  const attribution = labelledField(block, ["reviewer", "found by", "found independently by", "reviewers"]);
  const named = attribution?.match(/\breview-[a-z0-9-]+\b/i);
  if (named?.[0]) {
    return named[0].toLowerCase();
  }
  return defaultReviewer(reviewers);
}

function legacyConfidence(block: string): ReviewFindingConfidence {
  const declared = labelledField(block, ["confidence"])?.toLowerCase();
  if (declared !== undefined) {
    for (const value of REVIEW_FINDING_CONFIDENCES) {
      if (declared.startsWith(value)) {
        return value;
      }
    }
  }
  // Not "medium". A field recovered by keyword-scanning prose is a low-confidence
  // derivation whatever the reviewer believed, and saying otherwise would let a
  // fix round treat a guess as the reviewer's own judgement.
  return "low";
}

/**
 * `sites` and `enumeration_method`, pulled out of a markdown class_scope block.
 *
 * This IS the guard. It used to be best effort behind a separate shape check
 * over the prose, and the two could disagree: a block naming `class_scope`,
 * `sites` and `enumeration_method` in sentences satisfied the shape check while
 * extraction returned null, so a `major` was accepted and persisted without the
 * property `review-finding.schema.json` requires — and the round-2 input built
 * from that record was rejected by the same schema. The guard now keys off the
 * value that is written, so the two cannot disagree.
 */
function parseClassScope(block: string): ReviewFindingClassScope | null {
  const lines = block.split("\n");
  const start = lines.findIndex((line) => /class[_ ]scope/i.test(line));
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start).join("\n");
  const sitesMatch = rest.match(/\bsites\b\s*[:=]\s*([\s\S]*?)(?=\benumeration_method\b|$)/i);
  const methodMatch = rest.match(/\benumeration_method\b\s*[:=]\s*([\s\S]*?)(?=\n\s*\n|$)/i);
  const sites = sitesMatch?.[1] === undefined ? [] : parseSites(sitesMatch[1]);
  const method = unquote(methodMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "");
  if (sites.length === 0 || method === "") {
    return null;
  }
  return { sites, enumeration_method: method };
}

function unquote(value: string): string {
  const trimmed = value.trim().replace(/[.;,]$/, "").trim();
  return /^(["'`])[\s\S]*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

function parseSites(raw: string): string[] {
  const text = raw.replace(/\s+/g, " ").trim().replace(/[;,]\s*$/, "");
  if (text === "") {
    return [];
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text.slice(0, text.lastIndexOf("]") + 1)) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)).filter((item) => item !== "");
      }
    } catch {
      // Not JSON after all; fall through to the separator forms below.
    }
  }
  const separator = text.includes(";") ? ";" : ",";
  return text
    .split(separator)
    .map((item) => item.replace(/^[-*+\s`"]+|[\s`",]+$/g, "").trim())
    .filter((item) => item !== "");
}

/** A markdown heading or list marker — the two markers a finding heading carries. */
const HEADING_MARKER = /^(?:#{1,6}|[-*+])\s+/;
/** `F-001`, optionally bracketed, at the start of what is left of the line. */
const FINDING_IDENTIFIER = /^(\[)?\s*(F-\d{3,})\b\s*(\])?/i;
/** What separates an identifier from its title: a colon or a dash of any length. */
const TITLE_SEPARATOR = /^\s*[:—–-]+\s*/;
/** What follows an identifier that is being REFERRED to inside a sentence. */
const REFERENCE_PUNCTUATION = /^[,.;)\]]/;

/**
 * A line that OPENS a finding, as opposed to one that mentions an id in prose.
 *
 * Position alone cannot tell the two apart, and trying was the defect this
 * replaces. Requiring the id to lead the line stopped counting mid-sentence
 * cross-references, but ordinary text wrapping routinely puts a reference at
 * line start: ingesting one real report produced eight phantom findings from a
 * single prose section, and rewriting that section reproduced them a second
 * time from the paragraph describing the defect.
 *
 * So a heading is identified POSITIVELY. It is one of the three shapes the
 * reviewer skills emit:
 *
 *   `### F-001 — the summary`      marker + separator
 *   `### [F-001] the summary`      marker + bracketed id
 *   `- [F-001] major: the summary` marker + bracketed id
 *
 * and the same two shapes without a marker.
 *
 * So the marker is stripped but decides nothing; what decides is that the id is
 * either BRACKETED or followed by a TITLE SEPARATOR. Everything else is a
 * reference: an id followed by `,`, `.`, `;` or `)` whatever precedes it, and a
 * bare `F-001 and F-002 belong to #220`, which is a sentence that happens to
 * start with an id.
 *
 * The cost of this direction is stated rather than hidden: a heading written as
 * a bare `F-001 the summary`, with neither bracket nor separator, is read as
 * prose and its finding is not recorded. No producer in this repository emits
 * that shape, and the alternative — accepting it — is what produced the
 * phantoms. A phantom `major` makes the class-scope guard refuse a report over
 * a finding that does not exist.
 */
function findingHeading(line: string): { id: string; summary: string } | null {
  const marked = line.replace(/^\s+/, "");
  const marker = marked.match(HEADING_MARKER);
  const afterMarker = marker === null ? marked : marked.slice(marker[0].length);

  const identifier = afterMarker.match(FINDING_IDENTIFIER);
  if (identifier === null || identifier[2] === undefined) {
    return null;
  }
  // An unbalanced bracket is prose: `F-001]` closes something this line did not
  // open, and `[F-001` never became a label.
  const bracketed = identifier[1] !== undefined;
  if (bracketed !== (identifier[3] !== undefined)) {
    return null;
  }

  const rest = afterMarker.slice(identifier[0].length);
  if (REFERENCE_PUNCTUATION.test(rest)) {
    return null;
  }

  const id = identifier[2].toUpperCase();
  const separator = rest.match(TITLE_SEPARATOR);
  if (separator !== null) {
    return { id, summary: rest.slice(separator[0].length).trim() };
  }
  // No separator, so the bracket has to carry the intent. A marker does not:
  // `- F-012 and F-014 are the same class` is a bullet of prose, and accepting
  // it would put the phantoms back through a different door.
  if (bracketed) {
    return { id, summary: rest.trim() };
  }
  return null;
}

/** The lines of one finding: from its heading to the next finding or the end. */
function findingBlock(lines: string[], headingIndex: number): string {
  const out: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    // The same predicate as the loop that found the heading. When these two
    // disagreed, a phantom did not merely add a finding — it also truncated the
    // real finding above it, taking that finding's `class_scope` with it.
    if (findingHeading(lines[i] ?? "") !== null) {
      break;
    }
    out.push(lines[i] ?? "");
  }
  return out.join("\n");
}

/**
 * Findings that must enumerate their class and do not.
 *
 * Fail-closed at ingest rather than a warning, because the rule this enforces
 * was added after eleven review rounds in which a fix repaired the one site a
 * finding named and left its siblings for the next round to find. A rule that
 * only lives in a schema no path validates against is matched against nothing —
 * which is the `allowlist-not-a-boundary` lesson, applied to this flow's own
 * work.
 */
export function classScopeViolations(
  findings: readonly NormalizedReviewFinding[],
): NormalizedReviewFinding[] {
  return findings.filter(
    (finding) =>
      (finding.severity === "blocker" || finding.severity === "major") &&
      finding.class_scope_present !== true,
  );
}

/**
 * The severity of one finding, from its heading and body.
 *
 * Precedence matters and was learned by executing this on a real report. Reading
 * the heading alone recorded every finding as `minor`, because every reviewer
 * format puts severity on the line below. Then reading heading-plus-body
 * keyword-scanned the prose, and a `minor` finding whose text merely DISCUSSED
 * blockers was recorded as a blocker — which tripped the class-scope guard on a
 * finding that did not need one.
 *
 * So: an explicit declaration wins wherever it appears; only in its absence does
 * a keyword count, and then the heading outranks the body.
 */
function severityFor(heading: string, block: string): NormalizedReviewFinding["severity"] {
  const declared = `${heading}\n${block}`.match(
    /^[\s>*_-]*(?:\*\*|__)?severity(?:\*\*|__)?\s*[:=]\s*(?:\*\*|__|`)?\s*(blocker|major|minor|info)\b/im,
  );
  if (declared?.[1]) {
    return declared[1].toLowerCase() as NormalizedReviewFinding["severity"];
  }
  const fromHeading = severityFromLine(heading);
  // `severityFromLine` cannot say "nothing here", so ask whether the heading
  // actually named one rather than trusting its `minor` default.
  if (/\b(blocker|major|info)\b/i.test(heading)) {
    return fromHeading;
  }
  return severityFromLine(block);
}

function severityFromLine(line: string): NormalizedReviewFinding["severity"] {
  const lower = line.toLowerCase();
  if (lower.includes("blocker")) {
    return "blocker";
  }
  if (lower.includes("major")) {
    return "major";
  }
  if (lower.includes("info")) {
    return "info";
  }
  return "minor";
}

// ---------------------------------------------------------------------------
// The pre-filter block inside scope.md
// ---------------------------------------------------------------------------

/**
 * The heading `keryx review scope --append` writes and this module reads.
 *
 * One constant, because two writers agreeing on a heading by coincidence is how
 * the block came to be appended three times by one command and then destroyed by
 * another.
 */
export const PRE_FILTER_SCOPE_HEADING = "## Pre-filter scope";

/**
 * The block: its heading, and everything up to the next `## ` heading or the end
 * of the file. `###` subheadings inside it are not a boundary, which is what lets
 * the block keep its own `### Retained` / `### Dropped by the pre-filter` halves.
 */
const PRE_FILTER_SCOPE_BLOCK = /^## Pre-filter scope[^\n]*\n[\s\S]*?(?=^## (?!#)|$(?![\s\S]))/m;

/** The `## Pre-filter scope` block of a scope.md, or null when there is none. */
export function extractPreFilterScopeBlock(text: string): string | null {
  const match = text.match(PRE_FILTER_SCOPE_BLOCK);
  return match === null ? null : match[0].trimEnd();
}

/**
 * Put `block` into `text`, REPLACING a pre-existing one rather than adding a
 * second.
 *
 * `--append` did what its name said, and three runs of one command — an ordinary
 * thing to do after amending a commit — left three contradictory `## Pre-filter
 * scope` blocks in one record with no rule for which to read.
 */
export function upsertPreFilterScopeBlock(text: string, block: string): string {
  const body = `${block.trimEnd()}\n`;
  if (PRE_FILTER_SCOPE_BLOCK.test(text)) {
    // A function replacement, not a string: `$&` and `$1` are live in a
    // replacement string, and a drop `detail` is arbitrary text from a diff.
    return `${text.replace(PRE_FILTER_SCOPE_BLOCK, () => `${body}\n`).trimEnd()}\n`;
  }
  return text.trimEnd() === "" ? body : `${text.trimEnd()}\n\n${body}`;
}

async function readPreFilterScopeBlock(packageDir: string): Promise<string | undefined> {
  const scopePath = path.join(packageDir, "scope.md");
  if (!(await pathExists(scopePath))) {
    return undefined;
  }
  return extractPreFilterScopeBlock(await readFile(scopePath, "utf8")) ?? undefined;
}

/**
 * `scope.md`: what this review looked at, and what each stage removed (AC5/AC11).
 *
 * The stage counts go here rather than into a new artifact because `scope.md` is
 * already where the pre-filter writes its drop list (`keryx review scope
 * --append`), and adding a seventh required artifact would strand every package
 * on disk against `missingArtifacts`.
 *
 * Two ways the pre-filter's record gets here, in precedence order:
 *
 * 1. `input.scope` — the whole `keryx review scope --json` document, counts and
 *    per-drop reasons together, rendered by this writer. This is the supported
 *    path and the only one that can satisfy AC5, because the counts-only form
 *    carries no reason for any individual drop.
 * 2. A `## Pre-filter scope` block already in the package's scope.md, carried
 *    forward verbatim. This exists so the ORDER the orchestrator is told to run
 *    things in cannot destroy the record: it appends the block at Step 3 and
 *    ingests after Step 12.
 */
function renderScope(
  input: ManagedReviewInput,
  flowMatch: FlowMatchResult | null,
  at: string,
  verification: VerificationMergeResult<NormalizedReviewFinding>,
  carriedPreFilter: string | undefined,
  caps: ReviewCapsRecord,
  externalReclaims: readonly ExternalReclaim[] = [],
): string {
  const preFilter: ReviewScopeCountsLike | undefined = input.scope?.counts ?? input.scopeCounts;
  const drops: readonly ReviewScopeDropLike[] | undefined = input.scope?.drops;
  const head = `# Review Scope

target: ${input.target.kind}
ref: ${input.target.ref}
mode: ${input.mode}
flow: ${flowMatch ? `${flowMatch.id} (${flowMatch.reason})` : "none"}
created_at: ${at}
context_mode: light

${renderStageCountsMarkdown({
  preFilter,
  preFilterDrops: drops,
  preFilterCarried: carriedPreFilter !== undefined,
  verification: verification.counts,
  rejections: verification.rejections,
  caps: verification.caps,
})}

${renderCapsMarkdown(caps)}${renderExternalReclaimsMarkdown(externalReclaims)}`;
  return carriedPreFilter === undefined ? head : `${head.trimEnd()}\n\n${carriedPreFilter}\n`;
}

/**
 * The AC10 reclaims, on the record.
 *
 * Silent would be the failure shape this whole programme removes: the verifier
 * refuted a human's comment, the finding survived anyway, and nothing said so —
 * leaving a reader to conclude the verifier agreed. The block is written only
 * when at least one reclaim happened, on the same rule as every other stage
 * count: a heading that always says `0` is noise, and this one's absence is not
 * a claim, because the stage counts above already say how many verdicts landed.
 */
function renderExternalReclaimsMarkdown(reclaims: readonly ExternalReclaim[]): string {
  if (reclaims.length === 0) {
    return "";
  }
  const rows = reclaims
    .map(
      (reclaim) =>
        `- ${reclaim.finding} — ${reclaim.removed ? "removed by the verifier and put back" : "annotated"}: ${reclaim.detail}`,
    )
    .join("\n");
  return `

## External findings the verifier could not refute

A \`refuted\` verdict on an external comment becomes \`answered-disagree\`, never
\`dismissed-incorrect\`, and never a removal. The finding stays and the reply is
still owed.

${rows}
`;
}

function renderCoverage(coverage: ReviewCoverageEntry[]): string {
  return `# Reviewer Coverage

${coverage.map((entry) => `reviewer: ${entry.reviewer}\nstatus: ${entry.status}\nreason: ${entry.reason}`).join("\n\n")}
`;
}

function renderReport(report: string, mode: ManagedReviewMode): string {
  return report.trim().length > 0 ? `${report.trim()}\n` : `# Managed Review Report\n\nmode: ${mode}\n`;
}

function renderLearning(findings: NormalizedReviewFinding[]): string {
  const candidates = findings.filter((finding) => finding.classification === "skill_learning_candidate");
  if (candidates.length === 0) {
    return `# Learning

## Skill Learning

- none
`;
  }
  return `# Learning

## Skill Learning

${candidates.map((finding) => `- \`${finding.reviewer}\` <- ${finding.id}: ${finding.summary}`).join("\n")}
`;
}

function renderDecisions(findings: NormalizedReviewFinding[]): string {
  if (findings.length === 0) {
    return `# Decisions

- none
`;
  }
  // `classification` and `flow_relevance` are recorded HERE and not in
  // `findings.json`, because `review-finding.schema.json` is
  // `additionalProperties: false` and neither is a property of the finding: the
  // reviewer states what is wrong, the pipeline states what it intends to do
  // about it. Carrying the pipeline's judgement inside the reviewer's record is
  // what made `findings.json` unusable as `prior_findings[].finding`.
  // A finding carrying a disposition gets THAT sentence rather than the
  // template one. `decisions.md` saying `create follow-up task or learning
  // proposal` for all 83 recorded findings is one of the four reasons the
  // precision baseline could not be computed from history.
  return `# Decisions

${findings
  .map((finding) => {
    const disposition = finding.disposition;
    if (disposition !== undefined && disposition.state !== "unknown") {
      return `- ${finding.id}: ${disposition.state} — ${disposition.evidence ?? "no evidence recorded"} (${finding.classification}, ${finding.flow_relevance}).`;
    }
    return `- ${finding.id}: create follow-up task or learning proposal (${finding.classification}, ${finding.flow_relevance}).`;
  })
  .join("\n")}
`;
}

function defaultReviewId(mode: ManagedReviewMode, kind: string, ref: string, at: string): string {
  const date = at.slice(0, 10);
  const normalizedRef = ref.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${date}-${mode === "attach-review" ? kind : mode}-${slugify(normalizedRef || kind)}`;
}

/**
 * How many same-day rounds of one target this will name before refusing.
 *
 * Two digits, so `-r02` … `-r99` sort in round order by NAME as well as by
 * `manifest.createdAt` — `readFlowReviewRounds` falls back to the directory name
 * when a package carries no timestamp, and `-r10` sorting before `-r2` would put
 * the rounds in the wrong order for the consecutive-output check.
 */
const MAX_SAME_DAY_ROUNDS = 99;

/**
 * The review id and the directory it owns — the fix for the second half of the
 * loop-detection defect (flow 203, AC9).
 *
 * `defaultReviewId` is `<YYYY-MM-DD>-<mode>-<ref>` and the documented invocation
 * never passes `--review-id`, so **two rounds of the same branch on the same day
 * resolved to one directory and the second silently overwrote the first**. What
 * reached disk was one package, `rounds_seen: 1`, and a detector with nothing to
 * compare — the canonical repair loop, made unobservable by the naming scheme.
 *
 * So a default-named round takes the next free directory: `<base>`, then
 * `<base>-r02`, `<base>-r03`. The first round of a day keeps exactly the name it
 * had before, which is why nothing that already names a package by hand had to
 * change.
 *
 * **An explicit `reviewId` is untouched** and still overwrites. That is the
 * difference in kind: a caller passing `--review-id` is stating the identity of
 * the round, and re-ingesting under that name is a deliberate replacement — the
 * retry path after a failed gate. A discriminator there would turn every retry
 * into a phantom round with byte-identical output, which is precisely the shape
 * `identical-output` escalates on. The default has no such statement behind it;
 * two ingests that named nothing are two rounds.
 *
 * The cost, stated rather than hidden: an operator who runs `review ingest`
 * twice on the SAME report without `--review-id` now records two rounds and gets
 * an `identical-output` escalation. That is a true statement about the record —
 * it does hold two identical rounds — and it is the direction to be wrong in.
 * The alternative, reusing the directory when the report matches, would delete
 * exactly the signal a genuinely stuck round produces.
 */
async function allocatePackage(
  input: ManagedReviewInput,
  flowMatch: FlowMatchResult | null,
  at: string,
): Promise<{ reviewId: string; packageDir: string }> {
  if (input.reviewId !== undefined) {
    return {
      reviewId: input.reviewId,
      packageDir: packagePath(input.cwd, input.mode, input.reviewId, flowMatch),
    };
  }
  const base = defaultReviewId(input.mode, input.target.kind, input.target.ref, at);
  for (let round = 1; round <= MAX_SAME_DAY_ROUNDS; round += 1) {
    const reviewId = round === 1 ? base : `${base}-r${String(round).padStart(2, "0")}`;
    const packageDir = packagePath(input.cwd, input.mode, reviewId, flowMatch);
    if (!(await pathExists(packageDir))) {
      return { reviewId, packageDir };
    }
  }
  throw new Error(
    `Refusing to record a ${MAX_SAME_DAY_ROUNDS + 1}th review round for "${base}" in one day. ${MAX_SAME_DAY_ROUNDS} rounds against one target is a repair loop that nothing stopped — run \`keryx review loop --flow <id>\`, or pass --review-id to name this round yourself.`,
  );
}

function matchesTarget(flow: FlowState, dir: string, kind: string, ref: string): boolean {
  if (kind === "pr" && flow.pr.url === ref) {
    return true;
  }
  if (kind === "issue" && flow.source.ref === ref) {
    return true;
  }
  if (kind === "branch") {
    const branchSlug = slugify(ref.replace(/^refs\/heads\//, ""));
    return flow.slug === branchSlug || dir.endsWith(`-${branchSlug}`) || flow.title.includes(ref);
  }
  return false;
}

function matchReason(flow: FlowState, dir: string, kind: string, ref: string): FlowMatchResult["reason"] {
  if (kind === "pr" && flow.pr.url === ref) {
    return "pr-url";
  }
  if (kind === "issue" && flow.source.ref === ref) {
    return "issue-url";
  }
  if (kind === "branch" && matchesTarget(flow, dir, kind, ref)) {
    return "branch";
  }
  return "none";
}

async function missingArtifacts(packageDir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const artifact of ["scope.md", "coverage.md", "report.md", "findings.json", "learning.md", "decisions.md"]) {
    if (!(await pathExists(path.join(packageDir, artifact)))) {
      missing.push(artifact);
    }
  }
  return missing;
}

async function resolveReviewPackagePath(cwd: string, ref: string): Promise<string> {
  const absolute = path.resolve(cwd, ref);
  if (await pathExists(path.join(absolute, "manifest.json"))) {
    return absolute;
  }
  if (await pathExists(absolute) && absolute.endsWith("manifest.json")) {
    return path.dirname(absolute);
  }

  const standalone = path.join(reviewsRoot(cwd), ref);
  if (await pathExists(path.join(standalone, "manifest.json"))) {
    return standalone;
  }

  for (const flowDir of await listFlowDirs(cwd)) {
    const reviewsDir = path.join(flowsRoot(cwd), flowDir, "reviews");
    if (!(await pathExists(reviewsDir))) {
      continue;
    }
    for (const entry of await readdir(reviewsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === ref) {
        return path.join(reviewsDir, entry.name);
      }
    }
  }

  throw new Error(`Managed review package not found: ${ref}`);
}

async function loadDocpackSchema(cwd: string): Promise<Record<string, unknown> | null> {
  const schemaPath = path.join(
    cwd,
    "docs",
    "requirements",
    "managed-review-feedback-loop",
    "schemas",
    "managed-review-package.schema.json",
  );
  if (!(await pathExists(schemaPath))) {
    return null;
  }
  const parsed = JSON.parse(await readFile(schemaPath, "utf8")) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

