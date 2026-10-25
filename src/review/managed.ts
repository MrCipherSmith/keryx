import { type CoverageWaiver, recordCoverageWaiver } from "./coverage-complete";
import { revisionOperand } from "../lib/git-revision";
import { flagMissingCitations } from "./rebuttal-citation";
import { completeHeadGate, isPrBound, type PrLookup } from "./complete-head-gate";
import { REPORT_FIELD_EVIDENCE_LEVEL, parseEvidenceLevel } from "./evidence-level";
import { packageCoverageWarnings } from "./coverage";
import { packageParityWarnings } from "./parity";
import { roundRecordTampered } from "./round-record";
import { recordFinishedRound } from "./round-registry";
import { withSpendSection } from "./dispatch-usage";
import { renderCoverageMd } from "./coverage-md";
import { INGEST_SCREENED_FILE, PENDING_RESEARCH, dispatchRuns, packageResearchErrors, type DispatchRun, type IngestScreened } from "./research";
import { computeReadiness, readinessRefusal, waiveReadiness, withoutPartialHeader, type ReadinessReport } from "./readiness";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { resolveProjectRoot } from "../lib/contained-path";
import { clearActiveReview } from "./active-review";
import { listFlowDirs, readFlow, resolveFlowDir, slugify } from "../flow/store";
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
  BLAST_RADIUS_SCOPE_REVIEWER,
  isBlastRadiusScopedFinding,
  renderBlastRadiusScreenMarkdown,
  screenBlastRadiusFindings,
  type BlastRadiusScreenInput,
  type BlastRadiusScreenResult,
} from "./blast-radius";
import {
  applyFindingsCap,
  evaluateSpendCap,
  planReviewerWaves,
  renderCapsMarkdown,
  type ConcurrencyPlan,
  type ReviewCapsRecord,
} from "./caps";
import {
  buildFilterStats,
  renderFilterStatsMarkdown,
  type ReviewFilterStats,
} from "./filter-stats";
import { locateFinding, MAX_LOCATE_FILE_BYTES } from "./locate";
import { hashedDisplayIdMessage, hashedDisplayIds } from "./display-id";
import { mergeDuplicates, renderDuplicatesMarkdown, type DuplicateMerge } from "./dedupe";
import { computeChunkPass } from "./chunks";
import { describePassFinding, injectablePassFindings, missingWarning, passNotInRound, upsertMissingSection } from "./chunk-findings";
import { flowReviewsRoot, readManifestHead, reviewsRoot } from "./package-location";
import { PREMISES_FILE, PREMISES_SUPERSEDED_FILE, carriedPremiseHolds, mergePremises, parsePremiseClaimSets, previousFindingsUnreadable, renderPremiseMarkdown } from "./premise";
import { promoteParentExecutions } from "./verify-run";
import { withOperatorDecisionsLock } from "./operator-decisions";
import { repairMechanicalOmissions, type FindingRepair } from "./repair";
import { writeReviewNotes, type ReviewNoteResult } from "./review-notes";
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
  type VerificationClaimInput,
} from "./types";

const REQUIRED_ARTIFACTS = ["scope", "coverage", "report", "findings", "learning", "decisions"] as const;

export { reviewsRoot } from "./package-location";

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
export async function resolveTargetHead(input: ManagedReviewInput, packageDir?: string): Promise<string | null> {
  const declared = input.target.head;
  if (typeof declared === "string" && declared.trim() !== "") {
    return declared.trim();
  }
  // Flow 458 AC7. Ingest into a package that already exists (`review ingest --review-id <id>` after `review start`)
  // records the round against the head that package was opened for, not whatever the checkout moved to since: the
  // reviewers read that commit. A head this checkout does not have is refused rather than replaced, because every
  // quote is located at it and the completion gate compares it with the PR.
  if (packageDir !== undefined) {
    const recorded = await recordedPackageHead(packageDir);
    if (recorded !== undefined) {
      if (!(await commitExists(input.cwd, recorded))) {
        throw new Error(
          `Cannot ingest into ${path.relative(input.cwd, packageDir) || packageDir}: its manifest records head ${recorded.slice(0, 12)}, and that commit is not in this checkout (\`git cat-file -e ${recorded.slice(0, 12)}^{commit}\` fails). Fetch it (\`git fetch origin ${recorded}\` or the PR branch) and ingest again, or pass --head <sha> to name the commit this round really ran against.`,
        );
      }
      return recorded;
    }
  }
  return (input.resolveHead ?? ((args) => resolveGitHead(args.cwd)))({
    cwd: input.cwd,
    target: input.target,
  });
}

/** `manifest.target.head` of an existing package, or undefined when there is no package or it records none. */
async function recordedPackageHead(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(packageDir, "manifest.json"), "utf8")) as { target?: { head?: unknown } };
    const head = manifest.target?.head;
    return typeof head === "string" && /^[0-9a-f]{7,40}$/i.test(head.trim()) ? head.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `sha` names a commit in the repository at `cwd`. */
async function commitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "cat-file", "-e", ...revisionOperand(`${sha}^{commit}`)], { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
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

/**
 * {@link ManagedReviewInput} plus the computed scope-B set, when the round ran
 * one.
 *
 * The set is an ARGUMENT to the screen and not part of the package contract
 * `types.ts` describes — nothing in the manifest, the finding record or either
 * schema carries it — so it is declared where it is used and consumed. A caller
 * that ran `keryx review blast-radius` passes the record it already holds; a
 * caller that did not passes nothing, and {@link resolveScreenRadius} looks for
 * the record on disk — see {@link handoffBlastRadiusPath} for where, and why it
 * is NOT inside the package.
 */
export type ManagedReviewIngestInput = ManagedReviewInput & {
  research?: unknown;
  /** The set scope B was dispatched over. See {@link screenScopeBFindings}. */
  blastRadius?: BlastRadiusScreenInput | undefined;
};

/**
 * What the scope-B screen did to this round's findings (AC3).
 *
 * Shaped after {@link module:review/caps.FindingsCapResult}, deliberately: a
 * screen that removes findings owes the same record a cap does — how many it saw,
 * how many it kept, and every single one it removed WITH the rule that removed
 * it. `screen: undefined` is the cap's `not recorded`: the screen did not run,
 * which is not the same fact as "it ran and rejected nothing".
 */
export type ScopeBScreenRecord = {
  /**
   * Where the blast-radius record came from.
   *
   * - `input` — the caller passed it (`--blast-radius <file>`).
   * - `handoff` — read from the reviews root, the between-commands channel.
   * - `package` — read from this package's own copy, which a previous ingest of
   *   the same `--review-id` wrote there. This is the retry path.
   * - `none` — no screen ran.
   */
  source: "input" | "handoff" | "package" | "none";
  /** Findings attributed to a scope-B reviewer, before the screen. */
  scopeBFindings: number;
  screen?: BlastRadiusScreenResult<NormalizedReviewFinding> | undefined;
};

/** What an ingest did with the findings of the package's chunk pass. */
export type ChunkPassIngest = {
  /** Ids of the pass findings brought into the round. */
  brought: string[];
  /** Pass findings the report already carried at the same site, described for the record. */
  alreadyReported: string[];
};

function renderChunkPassMarkdown(record: ChunkPassIngest): string {
  if (record.brought.length === 0 && record.alreadyReported.length === 0) return "";
  const lines = ["", "## Chunk pass findings", "", `brought_in: ${record.brought.length}${record.brought.length === 0 ? "" : ` (${record.brought.join(", ")})`}`];
  if (record.alreadyReported.length > 0) lines.push(`already_in_report: ${record.alreadyReported.join("; ")}`);
  lines.push("", "Brought in from chunk-state.json as reviewer `<reviewer>/<chunk>`; the screen did not apply `outside-set` and `no-link-to-change` to them.", "");
  return lines.join("\n");
}

/** The file name every copy of the blast-radius record is read from and written to. */
const BLAST_RADIUS_ARTIFACT = "blast-radius.json";

export async function createManagedReviewPackage(
  input: ManagedReviewIngestInput,
): Promise<ManagedReviewPackageResult & { scopeBScreen: ScopeBScreenRecord; duplicates: DuplicateMerge[]; chunkPass: ChunkPassIngest }> {
  const at = (input.now ?? new Date()).toISOString();
  // Parsed first: a premise file of the wrong shape refuses the ingest before a package is allocated.
  const premiseClaims = parsePremiseClaimSets(input.premises);
  const flowMatch = await resolvePackageFlow(input);
  const { reviewId, packageDir } = await allocatePackage(input, flowMatch, at);
  // Before anything is written: an id that names packages in two places refuses here (review LG6-002, SEC6-001).
  const verifications = await ownPackageVerifications(input, packageDir);
  const coverage = normalizeCoverage(input.coverage, input.reviewers, dispatchRuns(input.research));
  const report = await readReport(input);
  const reviewers = attributionReviewers(input);
  const { findings: reported, from: findingsFrom } = await normalizeFindings({
    report,
    reportLabel: reportLabel(input),
    mode: input.mode,
    attachedToFlow: flowMatch !== null,
    source: input.findings,
    reviewers,
  });
  refuseUnacceptableRound(input, report, findingsFrom, reported);
  // Typing, filled in; judgement, still refused. Runs BEFORE `assignGlobalIds`,
  // because a finding with no `id` mints the key `<reviewId>#undefined` and five
  // of them then collide on it — which is how a round was lost to a field the
  // report's own ordering already contained.
  const repairs = repairMechanicalOmissions(reported);

  // What a chunk pass found reaches the round here, from the live pass state and before the findings are located, so the
  // verifier and the premise judge see it like any other finding. The report's own findings win a same-site tie.
  const passIn = input.mode === "ingest" ? injectablePassFindings(await computeChunkPass(packageDir), reported) : undefined;
  const passFindings = passIn === undefined ? [] : triage(passIn.findings, { mode: input.mode, attachedToFlow: flowMatch !== null });
  reported.push(...passFindings);

  // Resolved HERE rather than beside `buildManifest`, because the locator needs
  // it: a round is a claim about a commit, and its findings are located at that
  // commit rather than against whatever the tree currently holds.
  const head = await resolveTargetHead(input, packageDir);

  // The line becomes a derived fact here, BEFORE anything downstream reads it:
  // the verifier cites a finding, the cap reports one by site, `scope.md` lists
  // them, and every one of those would otherwise be quoting a number nobody
  // checked. A finding with no quote is untouched — it keeps whatever it said,
  // and says so by carrying no locator.
  await anchorFindings(reported, input, head);
  await flagMissingPaths(reported, input, head);
  refuseUnresolvedLocators(reported, input, head);

  // Minted BEFORE the verifier runs, because a claim names a finding by
  // `global_id` and the key has to exist for it to be resolvable. Round N+1
  // carries round N's key verbatim; only a finding without one is minted here.
  assignGlobalIds(reported, reviewId);
  const chunkPassIngest: ChunkPassIngest = {
    brought: passFindings.map((finding) => finding.id),
    alreadyReported: passIn?.alreadyReported.map(describePassFinding) ?? [],
  };
  const passKeys = new Set(passFindings.flatMap((finding) => (finding.global_id === undefined ? [] : [finding.global_id])));

  // The verifier, which can only delete. In `annotate` — the default for one
  // release — nothing is removed and a `refuted` verdict is recorded on a finding
  // that is still reported, so the drop rate is a measured number before it costs
  // a real finding.
  const merged = mergeVerifications(reported, verifications, {
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

  // AC3, enforced here rather than asked for in `review-regression/SKILL.md`.
  // The skill has said "this is enforced, not requested" since the day the
  // screen was written, and nothing called it: a scope-B `major` about the style
  // of an untouched hop-2 file was ingested unscreened and then blocked
  // completion at the review gate — the opposite of the promise. It runs BEFORE
  // the findings cap so a rejected finding cannot spend a reviewer's reading
  // budget on its way out.
  const scopeB = await screenScopeBFindings(input, packageDir, scoped.internal, passKeys);

  // Flow 458 AC5. One defect reported by several reviewers becomes ONE finding
  // with the highest severity (the verifier's, when it confirmed one) and every
  // reporter in `reported_by`. After the verifier so each claim still resolved
  // against the id it named, after the scope-B screen so a scope-B claim cannot
  // escape it by merging into a scope-A one, and before the cap so a duplicate
  // does not spend a reviewer's reading budget. See {@link mergeDuplicates}.
  const deduped = mergeDuplicates(scopeB.retained);

  // Flow 459. The premise judge, which can only hold or lower. It runs over the CANONICAL findings, after the
  // duplicate merge (so a claim names the one record that survives) and before the cap (so a downgraded severity
  // is the one the cap and every later reader sees). External findings are in the set: they may be challenged,
  // which makes them a question for the operator and never a dismissal. A carried finding keeps its premise.
  // One merge over both sets (a claim may name either, and two claims on one finding must meet to cancel), then split
  // by what each finding IS rather than by position.
  const premiseSet = [...deduped.findings, ...scoped.external];
  // Review RG2-004: an ingest without --premises over a package the judge held re-applies each hold of the previous
  // findings.json, as a claim under the merge's rules, to the same, unchanged finding, and is refused otherwise; it
  // never silently drops a hold, and an unreadable findings.json refuses rather than reading as "nothing held" (LG6-001).
  const carriedHolds = premiseClaims === undefined ? carriedPremiseHolds(premiseSet, await readPreviousFindings(packageDir)) : undefined;
  if (carriedHolds?.ok === false) throw new Error(carriedHolds.refusal);
  const premised = mergePremises(carriedHolds?.ok === true ? carriedHolds.findings : premiseSet, premiseClaims);
  const premisedInternal = premised.findings.filter((finding) => finding.source !== "external");
  const premisedExternal = premised.findings.filter((finding) => finding.source === "external");

  const findingsCap = applyFindingsCap(premisedInternal, {
    limit: input.maxFindingsPerReviewer,
  });

  // What the round reported, then what the verifier removed, then what the round
  // itself refuted — one array, one file, one gate. A separate `refuted.json`
  // would be a second thing every consumer has to remember to read, and the
  // consumer that forgets keeps counting zero wrong findings, which is the state
  // this exists to leave.
  const roundDismissed = fromRefutedSource(input.refuted, reviewers, flowMatch !== null);
  const findings = [
    ...findingsCap.retained,
    ...premisedExternal,
    ...fromVerifierRefutations(verification.refuted),
    ...roundDismissed,
  ];
  assignGlobalIds(findings, reviewId);

  // A rebuttal that cites a rule or document gets that citation looked up. A missing one
  // is said on the finding; the finding itself is never removed.
  await flagMissingCitations(findings, (cited) => citationExists(input.cwd, head, cited));

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

  // Flow 207 AC1. Built HERE, from the stage results the lines above are still
  // holding, and never from `scope.md` — a record re-derived from the prose a
  // renderer wrote would describe the renderer. It goes onto the manifest below,
  // so it is validated by the same schema pass as everything else and read back
  // by `keryx review status` (AC3).
  const filterStats: ReviewFilterStats = buildFilterStats({
    scope: input.scope,
    scopeCounts: input.scopeCounts,
    preFilterCarried: carried !== undefined,
    verification: verification.counts,
    ...(scopeB.record.screen === undefined ? {} : { scopeB: scopeB.record.screen }),
    findingsCap: { counts: findingsCap.counts, drops: findingsCap.drops },
    externalRetained: scoped.external.length,
    ...(input.refuted === undefined ? {} : { roundDismissed: roundDismissed.length }),
    duplicatesMerged: deduped.merges.reduce((sum, merge) => sum + merge.absorbed.length, 0),
  });
  const manifest = buildManifest({
    input,
    target: targetWithHead(input.target, head),
    reviewId,
    packageDir,
    flowMatch,
    coverage,
    at,
    filterStats,
    repairs,
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
  Object.assign(manifest.artifacts, { research: "research.json", reviewerDispatch: "research.json" });
  const contractErrors = await schemaErrors(findings);
  if (contractErrors.length > 0) {
    throw new Error(
      `Refusing to record findings that do not satisfy review-finding.schema.json: ${contractErrors
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")}`,
    );
  }

  await mkdir(packageDir, { recursive: true });
  await writeFileAtomic(path.join(packageDir, "research.json"), `${JSON.stringify(input.research ?? PENDING_RESEARCH, null, 2)}\n`);
  await writeFileAtomic(path.join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (input.premises !== undefined) {
    // The claims as received, rejected ones included: the record of what the judge said. Only a package without an
    // ingested round re-applies it (the interim verdict over raw results); findings.json is the record after ingest.
    await mkdir(path.join(packageDir, "research-evidence"), { recursive: true });
    // One result is written as the judge's object, several as their list; both read back through parsePremiseClaimSets
    // (the verdict, and `review ingest --premises <this file>`).
    const record = Array.isArray(input.premises) && input.premises.length === 1 ? input.premises[0] : input.premises;
    await writeFileAtomic(path.join(packageDir, PREMISES_FILE), `${JSON.stringify(record, null, 2)}\n`);
  } else if (carriedHolds === undefined && (await pathExists(path.join(packageDir, PREMISES_FILE)))) {
    // An ingest without --premises that carried no hold keeps the judge's record, moved aside (review RG2-004): the
    // verdict never re-applies claims to an ingested round, so the file at its own name would only mislead a reader
    // into thinking this ingest applied them. When holds were carried it stays where it is, untouched: the holds came
    // from the previous findings.json, not from this file, which may predate them or be gone (review SEC6-002).
    await rename(path.join(packageDir, PREMISES_FILE), path.join(packageDir, PREMISES_SUPERSEDED_FILE));
  }
  if (input.scope?.files !== undefined) {
    await writeFileAtomic(path.join(packageDir, "scope-files.json"), `${JSON.stringify({ version: 1, files: input.scope.files, ...(typeof input.scope.counts?.changedLinesRetained === "number" ? { changedLines: input.scope.counts.changedLinesRetained } : {}) }, null, 2)}\n`);
  }
  const premiseBlock = renderPremiseMarkdown({
    counts: premised.counts,
    rejections: premised.rejections,
    findings,
    ...(carriedHolds?.ok === true && carriedHolds.carried > 0 ? { carried: { holds: carriedHolds.carried, judges: carriedHolds.judges } } : {}),
  });
  await writeFileAtomic(
    path.join(packageDir, "scope.md"),
    renderScope(input, flowMatch, at, verification, carried, caps, { externalReclaims, scopeBScreen: scopeB.record, filterStats, allFindings: findings }) +
      premiseBlock +
      renderDuplicatesMarkdown(deduped.merges) +
      renderChunkPassMarkdown(chunkPassIngest),
  );
  await writeFileAtomic(path.join(packageDir, "coverage.md"), renderCoverage(coverage));
  // Flow 460: the round's token spend, as research.json states it (unknown dispatches counted, never 0); a re-ingest
  // replaces the section a report already holds.
  await writeFileAtomic(path.join(packageDir, "report.md"), withSpendSection(renderReport(report, input.mode), input.research));
  // Under the decisions lock, like every other findings.json writer: a premise answer to a re-ingested package
  // rewrites the same file.
  await withOperatorDecisionsLock(packageDir, () => writeFileAtomic(
    path.join(packageDir, "findings.json"),
    `${JSON.stringify(findings.map(toContractFinding), null, 2)}\n`,
  ));
  // Flow 460: what the scope-B screen kept out of findings.json, for `review ledger build` to close. Rewritten on every
  // ingest (empty when nothing was screened), so a re-ingest never leaves an earlier screen's record behind.
  await mkdir(path.join(packageDir, "research-evidence"), { recursive: true });
  await writeFileAtomic(path.join(packageDir, INGEST_SCREENED_FILE), `${JSON.stringify({ version: 1, screened: screenedRecord(scopeB.record) }, null, 2)}\n`);
  await writeFileAtomic(path.join(packageDir, "learning.md"), renderLearning(findings));
  await writeFileAtomic(path.join(packageDir, "decisions.md"), renderDecisions(findings));
  // Last, and only once the package is complete. See {@link persistScreenRadius}.
  await persistScreenRadius(packageDir, scopeB.resolved);

  // Flow 207 AC5. The findings this round recorded as `dismissed-incorrect` —
  // and only those — reach `.metaproject/memory/review-notes/`, the folder the
  // roadmap records as never having been written to. Written AFTER the package,
  // so a round refused by any gate above leaves no learning note behind claiming
  // a model error nobody recorded.
  //
  // A `refuted` verdict applied in `filter` mode arrives here already carrying
  // the verifier's method and evidence, so it is attested. A `--refuted` finding
  // whose evidence names nobody is NOT, and {@link writeReviewNotes} returns it
  // in `skipped` rather than writing a note: AC6 stands unchanged, and the
  // orchestrator does not get to file a finding as its own error unattended.
  const reviewNotes: ReviewNoteResult = await writeReviewNotes(findings, {
    cwd: input.cwd,
    reviewId,
    head,
    packagePath: path.relative(input.cwd, packageDir),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  return {
    reviewId,
    path: path.relative(input.cwd, packageDir),
    manifest,
    verification: verification.counts,
    verificationRejections: verification.rejections,
    verificationCaps: verification.caps,
    premise: premised.counts,
    premiseRejections: premised.rejections,
    ...(carriedHolds?.ok === true ? { premisesCarriedForward: true as const } : {}),
    caps,
    filterStats,
    reviewNotes,
    // Returned as well as written into `scope.md`, on the same rule the caps
    // record follows: a removal an operator has to open a file to discover reads,
    // on the terminal they were already looking at, as "there was nothing more".
    scopeBScreen: scopeB.record,
    duplicates: deduped.merges,
    chunkPass: chunkPassIngest,
  };
}

/**
 * Run the AC3 screen over the findings scope B raised, or refuse to record them.
 *
 * Three outcomes, and the third is the point:
 *
 * 1. **A blast-radius record and scope-B findings** — the screen runs.
 *    {@link screenBlastRadiusFindings} keeps the regression claims and returns
 *    the rest with the rule that refused each one; the rejected findings do not
 *    reach `findings.json`, and every one of them is named in `scope.md`.
 * 2. **A blast-radius record and no scope-B findings** — the screen runs over an
 *    empty set and says so. `accepted: 0, rejected: 0` after a screen that ran is
 *    a different fact from a screen that did not, and the record keeps them apart.
 * 3. **Scope-B findings and no blast-radius record** — refused. The alternative
 *    is the defect this repairs: the enforcement silently not running while the
 *    skill tells the reviewer it did. A screen cannot be applied without the set
 *    the round was dispatched over, so the round is not recordable until the set
 *    is supplied. The refusal names both channels that work — `--blast-radius
 *    <file>` and the handoff slot in the reviews root — and names the one that
 *    does not, because the message used to point at the package directory and
 *    following it made the ingest allocate a different one. See
 *    {@link handoffBlastRadiusPath}.
 *
 * Findings that are not scope B pass through untouched. Scope A asks a different
 * question and its `minor` on a changed file is legitimate.
 */
async function screenScopeBFindings(
  input: ManagedReviewIngestInput,
  packageDir: string,
  findings: readonly NormalizedReviewFinding[],
  passKeys: ReadonlySet<string> = new Set(),
): Promise<{ retained: NormalizedReviewFinding[]; record: ScopeBScreenRecord; resolved: ResolvedScreenRadius | undefined }> {
  const resolved = await resolveScreenRadius(input, packageDir);
  const reviewers = resolved?.radius.reviewers ?? [BLAST_RADIUS_SCOPE_REVIEWER];
  const isPass = (finding: NormalizedReviewFinding): boolean => finding.global_id !== undefined && passKeys.has(finding.global_id);
  const scopeB = findings.filter((finding) => isBlastRadiusScopedFinding(finding, reviewers));

  if (resolved === undefined) {
    // A chunk-pass finding is scope-B by name but the screen would not judge it by the set anyway, so a package whose
    // only scope-B findings came from its own pass is not refused for lacking the record.
    if (scopeB.some((finding) => !isPass(finding))) {
      throw new Error(
        `Refusing to record ${scopeB.filter((finding) => !isPass(finding)).length} finding(s) raised under scope B (${scopeB
          .filter((finding) => !isPass(finding))
          .map((finding) => `${finding.id} by ${finding.reviewer}`)
          .join(
            ", ",
          )}) with no blast-radius record: AC3 is enforced in code, and the screen cannot be applied without the computed set the round was dispatched over. Two ways out, and the first is the one that always works: (1) compute the set with \`keryx review blast-radius --json > <file>\` and pass \`--blast-radius <file>\` to this ingest; (2) write that record to \`${path.relative(
          input.cwd,
          handoffBlastRadiusPath(packageDir),
        )}\` and ingest again — the ingest reads it from there and consumes it. Do NOT write it to \`${path.relative(
          input.cwd,
          path.join(packageDir, BLAST_RADIUS_ARTIFACT),
        )}\`: a round that names no --review-id has not allocated that directory yet, so creating it makes the next ingest take the NEXT free name and find nothing there either.`,
      );
    }
    return { retained: [...findings], record: { source: "none", scopeBFindings: 0 }, resolved: undefined };
  }

  const screen = screenBlastRadiusFindings(scopeB, resolved.radius, { minSeverity: resolved.radius.minSeverity, chunkPass: isPass });
  const rejected = new Set(screen.rejected.map((rejection) => rejection.finding));
  // The rejected findings do NOT go on to `findings.json`, and that is the
  // decision rather than an oversight. `findings.json` is what this round is
  // ASSERTING and what the completion gate must act on; a scope-B finding the
  // screen refused is a claim the round has explicitly declined to make, and
  // recording it there would hand the gate the exact thing AC3 exists to stop
  // blocking completion on — an opinion about untouched code wearing scope B's
  // badge. What it may not be is invisible, so every rejection is named three
  // times: in `scope.md` under "## Scope B rejections" with the rule and the
  // detail, in the `ScopeBScreenRecord` this returns, and on the terminal the
  // operator was already looking at (`keryx review ingest` prints one line per
  // rejection). "Rejected 0" and "the screen did not run" stay distinguishable
  // in all three.
  return {
    retained: findings.filter((finding) => !rejected.has(finding)),
    record: {
      source: resolved.source,
      scopeBFindings: scopeB.length,
      screen,
    },
    resolved,
  };
}

/** The scope-B rejections as {@link INGEST_SCREENED_FILE} records them. */
function screenedRecord(record: ScopeBScreenRecord): IngestScreened[] {
  return (record.screen?.rejected ?? []).flatMap((rejection): IngestScreened[] => {
    const finding = rejection.finding;
    if (typeof finding.id !== "string" || finding.id === "") return [];
    return [{ id: finding.id, ...(typeof finding.global_id === "string" ? { global_id: finding.global_id } : {}), ...(typeof finding.reviewer === "string" ? { reviewer: finding.reviewer } : {}), rule: rejection.rule, detail: rejection.detail }];
  });
}

type ResolvedScreenRadius = {
  radius: BlastRadiusScreenInput;
  source: "input" | "handoff" | "package";
  /** The file it was read from, when it came off disk. Consumed after the write. */
  file?: string | undefined;
};

/**
 * Where the between-commands blast-radius record lives: the REVIEWS ROOT, not
 * the package.
 *
 * It used to be the package, and that was a trap. {@link allocatePackage}
 * returns a directory that does not exist yet for every round that names no
 * `--review-id` — which is every round the orchestrator runs — so the read
 * always missed, the refusal always fired, and the refusal told the operator to
 * create exactly the directory whose existence makes the next ingest allocate
 * `<base>-r02` instead. Following the advice moved the target. Reproduced end to
 * end: throw, write, throw, up to `MAX_SAME_DAY_ROUNDS`.
 *
 * The reviews root has the property the package dir lacks: writing a file into
 * it cannot change which package name gets allocated, because allocation probes
 * `<root>/<reviewId>` DIRECTORIES only. So the record can be written before the
 * round and read after it without either command knowing the id.
 *
 * The record is consumed by the ingest that reads it (see
 * {@link persistScreenRadius}) and copied into the package it screened. Both
 * halves matter: the copy is what makes a re-ingest under the same
 * `--review-id` screen against the same set without re-passing the flag, and
 * the removal is what stops the NEXT round — a different change, a different
 * radius — from silently screening against a set nobody recomputed. A stale set
 * that still screens is the same class of failure as a screen that never ran.
 */
function handoffBlastRadiusPath(packageDir: string): string {
  return path.join(path.dirname(packageDir), BLAST_RADIUS_ARTIFACT);
}

async function resolveScreenRadius(
  input: ManagedReviewIngestInput,
  packageDir: string,
): Promise<ResolvedScreenRadius | undefined> {
  if (input.blastRadius !== undefined) {
    return { radius: input.blastRadius, source: "input" };
  }
  // The package's own copy first, so a retry under an explicit `--review-id`
  // re-screens against the set the first attempt used rather than whatever the
  // handoff slot happens to hold now.
  const inPackage = path.join(packageDir, BLAST_RADIUS_ARTIFACT);
  const fromPackage = await readBlastRadiusRecordFile(inPackage);
  if (fromPackage !== undefined) {
    return { radius: fromPackage, source: "package", file: inPackage };
  }
  const handoff = handoffBlastRadiusPath(packageDir);
  const fromHandoff = await readBlastRadiusRecordFile(handoff);
  if (fromHandoff !== undefined) {
    return { radius: fromHandoff, source: "handoff", file: handoff };
  }
  return undefined;
}

/**
 * One blast-radius record off disk, or `undefined` when the file is absent.
 *
 * A malformed file throws rather than falling back to "no record" — an
 * unreadable artifact silently disabling the screen is precisely the failure
 * being repaired here.
 */
async function readBlastRadiusRecordFile(file: string): Promise<BlastRadiusScreenInput | undefined> {
  if (!(await pathExists(file))) {
    return undefined;
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<BlastRadiusScreenInput>;
  if (!Array.isArray(parsed?.files) || !Array.isArray(parsed?.changedFiles)) {
    throw new Error(
      `${file} is not a blast-radius record: it carries no \`files\` and \`changedFiles\` arrays. It is the \`--json\` output of \`keryx review blast-radius\`, and scope B cannot be screened against anything else.`,
    );
  }
  return parsed as BlastRadiusScreenInput;
}

/**
 * Leave the package holding the set it was screened against, and empty the
 * handoff slot.
 *
 * Runs AFTER every other artifact is on disk, so an ingest refused by a later
 * gate leaves the operator's handoff file exactly where they put it.
 */
async function persistScreenRadius(packageDir: string, resolved: ResolvedScreenRadius | undefined): Promise<void> {
  if (resolved === undefined) {
    return;
  }
  const inPackage = path.join(packageDir, BLAST_RADIUS_ARTIFACT);
  if (resolved.source !== "package") {
    await writeFileAtomic(inPackage, `${JSON.stringify(resolved.radius, null, 2)}\n`);
  }
  if (resolved.source === "handoff" && resolved.file !== undefined) {
    await rm(resolved.file, { force: true });
  }
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

/** What `completeManagedReview` would refuse on right now, without closing anything. */
export async function reviewCompletionBlockers(packageDir: string): Promise<string[]> {
  const missing = await missingArtifacts(packageDir);
  if (missing.length > 0) return [`missing artifacts: ${missing.join(", ")}`];
  try {
    const manifest = JSON.parse(await readFile(path.join(packageDir, "manifest.json"), "utf8")) as ManagedReviewManifest;
    const findings = JSON.parse(await readFile(path.join(packageDir, "findings.json"), "utf8"));
    return await packageResearchErrors(packageDir, manifest.artifacts, findings);
  } catch (error) {
    return [`package unreadable: ${error instanceof Error ? error.message : String(error)}`];
  }
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
  /** Injectable clock, so a note's `Created:` date is deterministic in a test. */
  now?: Date | undefined;
  /** The operator's own words waiving every file the coverage gate finds uncovered (`--waive-coverage`). */
  waiveCoverage?: string | undefined;
  /** Reads a PR's state and head. Absent means the head and merge check is not made (a library caller with no tracker). */
  prLookup?: PrLookup | undefined;
  /**
   * The commit this round reviewed (`--head`), a 7-40 hex SHA. When given it is what the head gate
   * checks and what the closed manifest records as `target.head`, in place of the head recorded at
   * start. The gate itself is unchanged: a head that is not the PR's head still needs the report
   * to name it and say the PR moved.
   */
  head?: string | undefined;
  /** Readiness items the operator waives in their own words (`--waive <item> "<quote>"`), one entry per flag. */
  waiveReadiness?: ReadonlyArray<{ items: readonly string[]; quote: string }> | undefined;
  /** Reads the PR's own file list for readiness item 9; absent means that comparison is not made. */
  prFiles?: ((ref: string) => Promise<string[] | null>) | undefined;
};

export type CompleteManagedReviewResult = {
  manifest: ManagedReviewManifest;
  /**
   * The learning notes this close wrote, and the dismissals it refused to write
   * one for (flow 207 AC5/AC6).
   */
  reviewNotes: ReviewNoteResult;
  /**
   * What the package's findings read AFTER this close, counted off disk.
   *
   * Returned so the caller can report the state instead of asserting it. The
   * dispositions this invocation passed are only part of the answer: a package
   * is dispositioned across as many closes as it takes, and the ones recorded
   * earlier are just as recorded.
   */
  dispositions: FindingDispositionTally;
  /** The waiver this close recorded for files no reviewer covered; absent when none was passed or nothing was uncovered. */
  coverageWaiver?: CoverageWaiver;
  /** The readiness checklist this close passed, with any items the operator waived. */
  readiness?: ReadinessReport;
  /** Things the close let through that a current package would have been refused for. */
  warnings: string[];
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
): Promise<CompleteManagedReviewResult> {
  const packageDir = await resolveReviewPackagePath(cwd, ref);
  const manifestPath = path.join(packageDir, "manifest.json");
  const stored = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  const missing = await missingArtifacts(packageDir);
  if (missing.length > 0) {
    throw new Error(`Cannot complete managed review; missing artifacts: ${missing.join(", ")}`);
  }
  // Flow 458: the round record decides what the round reviewed; one edited after `review start` is refused here too.
  const tampered = roundRecordTampered(packageDir);
  if (tampered !== undefined) throw new Error(`Cannot complete managed review; ${tampered}`);
  const warnings: string[] = [];
  let manifest = stored;
  if (options.head !== undefined) {
    if (!isPrBound(stored.target)) {
      throw new Error(`--head applies to a pull request package; ${stored.reviewId} targets a ${stored.target.kind}.`);
    }
    const head = options.head.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(head)) {
      throw new Error(`--head "${options.head}" is not a commit SHA. Give the commit this round ran against, 7-40 hex characters.`);
    }
    const recordedHead = stored.target.head;
    if (typeof recordedHead === "string" && recordedHead !== "" && !recordedHead.toLowerCase().startsWith(head) && !head.startsWith(recordedHead.toLowerCase())) {
      warnings.push(`--head ${head.slice(0, 7)} replaces the head recorded when the round started (${recordedHead.slice(0, 7)}); the manifest now records ${head.slice(0, 7)}`);
    }
    manifest = { ...stored, target: { ...stored.target, head } };
  }
  const reportText = await readFile(path.join(packageDir, "report.md"), "utf8");
  if (options.prLookup !== undefined) warnings.push(...(await completeHeadGate({ manifest, report: withoutPartialHeader(reportText), lookup: options.prLookup })).warnings);
  const evidence = parseEvidenceLevel(reportText);
  if (!evidence.ok) {
    const problem = `the report's evidence level is missing or invalid: ${evidence.reason}`;
    if (manifest.report_fields?.includes(REPORT_FIELD_EVIDENCE_LEVEL)) {
      throw new Error(`Cannot complete managed review; ${problem}. Add a line \`Evidence level: static only — did not run: <what>\` or \`Evidence level: ran — <what>\` to report.md`);
    }
    warnings.push(`${problem} (this package predates the field, so it is a warning)`);
  }
  // A warning, never a refusal: leftovers (Not run candidates, held severities, open follow-ups) the report does not name.
  warnings.push(...(await packageParityWarnings(packageDir, reportText).catch(() => [])));
  warnings.push(...(await packageCoverageWarnings(packageDir)));
  // Variant A (poll 283): a pass finding the round does not hold is said, in the output and in report.md, never refused.
  const passGap = await passNotInRound(packageDir).catch(() => null);
  const passMissing = passGap?.missing ?? [];
  if (passMissing.length > 0) warnings.push(missingWarning(passMissing));
  const researchFindings = JSON.parse(await readFile(path.join(packageDir, "findings.json"), "utf8"));
  // The waiver is written first because the coverage gate reads it from research.json; a close that then fails takes it back,
  // so the next run does not pass the same gate without the flag.
  const researchPath = path.join(packageDir, "research.json");
  const researchBefore = options.waiveCoverage === undefined ? undefined : await readFile(researchPath, "utf8").catch(() => undefined);
  let coverageWaiver: CoverageWaiver | undefined;
  let readiness: ReadinessReport | undefined;
  let updated: ManagedReviewManifest;
  const waiverBackup = (options.waiveReadiness ?? []).length === 0 ? undefined : { manifest: await readFile(manifestPath, "utf8"), report: reportText };
  try {
    coverageWaiver = options.waiveCoverage === undefined ? undefined : await recordCoverageWaiver(packageDir, options.waiveCoverage, options.now);
    for (const waiver of options.waiveReadiness ?? []) {
      await waiveReadiness(packageDir, waiver.items, waiver.quote, { prFiles: options.prFiles, headChecked: options.prLookup !== undefined, ...(options.now === undefined ? {} : { now: options.now }) });
    }
    if ((options.waiveReadiness ?? []).length > 0) manifest = { ...(JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest), ...(options.head === undefined ? {} : { target: manifest.target }) };
    const waivedRadius = (manifest.readiness_waivers ?? []).some((waiver) => ["files-covered", "blast-radius", "reviewers", "ledger"].includes(waiver.item));
    // The operator's quoted waiver of one of these items replaces the research gate's refusal for it; the checklist below still names it.
    const researchProblems = waivedRadius ? [] : await packageResearchErrors(packageDir, manifest.artifacts, researchFindings);
    if (researchProblems.length) {
      throw new Error(`Cannot complete managed review; ${researchProblems.join("; ")}`);
    }
    readiness = await computeReadiness(packageDir, { prLookup: options.prLookup, prFiles: options.prFiles, headChecked: options.prLookup !== undefined });
    if (readiness.verdict !== "READY") throw new Error(readinessRefusal(readiness, "complete the review"));
    const dispositions = options.dispositions ?? [];
    if (dispositions.length > 0) {
      await recordDispositions(packageDir, dispositions);
    }
    updated = {
      ...manifest,
      status: "closed",
      updatedAt: new Date().toISOString(),
    };
    const validation = await validateManagedReviewManifest(cwd, updated);
    if (!validation.valid) {
      throw new Error(`Invalid managed review manifest: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
    }
    await writeFileAtomic(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
    // Before the round is recorded as finished, because the registry hashes the package.
    const marked = upsertMissingSection(reportText, passMissing);
    if (marked !== reportText) await writeFileAtomic(path.join(packageDir, "report.md"), marked);
  } catch (error) {
    // Any failure before the manifest is closed takes the waiver back, so the next plain close meets the gate again.
    if (researchBefore !== undefined) await writeFileAtomic(researchPath, researchBefore).catch(() => undefined);
    if (waiverBackup !== undefined) {
      await writeFileAtomic(manifestPath, waiverBackup.manifest).catch(() => undefined);
      await writeFileAtomic(path.join(packageDir, "report.md"), waiverBackup.report).catch(() => undefined);
    }
    throw error;
  }
  await clearActiveReview(resolveProjectRoot(cwd), updated.reviewId);
  // Flow 458: keryx's own record that it finished this round, outside the repository, so a later round on this machine
  // can trust the package even after it is committed on the branch under review (./round-registry.ts).
  const registered = recordFinishedRound(packageDir, "complete", { cwd });
  if (registered.error !== undefined) warnings.push(`round not recorded in the local round registry (${registered.error}): a later round on this machine trusts this package only while no commit of the branch changes it`);

  // Flow 207 AC5, the second of the two places a `dismissed-incorrect` becomes
  // durable. This one is the attended path by construction: somebody ran
  // `keryx review complete --finding <id> --disposition dismissed-incorrect
  // --evidence <where the decision is written down>`.
  //
  // Read back off disk rather than from `dispositions`, so a finding dismissed
  // by an EARLIER close — or by the ingest, in `filter` mode — is not silently
  // skipped when a later close touches a different finding. The note file is
  // named after the round and the finding, so re-closing overwrites its own note
  // instead of accumulating one per invocation.
  const recorded = JSON.parse(await readFile(path.join(packageDir, "findings.json"), "utf8")) as StructuredReviewFinding[];
  const reviewNotes = await writeReviewNotes(recorded, {
    cwd,
    reviewId: updated.reviewId,
    head: updated.target.head ?? null,
    packagePath: path.relative(cwd, packageDir),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return { manifest: updated, reviewNotes, dispositions: tallyDispositions(recorded), warnings, ...(coverageWaiver === undefined ? {} : { coverageWaiver }), ...(readiness === undefined ? {} : { readiness }) };
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
    return path.join(flowReviewsRoot(cwd, flowMatch.dir), reviewId);
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
  filterStats: ReviewFilterStats;
  repairs: FindingRepair[];
}): ManagedReviewManifest {
  // Flow 209 AC2. Written only when the caller supplied one: the property is
  // omitted rather than set to `null`, so `keryx review status` can tell "nobody
  // ran the decision" from "the decision was single-family". A `null` here would
  // collapse those two into one and reproduce the defect the block was added to
  // measure.
  const crossFamily = args.input.crossFamilyReview;
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
    filter_stats: args.filterStats,
    // Written only when something was repaired. An empty array on every package
    // would say "a repair pass ran and did nothing" on records where the
    // distinction never arose — the same rule `cross_family_review` above
    // follows, and for the same reason.
    ...(args.repairs.length === 0 ? {} : { repairs: args.repairs }),
    // Marks a package whose report must carry an evidence level; one without the mark predates the field and only gets a warning.
    report_fields: [REPORT_FIELD_EVIDENCE_LEVEL],
    // Same rule: absent means nobody reported, which is not the same as zero.
    ...(args.input.cost === undefined ? {} : { cost: args.input.cost }),
    ...(crossFamily === undefined ? {} : { cross_family_review: crossFamily }),
    ...(args.input.automatic === true ? { automatic: true as const } : {}),
    ...(args.input.mode === "review-flow"
      ? { cleanContext: { startedAt: args.at, ...(args.input.memoryQuery === undefined ? {} : { memoryQuery: args.input.memoryQuery }) } }
      : {}),
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

/**
 * Flow 460 F: the reviewers a research record says were dispatched (its typed `dispatch.runs`), with the status each
 * ended in. With a research record and no explicit `--reviewers`, coverage lists these rather than a stand-in
 * orchestrator that never reviewed.
 */
function coverageFromResearch(runs: readonly DispatchRun[]): ReviewCoverageEntry[] {
  const seen = new Set<string>();
  const entries: ReviewCoverageEntry[] = [];
  for (const { reviewer, status, routedOut, notRunReason, executionReason } of runs) {
    if (seen.has(reviewer)) continue;
    seen.add(reviewer);
    // A routed-out role is recorded complete but was never dispatched: coverage.md says so rather than "dispatched".
    if (status === "complete" && routedOut === true) entries.push({ reviewer, status: "run", reason: "routed out: slice routing gave this role no slice, so it was not dispatched" });
    else if (status === "complete") entries.push({ reviewer, status: "run", reason: "dispatched; the research ledger records it complete" });
    else if (status === "incomplete") entries.push({ reviewer, status: "needs_context", reason: `dispatched; the research ledger records it incomplete${executionReason === undefined ? "" : ` (${executionReason})`}` });
    else if (status === "not-run" || status === undefined) entries.push({ reviewer, status: "failed", reason: `not run: ${notRunReason ?? "the research ledger records no result"}` });
    // A status the ledger never writes (a typo, a hand edit) is not a "not run": it says what was found.
    else entries.push({ reviewer, status: "failed", reason: `unrecognised status "${status}" in the research ledger; re-run \`keryx review ledger build\`` });
  }
  return entries;
}

/**
 * The reviewer a finding with no reviewer of its own is attributed to, when the operator named none. It becomes coverage's
 * one entry only when there is nothing better to list: no --coverage, no --reviewers and no dispatch record.
 */
const ATTRIBUTION_FALLBACK = "review-orchestrator";

/** coverage.md's entries: --coverage as given, else the dispatch record (no --reviewers), else the named reviewers, else the fallback. */
function normalizeCoverage(coverage: ReviewCoverageEntry[] | undefined, reviewers: string[] | undefined, runs: readonly DispatchRun[]): ReviewCoverageEntry[] {
  if (coverage && coverage.length > 0) {
    return coverage;
  }
  const named = reviewers !== undefined && reviewers.length > 0;
  if (!named) {
    const fromResearch = coverageFromResearch(runs);
    if (fromResearch.length > 0) return fromResearch;
  }
  const selected = named ? reviewers : [ATTRIBUTION_FALLBACK];
  return selected.map((reviewer) => ({
    reviewer,
    status: "run",
    reason: "selected for managed review package",
  }));
}

/** The report `review start` writes before any reviewer has run: a placeholder, never a round's result. */
const STUB_REPORT_LINE = "No reviewer findings recorded yet.";
const STUB_REPORT = `# Managed Review Report\n\n${STUB_REPORT_LINE}\n`;

async function readReport(input: ManagedReviewInput): Promise<string> {
  if (input.reportText !== undefined) {
    return input.reportText;
  }
  if (input.reportPath) {
    try {
      return await readFile(path.resolve(input.cwd, input.reportPath), "utf8");
    } catch (error) {
      // `start` opens a round before any report exists: a report path that is not there yet is the normal case.
      const code = (error as NodeJS.ErrnoException).code;
      if (input.mode === "ingest" || (code !== "ENOENT" && code !== "EISDIR")) throw error;
    }
  }
  if (input.mode === "ingest") {
    throw new Error("ingest requires --report or reportText");
  }
  return STUB_REPORT;
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
async function normalizeFindings(args: NormalizeFindingsArgs): Promise<{ findings: NormalizedReviewFinding[]; from: "input" | "block" | "prose" }> {
  if (args.source !== undefined) {
    return { findings: triage(fromStructuredSource(args.source, args.reviewers), args), from: "input" };
  }
  // PRESENCE, not the parsed value. Branching on the value cannot tell "no
  // block" from "a block holding null", and both then fell through to the prose
  // parser without a word — the silent degradation the fenced block exists to
  // prevent. `parseEmbeddedFindings` returns null only when no fence is there.
  const structured = parseEmbeddedFindings(args.report, args.reportLabel);
  if (structured !== null) {
    return { findings: triage(fromStructuredSource(structured, args.reviewers), args), from: "block" };
  }
  return { findings: triage(parseLegacyReport(args.report, args.reviewers), args), from: "prose" };
}

/**
 * The reviewers a finding that names none is attributed to: what the operator gave (--coverage entries that ran, else
 * --reviewers), else the orchestrator — never the research record, where one finished reviewer must not absorb the
 * orchestrator's findings.
 */
function attributionReviewers(input: ManagedReviewInput): string[] {
  if (input.coverage !== undefined && input.coverage.length > 0) return input.coverage.filter((entry) => entry.status === "run").map((entry) => entry.reviewer);
  return input.reviewers !== undefined && input.reviewers.length > 0 ? [...input.reviewers] : [ATTRIBUTION_FALLBACK];
}

/**
 * Flow 460: the round refusals that run before anything is located, verified, merged or written — a stub report, and a
 * display id holding `#` (which would mint a global_id the schema refuses, after the whole round was processed).
 */
function refuseUnacceptableRound(input: ManagedReviewInput, report: string, from: "input" | "block" | "prose", findings: readonly { id?: unknown }[]): void {
  refuseStubReport(input, report, from, findings.length);
  const hashed = hashedDisplayIds(findings.map((finding) => finding.id));
  if (hashed.length > 0) {
    throw new Error(`Refusing to ingest: ${hashedDisplayIdMessage(hashed, from === "input" ? "--findings" : reportLabel(input))} Nothing was written.`);
  }
}

/** Whether a report's text is a stub: empty, or the placeholder `review start` writes (whatever surrounds it). */
export function isStubReportText(report: string): boolean {
  const text = report.trim();
  return text === "" || text.includes(STUB_REPORT_LINE);
}

/**
 * Flow 460: `review ingest` of a stub — an empty report, or the placeholder `review start` writes into a package before
 * any reviewer ran — that carries no `keryx:findings` block and no finding, with no `--findings` either, is not a clean
 * round: ingesting it would record a reviewed round that found nothing. Refused before anything is written. A round
 * that really found nothing says so in its own report, or with an empty block. (A prose report of an older round that
 * found nothing is not a stub and still ingests.)
 */
function refuseStubReport(input: ManagedReviewInput, report: string, from: "input" | "block" | "prose", findings: number): void {
  if (input.mode !== "ingest" || from !== "prose" || findings > 0) return;
  if (!isStubReportText(report)) return;
  throw new Error(
    `Refusing to ingest ${reportLabel(input)}: it is ${report.trim() === "" ? "empty" : `the placeholder \`review start\` writes ("${STUB_REPORT_LINE}")`}, with no \`\`\`json keryx:findings block and no finding, so it is a stub, not a round's report. Point --report at the consolidated report (with its keryx:findings block), pass --findings <file>, or, for a round that found nothing, add an empty block (\`\`\`json keryx:findings / [] / \`\`\`). Nothing was written.`,
  );
}

function triage(
  findings: Array<StructuredReviewFinding & { summary: string; class_scope_present?: boolean | undefined }>,
  args: Pick<NormalizeFindingsArgs, "mode" | "attachedToFlow">,
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

/**
 * Replace every quoted finding's reported line with the line its quote is on.
 *
 * Runs over the round's own tree (`input.cwd`), which for an ingest at the
 * round's head IS the head — and when it is not, the locator says so rather
 * than guessing: a quote that no longer appears reads `unlocatable`, which is
 * the honest answer for a report ingested against a moved tree.
 *
 * `readTreeFile` is injectable so a test can state a tree in a map instead of
 * on disk; production reads the working tree.
 */
async function anchorFindings(
  findings: Array<StructuredReviewFinding & { summary: string }>,
  input: ManagedReviewInput,
  head: string | null,
): Promise<void> {
  const read =
    input.readTreeFile ??
    // AT THE HEAD THE ROUND RECORDS, not at whatever the tree happens to hold.
    //
    // This is the defect the mechanism found in its own first use. The round on
    // PR #560 was ingested after its fix commit had rewritten the very lines
    // the findings quoted, and five of six quotes came back `unlocatable` — a
    // true statement about the working tree and a useless one about the round.
    // Re-checked against the recorded head, all six located. The historical
    // audit had already measured the same shape from the other side: 108 of 582
    // recorded anchors name a file absent at their own package's head.
    //
    // A round is a claim about a commit. Locating it anywhere else answers a
    // question nobody asked.
    (head === null
      ? readFromWorkingTree(input)
      : async (relative: string): Promise<string | null> => {
          // Contained by spelling, not by the working tree: the file only has to exist
          // at the head, and `git show` reads a blob without following a link, so a
          // symlink in the tree cannot lead the read outside it.
          const contained = lexicalRelativePath(relative);
          return contained === null ? null : readFileAtCommit(input.cwd, head, contained);
        });
  for (const finding of findings) {
    const locator = await locateFinding(finding, read);
    // Recomputed on every ingest: a flag carried in from a previous round describes a check that is re-made here.
    delete finding.quote_unlocated;
    if (locator === undefined) {
      // No quote, so nothing was checked — and a locator carried in from a
      // previous round describes a check that did not happen this time. Round
      // N+1 echoing a finding out of `prior_findings` brings the old pair with
      // it, and leaving it would write an unverified line under a record that
      // claims every line is derived. Clearing it makes "no quote means no
      // locator" true of the record, not just of the happy path.
      delete finding.locator;
      continue;
    }
    if (locator.state === "derived") {
      finding.line = locator.line;
      finding.locator = {
        state: "derived",
        method: locator.method,
        ...(locator.reported_line === undefined ? {} : { reported_line: locator.reported_line }),
      };
      continue;
    }
    // Null, not the reported number. A line nobody could confirm is worse than
    // no line: it is acted on, and the acting is where the cost lands.
    finding.line = null;
    finding.locator = {
      state: "unlocatable",
      reason: locator.reason,
      ...(locator.reported_line === undefined ? {} : { reported_line: locator.reported_line }),
    };
    // Flow 460: a quote that is absent from its file, or in it more than once, is kept unanchored and flagged, never
    // relocated by similarity or proximity. The flag is what scope.md and readiness item `quotes-located` read.
    if (finding.source !== "external" && (locator.kind === "absent" || locator.kind === "ambiguous")) {
      finding.quote_unlocated = {
        reason: locator.kind,
        ...(locator.kind === "ambiguous" && locator.candidates !== undefined ? { candidate_lines: [...locator.candidates] } : {}),
      };
    }
  }
}

/** Whether `git cat-file -e <spec>` succeeds in `cwd`. */
async function gitObjectExists(cwd: string, spec: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "cat-file", "-e", ...revisionOperand(spec)], { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Rule (two cases, deliberately different): a FINDING's own `file` that is absent at the reviewed head is kept and flagged
 * `path_missing` here. A CITATION or verification evidence naming a file absent at the SHA is still refused (`citationExists`).
 *
 * Flow 458 AC12: a finding whose `file` does not exist at the reviewed head is marked `path_missing` (and listed in
 * `scope.md`), never dropped. Skipped when the round records no head, when the head is not in this checkout (nothing could
 * be established), or when a test injects the tree. External comments keep the path GitHub gave them.
 */
async function flagMissingPaths(
  findings: Array<StructuredReviewFinding & { summary: string }>,
  input: ManagedReviewInput,
  head: string | null,
): Promise<void> {
  if (head === null || input.readTreeFile !== undefined) return;
  if (!(await gitObjectExists(input.cwd, `${head}^{commit}`))) return;
  for (const finding of findings) {
    if (finding.source === "external" || typeof finding.file !== "string" || finding.file.trim() === "") continue;
    const relative = lexicalRelativePath(finding.file.trim().replace(/:\d+(?:[-:]\d+)*$/, ""));
    if (relative === null || !(await gitObjectExists(input.cwd, `${head}:${relative}`))) finding.path_missing = true;
    else delete finding.path_missing;
  }
}

/** `## Paths missing at the reviewed head`: the findings flagged `path_missing`, or an empty string when there are none. */
function renderPathMissingMarkdown(findings: readonly StructuredReviewFinding[]): string {
  const missing = findings.filter((finding) => finding.path_missing === true);
  if (missing.length === 0) return "";
  const lines = missing.map((finding) => `- ${finding.global_id ?? finding.id} (${finding.reviewer}): ${finding.file ?? "(no file)"}`);
  return `\n## Paths missing at the reviewed head\n\n${missing.length} finding(s) cite a file that does not exist at the reviewed head. They are kept, flagged \`path_missing\` in findings.json; check the path before acting on them.\n\n${lines.join("\n")}\n`;
}

/** `## Quotes not located at the reviewed head`: the findings flagged `quote_unlocated`, or an empty string when there are none. */
function renderQuoteUnlocatedMarkdown(findings: readonly StructuredReviewFinding[]): string {
  const unlocated = findings.filter((finding) => finding.quote_unlocated !== undefined);
  if (unlocated.length === 0) return "";
  const lines = unlocated.map((finding) => `- ${finding.global_id ?? finding.id} (${finding.reviewer}): ${finding.file ?? "(no file)"}: ${quoteUnlocatedText(finding.quote_unlocated)}`);
  return `\n## Quotes not located at the reviewed head\n\n${unlocated.length} finding(s) quote code that could not be placed in their file. They are kept with no line (never relocated by similarity), flagged \`quote_unlocated\` in findings.json, and readiness item \`quotes-located\` lists them until each has a disposition or the operator waives it.\n\n${lines.join("\n")}\n`;
}

/** "absent from the file" / "ambiguous (candidate lines 2, 10)". */
export function quoteUnlocatedText(flag: StructuredReviewFinding["quote_unlocated"]): string {
  if (flag === undefined) return "";
  if (flag.reason === "absent") return "the quote is absent from the file";
  const candidates = flag.candidate_lines ?? [];
  return `the quote is ambiguous${candidates.length === 0 ? "" : ` (candidate lines ${candidates.join(", ")}, and the scan stopped there)`}`;
}

/**
 * A round is a claim about a commit. Where the commit is known and an internal
 * finding's quote could not be CHECKED there, refuse the ingest and name each one.
 * Flow 460: a quote that was checked and is absent from its file, or in it more than
 * once, is not refused any more: it is kept unanchored and flagged `quote_unlocated`
 * (see {@link anchorFindings}), so one bad quote no longer costs the whole round.
 * What still refuses is what could not be checked at all: the commit is not in this
 * checkout, the finding quotes code but names no file, or a size bound stopped the
 * match. Findings the round already dismissed, external comments and findings
 * without a quote are not asked to resolve.
 */
function refuseUnresolvedLocators(
  findings: ReadonlyArray<StructuredReviewFinding & { summary: string }>,
  input: ManagedReviewInput,
  head: string | null,
): void {
  if (head === null || input.readTreeFile !== undefined) {
    return;
  }
  const unresolved = findings.filter(
    (finding) =>
      finding.source !== "external" &&
      finding.disposition === undefined &&
      finding.locator?.state === "unlocatable" &&
      finding.path_missing !== true &&
      finding.quote_unlocated === undefined,
  );
  if (unresolved.length === 0) {
    return;
  }
  const lines = unresolved.map((finding) => {
    const locator = finding.locator?.state === "unlocatable" ? finding.locator : undefined;
    const line = locator?.reported_line ?? null;
    return `  - ${finding.id ?? finding.summary} (${finding.file}${line === null ? "" : `:${line}`}): ${locator?.reason ?? ""}`;
  });
  throw new Error(
    `Cannot ingest review; ${unresolved.length} finding(s) cite a quote that could not be checked at the reviewed SHA ${head.slice(0, 12)}:\n${lines.join("\n")}\nCauses: the commit is not in this checkout (check \`git cat-file -e ${head.slice(0, 12)}\`), the finding quotes code but names no file, or a size bound stopped the match. (A quote that is absent from its file or in it more than once is not refused: it is kept, flagged quote_unlocated.) Re-quote one distinct line from \`git show ${head.slice(0, 7)}:<path>\` or dismiss the finding with evidence.`,
  );
}

/** Whether a cited document is in the tree at the reviewed commit or as the tree stands. */
async function citationExists(cwd: string, head: string | null, cited: string): Promise<boolean> {
  const relative = lexicalRelativePath(cited);
  if (relative === null) {
    return false;
  }
  if (head !== null && (await readFileAtCommit(cwd, head, relative)) !== null) {
    return true;
  }
  return lstat(path.resolve(cwd, relative)).then(
    () => true,
    () => false,
  );
}

/** `relative` normalised to a path inside the tree, or null when it climbs out or is absolute. */
export function lexicalRelativePath(relative: string): string | null {
  const normalised = path.posix.normalize(relative.replace(/\\/g, "/"));
  if (normalised === "." || normalised === ".." || normalised.startsWith("../") || path.posix.isAbsolute(normalised)) {
    return null;
  }
  return normalised;
}

/** One file as it stood at `commit`, or null. */
async function readFileAtCommit(cwd: string, commit: string, relative: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "show", `${commit}:${relative}`], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0 || stdout.length > MAX_LOCATE_FILE_BYTES) {
      return null;
    }
    return stdout;
  } catch {
    return null;
  }
}

/** The fallback when the round records no commit: the tree as it stands. */
function readFromWorkingTree(input: ManagedReviewInput): (relative: string) => Promise<string | null> {
  return async (relative: string): Promise<string | null> => {
      // Contained to the round's tree, and contained against the FILE SYSTEM
      // rather than against the string.
      //
      // The first version compared resolved paths with `startsWith`, which
      // inspects only the spelling. A symlink whose name sits inside the tree
      // and whose target does not — `src/link -> /etc/passwd`, plantable by
      // anyone who can add a file to the branch under review — passed that
      // check, and `readFile` then followed it. Worse than a read: because the
      // locator records `derived` or `unlocatable`, a finding's quote becomes a
      // line-by-line oracle for any file the ingest process can open. Found by
      // this change's own review round, reproduced against `/etc/passwd`.
      //
      // `realpath` is therefore taken on both sides before comparing. A path
      // that cannot be resolved does not exist, which is already `null`.
      const root = await realpath(input.cwd).catch(() => path.resolve(input.cwd));
      const resolved = path.resolve(root, relative);
      const real = await realpath(resolved).catch(() => null);
      if (real === null || (real !== root && !real.startsWith(`${root}${path.sep}`))) {
        return null;
      }
      try {
        // Size is bounded here rather than inside the matcher: locating is
        // O(file lines x quote lines), so an unbounded file is an unbounded
        // round. A lockfile is a real, ordinary example of a large file a
        // finding could name.
        const info = await stat(real);
        if (!info.isFile() || info.size > MAX_LOCATE_FILE_BYTES) {
          return null;
        }
        return await readFile(real, "utf8");
      } catch {
        return null;
      }
  };
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
  // The quote is what `line` was derived FROM, so a record carrying a derived
  // line without it would be a number no later reader could re-check. They are
  // written as a pair or not at all.
  if (finding.quote !== undefined) {
    record.quote = finding.quote;
  }
  if (finding.locator !== undefined) {
    record.locator = finding.locator;
  }
  if (finding.path_missing === true) {
    record.path_missing = true;
  }
  if (finding.quote_unlocated !== undefined) {
    record.quote_unlocated = finding.quote_unlocated;
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
  // Flow 459, same rule: written only when a premise judge actually ruled. A held finding without this field would
  // read as an ordinary open one, so the projection must not drop it.
  if (finding.premise !== undefined) {
    record.premise = finding.premise;
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
  // Written by the duplicate merge only, as a pair.
  if (finding.reported_by !== undefined && finding.reported_by.length > 1) {
    record.reported_by = finding.reported_by;
  }
  if (finding.merged_from !== undefined && finding.merged_from.length > 0) {
    record.merged_from = finding.merged_from;
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

/**
 * How many findings in a package have had an outcome recorded, and how many
 * have not.
 *
 * `recorded` counts every state except `unknown`, because every other state in
 * {@link FINDING_DISPOSITION_STATES} is terminal: the finding was acted on,
 * dismissed for a named reason, or answered in disagreement. There is no
 * in-progress disposition, so "not `unknown`" and "terminal" are the same set.
 *
 * This exists because the CLI used to ASSERT the all-unknown case instead of
 * counting it — `review complete` with no disposition flags printed "every
 * finding in this package still reads `unknown`" without reading the package,
 * so a round that had dispositioned all 18 of its findings in earlier
 * invocations was told nobody had recorded anything. A field whose whole job is
 * to make an unrecorded outcome visible cannot be reported by a sentence that
 * did not look.
 */
export type FindingDispositionTally = {
  total: number;
  /** Findings carrying a terminal disposition — anything but `unknown`. */
  recorded: number;
  /** Findings reading `unknown`, whether written so or absent entirely. */
  unknown: number;
};

export function tallyDispositions(
  findings: readonly { disposition?: ReviewFindingDisposition | undefined }[],
): FindingDispositionTally {
  let unknown = 0;
  for (const finding of findings) {
    if (findingDispositionState(finding) === "unknown") {
      unknown += 1;
    }
  }
  return { total: findings.length, recorded: findings.length - unknown, unknown };
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

/**
 * Write the recorded outcomes into `findings.json`, or refuse and write nothing. The read-modify-write runs under the
 * package's decisions lock, the one a premise answer holds while it rewrites findings.json (review F-001/HL2-002): an
 * answer and a disposition that overlap both land.
 */
async function recordDispositions(
  packageDir: string,
  records: readonly FindingDispositionRecord[],
): Promise<void> {
  await withOperatorDecisionsLock(packageDir, () => recordDispositionsLocked(packageDir, records));
}

async function recordDispositionsLocked(
  packageDir: string,
  records: readonly FindingDispositionRecord[],
): Promise<void> {
  const findingsPath = path.join(packageDir, "findings.json");
  const findings = JSON.parse(await readFile(findingsPath, "utf8")) as StructuredReviewFinding[];
  const pending = await resolveDispositions(findings, records);
  for (const { finding, disposition } of pending) {
    finding.disposition = disposition;
  }
  await writeFileAtomic(findingsPath, `${JSON.stringify(findings, null, 2)}\n`);
}

/**
 * The checks `recordDispositions` makes, without writing: an unknown or ambiguous finding, a state that needs evidence
 * and has none, a reversal of a recorded verdict. It throws the engine's own message, so a card can refuse for the same
 * reason the close would, before the operator is asked.
 */
export async function checkDispositions(packageDir: string, records: readonly FindingDispositionRecord[]): Promise<void> {
  const findings = JSON.parse(await readFile(path.join(packageDir, "findings.json"), "utf8")) as StructuredReviewFinding[];
  await resolveDispositions(findings, records);
}

async function resolveDispositions(
  findings: StructuredReviewFinding[],
  records: readonly FindingDispositionRecord[],
): Promise<Array<{ finding: StructuredReviewFinding; disposition: ReviewFindingDisposition }>> {
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
  return pending;
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
function embeddedFence(tag: "findings" | "premises"): RegExp {
  return new RegExp("^ {0,3}(`{3,}|~{3,})[^\\n]*\\bkeryx:" + tag + "\\b[^\\n]*$", "gm");
}

/**
 * The body of the one `keryx:<tag>` block in `text`, or undefined when there is none. More than one throws, worded by
 * `tooMany` from the blocks' character offsets: keeping the first would silently drop every block after it.
 */
function singleEmbeddedBlock(text: string, tag: "findings" | "premises", tooMany: (offsets: number[]) => string): string | undefined {
  const fences = [...text.matchAll(embeddedFence(tag))];
  if (fences.length > 1) throw new Error(tooMany(fences.map((fence) => fence.index ?? 0)));
  const fence = fences[0];
  return fence === undefined ? undefined : embeddedBlockBody(text, fence);
}

/**
 * The one `keryx:findings` block in a report, or null when there is none.
 *
 * Every other outcome throws. A block that is present but does not yield a
 * findings payload is a producer bug, and the one thing that must never happen
 * is what used to: falling back to the prose parser while the report visibly
 * carries the structured array its author expected to be read.
 */
export function parseEmbeddedFindings(report: string, reportLabel: string): ReviewFindingsSource | null {
  // An orchestrator that concatenates one block per reviewer produces several, and the non-global match used to keep
  // the first and drop the rest: a report visibly holding findings ingested as zero.
  const body = singleEmbeddedBlock(
    report,
    "findings",
    (offsets) =>
      `${reportLabel} carries ${offsets.length} keryx:findings blocks (at character ${offsets.join(" and ")}); exactly one is allowed. Concatenating one block per reviewer drops every block after the first — merge them into a single array.`,
  );
  if (body === undefined) {
    return null;
  }
  const parsed = parseJsonBody(body, (detail) => `${reportLabel} carries a keryx:findings block that is not valid JSON: ${detail}`);
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

/**
 * `--premises` input (flow 459): the bare `{ judge, model?, premises }` object, or a report / judge reply that carries it
 * in one fenced `keryx:premises` block (what the review-premise skill prints). Anything else throws, and a block that is
 * present but not valid JSON is an error, never a silent fall-through. The parsed value is not shape-checked here.
 */
export function parseEmbeddedPremises(text: string, label: string): unknown {
  const body = singleEmbeddedBlock(text, "premises", (offsets) => `${label} carries ${offsets.length} keryx:premises blocks; exactly one is allowed. Nothing was merged.`);
  return body === undefined
    ? parseJsonBody(text, (detail) => `${label} is neither JSON nor a report with a keryx:premises block: ${detail}. Nothing was merged.`)
    : parseJsonBody(body, (detail) => `${label} carries a keryx:premises block that is not valid JSON: ${detail}. Nothing was merged.`);
}

/** `JSON.parse(body)`, or an error worded by `message` from the parser's own detail (never the raw caught value). */
function parseJsonBody(body: string, message: (detail: string) => string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Preserve the sanitized public diagnostic without exposing the raw caught value or stack.
    throw new Error(message(error instanceof Error ? error.message : String(error)));
  }
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

/** The optional blocks of scope.md, by name. */
type ScopeExtras = {
  externalReclaims?: readonly ExternalReclaim[] | undefined;
  scopeBScreen?: ScopeBScreenRecord | undefined;
  filterStats?: ReviewFilterStats | undefined;
  allFindings?: readonly StructuredReviewFinding[] | undefined;
};

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
  extras: ScopeExtras = {},
): string {
  const { externalReclaims = [], scopeBScreen = { source: "none", scopeBFindings: 0 }, filterStats, allFindings = [] } = extras;
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

${renderCapsMarkdown(caps)}
${renderScopeBScreenMarkdown(scopeBScreen)}${
    filterStats === undefined ? "" : `\n${renderFilterStatsMarkdown(filterStats)}`
  }${renderExternalReclaimsMarkdown(externalReclaims)}${renderPathMissingMarkdown(allFindings)}${renderQuoteUnlocatedMarkdown(allFindings)}`;
  return carriedPreFilter === undefined ? head : `${head.trimEnd()}\n\n${carriedPreFilter}\n`;
}

/**
 * The AC3 screen, on the record next to the caps that removed findings beside it.
 *
 * A screen that drops findings silently is the failure mode this whole programme
 * exists to end, so the block is written on every ingest — including the one
 * where the screen did not run, which says so in those words rather than
 * printing `rejected: 0`.
 */
const BLAST_RADIUS_RECORD_SOURCE: Record<ScopeBScreenRecord["source"], string> = {
  input: "supplied by the caller (--blast-radius)",
  handoff: `read from ${BLAST_RADIUS_ARTIFACT} in the reviews root, and consumed`,
  package: `read from ${BLAST_RADIUS_ARTIFACT} in this package`,
  none: "none",
};

function renderScopeBScreenMarkdown(record: ScopeBScreenRecord): string {
  const screen = record.screen;
  if (screen === undefined) {
    return [
      "## Scope B rejections",
      "",
      "not recorded — no blast-radius record reached this ingest, so the scope-B screen",
      "did not run. No finding in this package was raised under scope B; had one been,",
      "the ingest would have been refused rather than recorded unscreened.",
      "",
    ].join("\n");
  }
  // `scope_b_exempted` is repeated here rather than left to the shared renderer
  // alone because this block is the one a completion gate reader opens: a
  // finding admitted without `no-link-to-change` being applied reaches
  // `findings.json` and blocks completion until dispositioned, and the reader
  // is owed the reason next to the count of what the screen saw.
  return `${renderBlastRadiusScreenMarkdown(screen)}scope_b_findings: ${record.scopeBFindings}\nscope_b_exempted: ${
    screen.exempted.length
  }\nblast_radius_record: ${BLAST_RADIUS_RECORD_SOURCE[record.source]}\n`;
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
  return renderCoverageMd(coverage);
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
    const packageDir = packagePath(input.cwd, input.mode, input.reviewId, flowMatch);
    // Flow 460: `review ingest --flow <id> --review-id <id>` of a package `review start` opened under the reviews root
    // binds THAT package to the flow (the manifest records `flow`) instead of opening a second, empty-handed one in the
    // flow's directory; a re-ingest of a package already bound to that flow stays there. A package of that id already
    // in the flow's directory is ingested into as before, and a reviews-root directory that is neither is not touched.
    if (input.mode === "ingest" && flowMatch !== null) {
      const standalone = path.join(reviewsRoot(input.cwd), input.reviewId);
      const recorded = await readManifestHead(standalone);
      if (!(await pathExists(packageDir)) && (recorded?.mode === "review-flow" || recorded?.flowId === flowMatch.id)) {
        return { reviewId: input.reviewId, packageDir: standalone };
      }
    }
    return { reviewId: input.reviewId, packageDir };
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

export async function resolveReviewPackagePath(cwd: string, ref: string): Promise<string> {
  const absolute = path.resolve(cwd, ref);
  if (await pathExists(path.join(absolute, "manifest.json"))) {
    return absolute;
  }
  if (await pathExists(absolute) && absolute.endsWith("manifest.json")) {
    return path.dirname(absolute);
  }

  const [first] = await reviewPackagesNamed(cwd, ref);
  if (first !== undefined) {
    return first;
  }
  throw new Error(`Managed review package not found: ${ref}`);
}

/**
 * Every package a review id names, in the order {@link resolveReviewPackagePath} prefers them: the standalone one (a
 * directory with a manifest.json under the reviews root), then each flow's directory of that name, in flow order. The
 * one lookup of a package by id; more than one entry means the id is ambiguous.
 */
async function reviewPackagesNamed(cwd: string, ref: string): Promise<string[]> {
  const found: string[] = [];
  const standalone = path.join(reviewsRoot(cwd), ref);
  if (await pathExists(path.join(standalone, "manifest.json"))) {
    found.push(standalone);
  }
  for (const flowDir of await listFlowDirs(cwd)) {
    const reviewsDir = flowReviewsRoot(cwd, flowDir);
    if (!(await pathExists(reviewsDir))) {
      continue;
    }
    for (const entry of await readdir(reviewsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === ref) {
        found.push(path.join(reviewsDir, entry.name));
      }
    }
  }
  return found;
}

/**
 * The ingest's verification claims, with each one citing a `keryx review verify-run` record of its own finding in THIS
 * ingest's package promoted to `execution` (flow 457 T7). The records are read only from `packageDir`, the directory
 * the ingest writes (review LG6-002, SEC6-001): a package of the same id elsewhere never promotes a claim, so a
 * duplicate id elsewhere needs no refusal here (review LG7-001, SEC7-001).
 */
async function ownPackageVerifications(input: ManagedReviewInput, packageDir: string): Promise<VerificationClaimInput[]> {
  const claims = input.verifications ?? [];
  if (claims.length === 0) {
    return [];
  }
  return promoteParentExecutions(claims, packageDir);
}

/**
 * The previous ingest's findings.json, for the hold carry (review LG6-001): `undefined` when there is none (a first
 * ingest), parsed JSON otherwise. One that exists but cannot be read or parsed refuses the ingest, since reading it as
 * "nothing held" would drop every hold it recorded.
 */
async function readPreviousFindings(packageDir: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path.join(packageDir, "findings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(previousFindingsUnreadable((error as NodeJS.ErrnoException).code ?? "the file could not be read"), { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(previousFindingsUnreadable(`it is not JSON (${error instanceof Error ? error.message : String(error)})`), { cause: error });
  }
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

