import { mkdir, readdir, readFile } from "node:fs/promises";
import path, { join } from "node:path";
import { optionValue } from "../lib/args";
import { pathExists, toPosix, writeFileAtomic } from "../lib/fs";
// Through the security facade, not `security/redact` directly — same
// discipline as `src/review/conform-jev.ts`/`conform-clauses.ts`.
import { redactSensitiveText } from "../security/service";
import { learnProjectSkill } from "../gdskills/learn";
import { applyReviewerProfile, parseLearnArgs } from "../learning/service";
import { loadSchema, validateJson } from "../gdskills/contracts";
import {
  learningRecordPath,
  learningSourcePath,
  loadReviewLearningConfig,
  renderLearningRecord,
  renderLearningSource,
  reviewLearningConfigPath,
  selectLearnableComments,
  type LearningSelection,
} from "../review/review-learning";
import {
  completeManagedReview,
  createManagedReviewPackage,
  getManagedReviewStatus,
  resolveGitHead,
  upsertPreFilterScopeBlock,
  type FindingDispositionRecord,
  type ManagedReviewIngestInput,
} from "../review/managed";
import { checkFilterStats, renderFilterStatsLine } from "../review/filter-stats";
import { costFrom, renderCostPerFinding, renderScopeEstimate } from "../review/cost";
import { collectReviewers, renderReviewerInventoryMarkdown } from "../review/reviewers";
import { runImportReviewers } from "../review/import-reviewers";
// flow 332: registration only. The command itself, and every helper it
// needs, lives in `review-jev-risk.ts`/`review-jev-scenarios.ts` — two NEW
// files, mirroring flow 330's `review-jev-rules.ts` note, so no other flow's
// concurrent work on this file collides with either.
import { runJevRisk } from "./review-jev-risk";
import { runJevScenarios } from "./review-jev-scenarios";
import {
  checkCrossFamilyReview,
  parseCrossFamilyReviewInput,
  renderCrossFamilyReviewLine,
} from "../review/cross-family";
import type { CrossFamilyReviewDecision } from "../lib/provider-config";
import { githubAdapter } from "../flow/tracker/github";
import {
  buildPathScope,
  buildReviewScope,
  DEFAULT_CONTEXT_LINES,
  renderReviewScopeMarkdown,
  renderScopedDiff,
  type ReviewScope,
  type ScopedRegion,
} from "../review/scope";
import { detectFloorRegressions, renderFloorMarkdown, floorCannotScan, FLOOR_FINDING_KINDS } from "../review/floor";
import { loadRoutingConfig } from "../harness/routing/config";
import { connectedPredicateFrom, describeFallbackNotice, resolveCategoryDetailed } from "../harness/routing/table";
import { resolveProviderDefaultModelId } from "../harness/routing/provider-default";
import {
  blastRadiusRecomputeDecision,
  computeBlastRadius,
  DEFAULT_BLAST_RADIUS_DEPTH,
  DEFAULT_BLAST_RADIUS_MAX_FILES,
  renderBlastRadiusDispatchBrief,
  renderBlastRadiusMarkdown,
  upsertBlastRadiusBlock,
  type BlastRadius,
  type BlastRadiusScreenInput,
} from "../review/blast-radius";
import { loadGraph } from "../gdgraph/query";
import { detectProviders } from "./select";
import { resolveCallerSession, type SessionSource } from "../lib/caller-session";
import { envWithSavedApiKeys } from "../lib/shell-config";
import {
  decideDispatchModel,
  type DiscoveredProvider,
  type DispatchModelDecision,
  type SessionModelContext,
  type TierSignals,
} from "../gdskills/model-tier";
import { TEST_FILE_RE } from "../testing/selection";
import { isVerificationMode, verificationClaims } from "../review/verification";
import {
  buildReplyPass,
  collectPrComments,
  createFixturePort,
  createGhPort,
  describePullRequest,
  externalFindingsFromComments,
  postReplyPass,
  shaMatchesHead,
  prCommentsStatePath,
  readPrCommentState,
  recordSeenComments,
  renderPrCommentsMarkdown,
  unansweredComments,
  writePrCommentState,
  DEFAULT_MAX_REPLIES_TOTAL,
  DEFAULT_MAX_REPLY_CHARS,
  DEFAULT_MAX_SENTENCES_PER_REPLY,
  type CommentOutcome,
  type GitHubPort,
  type PrCommentState,
} from "../review/pr-comments";
import {
  DEFAULT_MAX_FINDINGS_PER_REVIEWER,
  DEFAULT_MAX_PARALLEL_REVIEWERS,
  DEFAULT_SPEND_CEILING_USD,
  evaluateSpendCap,
  planReviewerWaves,
} from "../review/caps";
import {
  detectReviewLoop,
  readFlowReviewRounds,
  readTaskAttemptCount,
  renderLoopDetectionMarkdown,
} from "../review/loop";
import {
  detectProjectStack,
  extractStackRequiresField,
  parseStackRequires,
  renderStackScopingMarkdown,
  scopeReviewerByStack,
  type DetectedStack,
  type StackScopingDecision,
} from "../review/stack";
import {
  DEFAULT_VERIFICATION_MODE,
  FINDING_DISPOSITION_STATES,
  MANAGED_REVIEW_MODES,
  REVIEW_TARGET_KINDS,
  VERIFICATION_METHODS,
  VERIFICATION_MODES,
  type FindingDispositionState,
  type ManagedReviewInput,
  type ManagedReviewMode,
  type ReviewFindingsSource,
  type ReviewScopeRecordLike,
  type ReviewTargetKind,
  type VerificationSource,
} from "../review/types";
import {
  applyDeterministicOverride,
  buildCiTriageQuestions,
  buildCiTriageState,
  computeCiSignals,
  computeCiTriageVerdict,
  extractFailingTestName,
  readCiTriageEnabled,
  renderCiTriageAdvisory,
  type CiSignalsPrecomputed,
  type CiTriageCriterion,
  type CiTriageVerdict,
} from "../review/ci-triage";
import {
  createFixtureCiPort,
  createGhCiPort,
  type CiAttemptJobs,
  type CiJobSummary,
  type CiPort,
  type CiRunHistoryEntry,
  type CiRunInfo,
} from "../review/ci-port";
import { callJevSystemOne, DEFAULT_JEV_MODEL, resolveJevApiKey, resolveJevApiKeyResolution, type JevUsage } from "../harness/decision/jev-client";
import {
  applyClauseTags,
  buildClauseTagQuestions,
  clauseTagFromChoice,
  extractReferenceClauses,
  type ReferenceClause,
} from "../review/conform-clauses";
import { cachedTagsFor, hashConformDocContent, readClauseTagCache, writeClauseTagCache } from "../review/conform-tag-cache";
import {
  computePrConformFacts,
  computeReportConformFacts,
  hunkClauseFacts,
  hunkRedactedStateText,
  hunkRegionsFromDiff,
  prClauseFacts,
  prRedactedStateText,
  reportClauseFacts,
  reportRedactedStateText,
  type ReportFindingLike,
} from "../review/conform-state";
import {
  activeClausesAt,
  batchConformItems,
  boundHunkRegions,
  DEFAULT_CONFORM_THRESHOLD,
  DEFAULT_MAX_HUNK_CALLS,
  DEFAULT_MAX_HUNKS,
  evaluatedVerdict,
  notCheckableVerdict,
  notEvaluatedVerdict,
  aggregateConformVerdicts,
  type ConformBatchItem,
  type ConformHunkLocation,
  type ConformVerdict,
} from "../review/conform-jev";
import { createFixtureConformPrPort, createGhConformPrPort } from "../review/conform-pr-port";
import {
  conformResultToJson,
  readConformEnabled,
  renderConformMarkdown,
  withRecentDoc,
  CONFORM_RECENTS_PATH,
  type ConformHunkBudget,
  type ConformTarget,
} from "../review/conform-report";
import { runModelTurn } from "../harness/provider/single-turn";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * Every flag each subcommand understands, and nothing else.
 *
 * An unknown flag used to be accepted silently with exit 0, and the cost was not
 * cosmetic: `keryx review complete <pkg> --disposition acted-on --evidence
 * "commit abc" --finding F-001` printed `status: closed` and wrote no
 * disposition at all. The operator's only signal that the mechanism had not run
 * was its absence from a file they had no reason to open — which is the same
 * shape as the `keryx:findings` block falling through to the prose parser, and
 * the same shape as `dismissed-out-of-scope: 0` meaning "not written down".
 *
 * A misspelling here is always a mistake: there is no case where a review
 * command should do LESS than the operator asked and say nothing.
 */
const CREATE_FLAGS = [
  "--target",
  "--ref",
  "--target-ref",
  "--head",
  "--flow",
  "--review-id",
  "--reviewers",
  "--report",
  "--verifications",
  "--verification-mode",
  "--scope",
  "--blast-radius",
  // Flow 209 AC2. The `cross_family_review` block, as
  // `keryx providers cross-family --json` prints it. Without a way in, the
  // command computed a decision nothing could ever record — and a record nothing
  // holds is a record nothing reads.
  "--cross-family-review",
  "--refuted",
  "--max-findings",
  "--spent",
  "--spend-ceiling",
  "--tokens-in",
  "--tokens-out",
  "--parallel",
  "--outstanding",
] as const;

const BUDGET_FLAGS = ["--spent", "--ceiling", "--parallel", "--outstanding", "--reviewers"] as const;

const COMMENTS_COLLECT_FLAGS = [
  "--repo",
  "--pr",
  "--self",
  // The head this pass READ, recorded on the durable state so the completion
  // gate can tell a current collection from one that ran before the comments
  // arrived. Required, exactly as it is for `reply`: a collection that cannot
  // say which commit it was true of is one the gate must refuse.
  "--sha",
  "--round",
  "--fixtures",
  "--out",
  "--json",
] as const;

const COMMENTS_REPLY_FLAGS = [
  "--repo",
  "--pr",
  // Accepted here only as the fallback for a record that carries no identity yet
  // — the recorded one wins, so a reply pass cannot run under a different login
  // from the collection it is answering.
  "--self",
  "--outcomes",
  // The skill's own result, checked against `review-pr-feedback-output` before
  // anything is posted. See `refuseInvalidResult`.
  "--result",
  // The managed review package this reply pass belongs to. With `--result`, one
  // of the two is required to post: see `refuseUnmanagedReply`.
  "--review",
  "--sha",
  "--round",
  "--final",
  "--dry-run",
  "--max-replies",
  "--max-sentences",
  "--max-chars",
  "--flow-link",
  "--fixtures",
  // Post to a closed or merged pull request anyway. Off by default: the pass
  // refuses a finished pull request, and the head must match either way.
  "--allow-closed-pr",
] as const;

const LOOP_FLAGS = ["--flow", "--task"] as const;

/**
 * Flow 306/307: `keryx review ci-triage`. `--fixtures <dir>` answers BOTH the
 * CI read port and the Jev call from files on disk (`ci-run-info.json`,
 * `ci-failed-log.txt`, optional `ci-history.json`/`ci-attempts.json`/
 * `ci-changed-files.json`/`ci-runs-by-head-sha.json`, `jev-response.json`) —
 * the same "no real network in any test" discipline `--fixtures` already
 * gives `review comments`. `--eval <file>` (AC5/AC6) replaces `--run`/`--job`
 * with a labelled-case manifest; `--live` (only meaningful with `--eval`)
 * replays it against the real `gh`/Jev instead of each case's fixtures.
 */
const CI_TRIAGE_FLAGS = ["--run", "--job", "--test", "--repo", "--model", "--fixtures", "--json", "--eval", "--live"] as const;

/**
 * Flow 308: `keryx review conform`. `--pr` runs `pr`-kind AND `hunk`-kind
 * clauses (the PR's own diff supplies the hunk regions); `--report` runs
 * `report`-kind clauses; `--diff` alone runs `hunk`-kind clauses only —
 * mutually exclusive, matching the frozen AC6 usage line exactly.
 * `--fixtures <dir>` answers the pr-kind port, the tagging/scoring Jev calls,
 * and (with `--explain`) the explanation pass, all from files on disk — no
 * real `gh` call, no real network, same discipline as `ci-triage`.
 */
const CONFORM_FLAGS = [
  "--ref",
  "--pr",
  "--report",
  "--diff",
  "--repo",
  "--explain",
  "--threshold",
  "--model",
  "--fixtures",
  "--json",
  "--max-hunks",
  "--max-hunk-calls",
  "--detail",
] as const;

/**
 * No `--authors` and no `--skill`.
 *
 * Both are named by `.metaproject/review-learning.config.json`, and accepting
 * either from the command line would make the configured list a default rather
 * than the rule — one `--authors` on one invocation and a project has learned
 * from somebody it never named. `--repo` is likewise absent: the config names
 * the repository whose comments teach this skill.
 *
 * `--reviewer <id>` (W3, flow 312 T9) is the sibling entry point: with it,
 * `keryx review learn` applies an accepted reviewer-profile candidate to
 * `.metaproject/rules/reviewers/<id>.mdc` instead of the per-skill
 * `--pr`-driven path above, and `--pr` is not read in that mode.
 */
const LEARN_FLAGS = ["--pr", "--reviewer", "--dry-run", "--json"] as const;

const SCOPE_FLAGS = [
  "--context",
  "--path",
  "--diff",
  "--ref",
  "--base",
  "--json",
  "--scoped-diff",
  "--append",
  // Not used to scope anything — it is how the cost estimate knows the fan-out.
  // Every reviewer receives the scoped diff, so a per-round figure that ignored
  // their number would understate the one thing the estimate is printed for.
  "--reviewers",
] as const;

/** The `--reviewers a,b` list, empty when nobody said. */
function reviewerList(args: readonly string[]): string[] {
  return (optionValue(args as string[], "--reviewers") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * No `--append` and no `--out`.
 *
 * The floor guard answers a question about the diff in front of you, and the
 * answer is only true of that diff. `scope` and `blast-radius` write into a
 * review package because a reviewer reads them later; a floor finding that
 * outlived its diff would be read as a standing accusation about a file.
 */
const FLOOR_FLAGS = ["--ref", "--base", "--diff", "--context", "--json", "--report-only"] as const;

/**
 * The `floor` flags that are meaningless without a value.
 *
 * `keryx review floor --diff --json` — which is what an unquoted empty variable
 * in CI expands to — read `--diff` as absent, diffed the working tree instead,
 * and answered `outcome: "scanned"`, `scanned: { files: 12, … }`, exit 0. A
 * confident scan of the wrong thing, from a command whose entire contract is
 * that its exit code can be trusted. Refused rather than guessed, and refused as
 * a VALIDATION error (exit 1) rather than `cannot-scan` (exit 2): the guard was
 * never asked a question it could answer.
 *
 * Floor only. `scope` reads the same flags through the same {@link optionValue}
 * and has the same hole, but it is published and always exits 0; changing it is
 * a separate task.
 */
const FLOOR_VALUE_FLAGS = ["--ref", "--base", "--diff", "--context"] as const;

function rejectValuelessOptions(args: readonly string[], valueFlags: readonly string[], usage: string): void {
  const empty = flagTokens(args)
    .filter((token) => valueFlags.includes(token.name))
    .filter((token) => token.value === undefined || token.value.trim().length === 0)
    .map((token) => token.name);
  if (empty.length > 0) {
    throw new Error(
      `Option${empty.length > 1 ? "s" : ""} without a value for \`keryx review ${usage}\`: ${[...new Set(empty)].join(", ")}. ` +
        "Each of these takes a value, and the next token is another flag, absent or empty — usually an unquoted shell variable that " +
        "expanded to nothing. Refused rather than treated as omitted: the fallback would scan something else and report success.",
    );
  }
}

const BLAST_RADIUS_FLAGS = [
  "--ref",
  "--base",
  "--changed",
  "--depth",
  "--max-files",
  "--no-related-tests",
  "--final",
  "--previous",
  "--json",
  "--brief",
  "--out",
] as const;

const TIER_FLAGS = [
  "--scope",
  "--fix-attempt",
  "--forced-strategy-change",
  "--findings",
  "--diff-lines",
  "--verifier",
  "--security",
  "--session-provider",
  "--session-model",
  "--from-shell-config",
  "--catalog",
  "--json",
] as const;

const COMPLETE_FLAGS = ["--finding", "--disposition", "--evidence"] as const;

const STACK_FLAGS = ["--json"] as const;
const REVIEWERS_FLAGS = ["--json"] as const;
const IMPORT_FLAGS = ["--from", "--dry-run", "--force", "--json", "--help"] as const;

/**
 * The `--name`s present in `args`, in order, with their values.
 *
 * Both spellings, matching {@link optionValue}: `--name value` and `--name=value`.
 * A flag whose next token is another flag carries no value, so `--json --append
 * f` reads as two flags rather than as `--json=--append`.
 */
function flagTokens(args: readonly string[]): Array<{ name: string; value: string | undefined }> {
  const tokens: Array<{ name: string; value: string | undefined }> = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("--")) {
      continue;
    }
    const equals = argument.indexOf("=");
    if (equals > 0) {
      tokens.push({ name: argument.slice(0, equals), value: argument.slice(equals + 1) });
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      tokens.push({ name: argument, value: next });
      index += 1;
      continue;
    }
    tokens.push({ name: argument, value: undefined });
  }
  return tokens;
}

function rejectUnknownFlags(args: readonly string[], allowed: readonly string[], usage: string): void {
  const unknown = flagTokens(args)
    .map((token) => token.name)
    .filter((name) => !allowed.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review ${usage}\`: ${[...new Set(unknown)].join(
        ", ",
      )}. Accepted: ${allowed.join(", ")}. Refused rather than ignored — a flag that is silently dropped writes nothing and reports success.`,
    );
  }
}

export async function reviewCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  try {
    if (command === "attach") {
      await runCreate("attach-review", args.slice(1));
      return;
    }
    if (command === "start") {
      await runCreate("review-flow", args.slice(1));
      return;
    }
    if (command === "ingest") {
      await runCreate("ingest", args.slice(1));
      return;
    }
    if (command === "scope") {
      await runScope(args.slice(1));
      return;
    }
    if (command === "floor") {
      await runFloor(args.slice(1));
      return;
    }
    if (command === "blast-radius") {
      await runBlastRadius(args.slice(1));
      return;
    }
    if (command === "budget") {
      await runBudget(args.slice(1));
      return;
    }
    if (command === "tier") {
      await runTier(args.slice(1));
      return;
    }
    if (command === "comments") {
      await runComments(args.slice(1));
      return;
    }
    if (command === "ci-triage") {
      await runCiTriage(args.slice(1));
      return;
    }
    if (command === "conform") {
      await runConform(args.slice(1));
      return;
    }
    // flow 332: two ADDITIONAL, CLI-driven reviewers — see
    // `src/commands/review-jev-risk.ts`/`review-jev-scenarios.ts` for
    // everything past registration.
    if (command === "jev-risk") {
      await runJevRisk(args.slice(1));
      return;
    }
    if (command === "jev-scenarios") {
      await runJevScenarios(args.slice(1));
      return;
    }
    if (command === "learn") {
      await runLearn(args.slice(1));
      return;
    }
    if (command === "loop") {
      await runLoop(args.slice(1));
      return;
    }
    if (command === "stack") {
      await runStack(args.slice(1));
      return;
    }
    if (command === "reviewers") {
      await runReviewers(args.slice(1));
      return;
    }
    if (command === "import") {
      rejectUnknownFlags(args.slice(1), IMPORT_FLAGS, "import");
      await runImportReviewers(args.slice(1));
      return;
    }
    if (command === "status") {
      await runStatus(args.slice(1));
      return;
    }
    if (command === "complete") {
      await runComplete(args.slice(1));
      return;
    }
    if (command === "lightweight") {
      console.log("lightweight review mode: report-only; no managed review artifacts created");
      return;
    }
    console.error(`Unknown review command: ${command}`);
    printHelp();
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runCreate(mode: ManagedReviewMode, args: string[]): Promise<void> {
  rejectUnknownFlags(args, CREATE_FLAGS, mode === "ingest" ? "ingest" : mode === "review-flow" ? "start" : "attach");
  const targetKind = targetKindFromArgs(mode, args);
  const targetRef = optionValue(args, "--ref") ?? optionValue(args, "--target-ref");
  if (!targetRef) {
    throw new Error("Usage: keryx review <attach|start|ingest> --target <kind> --ref <ref>");
  }
  const reviewers = optionValue(args, "--reviewers")?.split(",").map((item) => item.trim()).filter(Boolean);
  const cwd = process.cwd();
  const head = await resolveCreateHead(args, targetKind, targetRef, cwd);
  const input: ManagedReviewIngestInput = {
    cwd,
    mode,
    target: { kind: targetKind, ref: targetRef, ...(head === undefined ? {} : { head }) },
    flowId: optionValue(args, "--flow"),
    reviewId: optionValue(args, "--review-id"),
    reviewers,
    reportPath: optionValue(args, "--report"),
    refuted: await readRefuted(optionValue(args, "--refuted")),
    verifications: await readVerifications(optionValue(args, "--verifications")),
    verificationMode: parseVerificationMode(optionValue(args, "--verification-mode")),
    scope: await readScope(optionValue(args, "--scope")),
    blastRadius: await readBlastRadiusRecord(optionValue(args, "--blast-radius")),
    crossFamilyReview: await readCrossFamilyReview(optionValue(args, "--cross-family-review")),
    maxFindingsPerReviewer: parseNonNegativeInteger(optionValue(args, "--max-findings"), "--max-findings"),
    spend: parseMoney(optionValue(args, "--spent"), "--spent"),
    spendCeiling: parseMoney(optionValue(args, "--spend-ceiling"), "--spend-ceiling"),
    concurrency: parseConcurrency(args),
    // What the round actually used. `--spent` already existed and went only into
    // the ceiling evaluation, which is why `review budget` could print a ceiling
    // beside `spent: not recorded` forever. Recorded on the package now, so the
    // number outlives the terminal it was printed on.
    cost: costFrom({
      inputTokens: parseNonNegativeInteger(optionValue(args, "--tokens-in"), "--tokens-in"),
      outputTokens: parseNonNegativeInteger(optionValue(args, "--tokens-out"), "--tokens-out"),
      spentUsd: parseMoney(optionValue(args, "--spent"), "--spent"),
    }),
  };
  const result = await createManagedReviewPackage(input);
  console.log(`# managed review: ${result.reviewId}`);
  console.log("");
  console.log(`mode: ${result.manifest.mode}`);
  console.log(`status: ${result.manifest.status}`);
  console.log(`path: ${result.path}`);
  console.log(`flow: ${result.manifest.flow?.id ?? "none"}`);
  // Printed on every run, and printed as an absence when it is one: the review
  // completion gate compares this against the pull request's head, and a round
  // that recorded none fails that comparison as `unobserved`. An operator who
  // has to open manifest.json to find out reads silence as a match.
  console.log(
    `head: ${
      result.manifest.target.head ??
      "not recorded (no git checkout to ask, and no --head given; `flow complete` will refuse this round)"
    }`,
  );
  // AC11/AC15: the stage counts are the only thing this pipeline's claims may be
  // stated in, so they are printed on every run rather than hidden in scope.md.
  const counts = result.verification;
  console.log("");
  console.log(`verification_mode: ${counts.mode}`);
  console.log(
    `verdicts: confirmed=${counts.confirmed} refuted=${counts.refuted} unverifiable=${counts.unverifiable} unverified=${counts.unverified}`,
  );
  console.log(
    `findings: in=${counts.findingsIn} removed_by_verifier=${counts.findingsRefuted} retained=${counts.findingsRetained}`,
  );
  if (counts.rejected > 0) {
    console.log(`verification claims discarded: ${counts.rejected} (see scope.md; every one leaves its finding in place)`);
  }
  if (counts.capped > 0) {
    console.log(`verdicts capped to unverifiable: ${counts.capped} (reasoning alone is not evidence)`);
  }
  const preFilter = input.scope;
  console.log(
    preFilter === undefined
      ? "pre-filter: not recorded (no --scope supplied; this is not `dropped 0`)"
      : `pre-filter: files_dropped=${preFilter.counts.filesDropped} blocks_dropped=${preFilter.counts.blocksDropped} changed_lines_dropped=${preFilter.counts.changedLinesDropped} drop_rows=${preFilter.drops.length}`,
  );

  // Flow 207 AC1/AC3. The structured record is in `manifest.json`; this line is
  // the same object rendered, so the terminal and the file cannot disagree.
  // `not-measured` is printed where a count is absent, never `0`.
  console.log(renderFilterStatsLine(result.filterStats));
  reportFilterStatsProblems(result.filterStats, `${result.path}/manifest.json`);

  // Flow 209 AC2, the producer half. The block is now ON the manifest; the
  // reader is `keryx review status`, in a later invocation. Printed as
  // `not recorded` when no `--cross-family-review` was supplied, because the
  // alternative — printing nothing — is what let a decision nobody made read as
  // a decision that came out single-family.
  console.log(renderCrossFamilyReviewLine(result.manifest.cross_family_review));

  // AC10: every cap says what it dropped, on the terminal as well as in
  // scope.md. A truncation an operator has to open a file to discover reads, on
  // the terminal they were already looking at, as "there was nothing more".
  const caps = result.caps;
  const findingsCap = caps.findings;
  if (findingsCap !== undefined) {
    console.log(
      `findings cap: limit=${findingsCap.counts.limit}/reviewer truncated=${findingsCap.counts.truncated} exempt=${findingsCap.counts.exempt} reviewers_truncated=${findingsCap.counts.reviewersTruncated}`,
    );
    for (const drop of findingsCap.drops) {
      console.log(`  truncated ${drop.truncated} from ${drop.reviewer}: ${drop.truncatedIds.join(", ")}`);
    }
  }

  // AC3, on the same rule as the cap above: a screen that removes findings owes
  // the terminal the same record. `not recorded` and `rejected 0` are different
  // facts, and only one of them means the screen ran.
  const scopeB = result.scopeBScreen;
  if (scopeB.screen === undefined) {
    // An ASSERTION, not a report. `screenScopeBFindings` is total on this pair:
    // with no radius it either THROWS (any scope-B finding) or returns
    // `{source: "none", scopeBFindings: 0}`, so an unrecorded screen implies no
    // scope-B findings and `not recorded (N went through unscreened)` could
    // never print. A console line that cannot appear is not a safety net — it
    // reads as one while proving nothing, which is the exact shape of every
    // defect this pipeline exists to end. If the writer ever gains a fourth
    // outcome, this fails loudly on the first round that reaches it instead of
    // printing a line nobody configured a test to look for.
    if (scopeB.scopeBFindings > 0) {
      throw new Error(
        `Invariant violated: ${scopeB.scopeBFindings} scope-B finding(s) reached the package with no screen recorded. \`screenScopeBFindings\` must either run the screen or refuse the round; it did neither. The package was written and is the record of the violation.`,
      );
    }
  } else {
    console.log(
      `scope-B screen: source=${scopeB.source} scope_b_findings=${scopeB.scopeBFindings} accepted=${scopeB.screen.accepted.length} rejected=${scopeB.screen.rejected.length} exempted=${scopeB.screen.exempted.length} min_severity=${scopeB.screen.minSeverity}`,
    );
    for (const rejection of scopeB.screen.rejected) {
      console.log(`  rejected ${rejection.finding.id ?? "<unidentified>"} [${rejection.rule}]: ${rejection.detail}`);
    }
    // An acceptance a rule never judged is a fact about the round, on the same
    // rule as a rejection: `accepted=N` alone reads as "all three rules passed"
    // and for these it did not.
    for (const exemption of scopeB.screen.exempted) {
      console.log(
        `  exempted ${exemption.finding.id ?? "<unidentified>"} [${exemption.rule} not applied]: ${exemption.detail}`,
      );
    }
  }
  const concurrency = caps.concurrency;
  if (concurrency !== undefined) {
    console.log(
      `concurrency cap: cap=${concurrency.cap} effective=${concurrency.effective} waves=${concurrency.waves.length} queued=${concurrency.queued} holds_across_nesting=${
        concurrency.holdsAcrossNesting ? "yes (declared)" : "no"
      }`,
    );
  }
  // Flow 207 AC5/AC6. Both halves, because the second is the interesting one: a
  // dismissal that reached no note means a finding was filed as model error with
  // nobody standing behind the decision, and a learning loop that quietly
  // declined to learn is the silence this whole flow exists to end.
  for (const note of result.reviewNotes.written) {
    console.log(`review-note: ${note.finding} -> ${note.path} (attested by ${note.attestation})`);
  }
  for (const skip of result.reviewNotes.skipped) {
    console.log(`review-note NOT written for ${skip.finding}: ${skip.reason}`);
  }

  const spend = caps.spend;
  if (spend !== undefined) {
    console.log(
      `spend: ${spend.spent === undefined ? "not recorded" : spend.spent} / ${spend.ceiling} ${spend.currency} (${spend.status})`,
    );
    if (spend.stop) {
      // The package IS written — it is the record of the round running out of
      // money — and then the command refuses. A cap that deleted its own
      // evidence would be the failure this flow exists to end.
      console.error(
        `STOP: spend ${spend.spent} ${spend.currency} has reached the ${spend.ceiling} ${spend.currency} ceiling (over by ${spend.overBy}). Ask the operator before another round. The package was written; it is the record of the stop.`,
      );
      process.exitCode = 1;
    }
  }
}

/**
 * What `--head` says, or what can be worked out without asking a model.
 *
 * `undefined` here does not mean "no head": it means this layer has nothing to
 * add and {@link module:review/managed.resolveTargetHead} should read the local
 * checkout. The one thing this layer can do that the writer deliberately will
 * not is reach the network, and it does so in exactly one case — a `pr` target
 * with no checkout to ask, i.e. a pull request being reviewed from outside a
 * clone. When a checkout IS present its commit wins, because that is the tree
 * the reviewers read; see `resolveTargetHead` for why recording the pull
 * request's head instead would defeat the completion gate rather than satisfy
 * it.
 */
async function resolveCreateHead(
  args: string[],
  kind: ReviewTargetKind,
  ref: string,
  cwd: string,
): Promise<string | undefined> {
  const explicit = optionValue(args, "--head");
  if (explicit !== undefined) {
    const value = explicit.trim();
    if (!/^[0-9a-f]{7,40}$/i.test(value)) {
      throw new Error(
        `--head "${explicit}" is not a commit SHA. Give the commit this round ran against (\`git rev-parse HEAD\`), 7-40 hex characters.`,
      );
    }
    return value.toLowerCase();
  }
  if (kind !== "pr") {
    return undefined;
  }
  if ((await resolveGitHead(cwd)) !== null) {
    return undefined;
  }
  if (!(await githubAdapter.detect())) {
    return undefined;
  }
  const status = await githubAdapter.prStatus(ref);
  return status.exists && status.headSha !== null ? status.headSha : undefined;
}

/**
 * `keryx review budget` — the spend and concurrency gate, run BEFORE dispatch.
 *
 * This is where "stops and asks" is real. `review ingest` can only record that a
 * round went over, because by then the money is spent; this refuses first, with
 * a non-zero exit, which is the only signal an orchestrator reliably notices.
 */
async function runBudget(args: string[]): Promise<void> {
  rejectUnknownFlags(args, BUDGET_FLAGS, "budget");
  const spend = evaluateSpendCap(parseMoney(optionValue(args, "--spent"), "--spent"), {
    ceiling: parseMoney(optionValue(args, "--ceiling"), "--ceiling"),
  });
  const reviewers =
    optionValue(args, "--reviewers")
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  const plan = planReviewerWaves(reviewers, {
    cap: parseNonNegativeInteger(optionValue(args, "--parallel"), "--parallel"),
    outstanding: parseNonNegativeInteger(optionValue(args, "--outstanding"), "--outstanding"),
  });

  console.log("# review budget");
  console.log("");
  console.log(`spend_ceiling: ${spend.ceiling} ${spend.currency}`);
  console.log(`spent: ${spend.spent === undefined ? "not recorded" : spend.spent}`);
  console.log(`spend_status: ${spend.status}`);
  if (spend.status === "not-recorded") {
    console.log(
      "  `not recorded` is not `under`: nobody reported a spend, so staying inside the ceiling was never demonstrated.",
    );
  }
  console.log("");
  console.log(`concurrency_cap: ${plan.cap}`);
  console.log(`outstanding_declared: ${plan.outstanding === undefined ? "not recorded" : plan.outstanding}`);
  console.log(`effective_wave_size: ${plan.effective}`);
  console.log(`waves: ${plan.waves.length}`);
  console.log(`reviewers_queued: ${plan.queued}`);
  console.log(`holds_across_nesting: ${plan.holdsAcrossNesting ? "yes (against the declared count)" : "no"}`);
  if (!plan.holdsAcrossNesting) {
    console.log(
      "  The cap bounds THIS plan only. Nothing declared what job-orchestrator or flow-orchestrator already had in flight, and keryx cannot observe it. Pass --outstanding <n> to make the cap mean something across the nesting.",
    );
  }
  plan.waves.forEach((wave, index) => {
    console.log(`  wave ${index + 1}: ${wave.join(", ")}`);
  });

  if (spend.stop) {
    console.error("");
    console.error(
      `STOP: ${spend.spent} ${spend.currency} spent against a ${spend.ceiling} ${spend.currency} ceiling (over by ${spend.overBy}). Do NOT dispatch another round. Ask the operator to raise the ceiling with --ceiling or to end the review.`,
    );
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// `keryx review tier` — which model this dispatch is worth, computed
// ---------------------------------------------------------------------------

/**
 * `keryx review tier` — the `model` block a dispatch document carries, RUN
 * rather than reasoned about (flow 204, §4.4).
 *
 * `assignTier` and `decideDispatchModel` were reachable only from TypeScript,
 * and the rule that named their caller named "an orchestrator authoring a
 * dispatch document" — an LLM agent following prose. An agent cannot call a
 * TypeScript function, so the tier was in practice assigned by a model reading a
 * table and doing the arithmetic in its head, which is exactly the mechanical
 * work this programme moves out of skills and into code. This command is the
 * entry point that closes that gap: the orchestrator runs one command with the
 * signals it already holds and pastes the block it prints.
 *
 * It sits beside `review scope`, `review blast-radius` and `review budget` for
 * the same reason those exist: all four are "compute this mechanically, before
 * dispatching, instead of eyeballing it".
 *
 * NO MODEL NAME IS WRITTEN HERE, and none is written anywhere this command
 * reads. The session's provider/model come from the CALLER — flags, or the
 * `KERYX_SESSION_PROVIDER`/`KERYX_SESSION_MODEL` environment a host exports —
 * the candidate set comes from live provider detection (or from `--catalog`),
 * and `src/gdskills/model-tier.ts` places the tier relative to the session's
 * own model. When the caller names nothing, the block is adaptive: the tier
 * plus `inherit: true`, and the host picks its own model for that tier.
 */
/**
 * Flow 305 (Flow A), AC5 — resolve the `review` category (`src/harness/routing`)
 * ahead of / alongside `assignTier`'s own live-detection ranking. When the
 * category resolves to an explicit `{kind:"model"}` (per-project or per-user
 * `routing.config.json`/shell config — `cwd` is both the project-config
 * directory and the per-user config dir override, i.e. the caller's real cwd
 * in production), that provider/model REPLACES the decision's own. When
 * nothing is configured for `review` (`session-default`, the state with an
 * empty routing table) the decision is returned completely UNCHANGED — same
 * object identity is not required, but every field is byte-identical, which
 * is what the regression test pins (AC5's "byte-identical to pre-Flow-A").
 *
 * `routed: true` marks a routing-table override on the RESULT rather than
 * forcing `tier_resolution: "discovered"` (review finding, AC11d): the two
 * questions are independent — `tier_resolution` says how `assignTier`
 * resolved a MODEL FOR THE TIER, `routed` says whether the routing table then
 * REPLACED that model outright. Conflating them mislabels a routed pick as
 * "discovered" (tier-ranked), which is exactly the confusion AC11(d) flags —
 * and would have required a fourth `TierResolutionSource` member to fix
 * honestly, touching `model-tier.ts`'s public contract for a distinction the
 * dispatch schema does not otherwise need.
 *
 * Flow 305 review findings, additive to AC5:
 *  - AC10: the resolved assignment is checked against `catalog` (the same
 *    provider/model list already fetched for tier ranking — no NEW network
 *    call). An assignment naming an unconnected provider/model falls through
 *    exactly as `resolveCategoryDetailed` documents; `notices` carries the
 *    fallback line for the caller to print.
 *  - AC11(b): a malformed or unapproved project `routing.config.json` is
 *    surfaced in `notices` (never silently swallowed) rather than only
 *    logged nowhere the operator can see it.
 *  - item 4: a `provider-default` assignment is resolved the same way
 *    `subagents` already does (`resolveProviderDefaultModelId`), not ignored.
 */
interface ReviewRoutingResult {
  readonly decision: DispatchModelDecision;
  readonly routed: boolean;
  /** Human-readable lines to surface alongside the tier output — never silent. */
  readonly notices: readonly string[];
}

async function applyReviewRoutingCategory(
  decision: DispatchModelDecision,
  cwd: string,
  catalog: readonly DiscoveredProvider[],
): Promise<ReviewRoutingResult> {
  const location = { cwd };
  const [project, user] = await Promise.all([loadRoutingConfig("project", location), loadRoutingConfig("user", location)]);
  const notices: string[] = [];
  for (const layer of [project, user]) {
    if (layer.error !== undefined) notices.push(layer.error);
  }
  const connected = connectedPredicateFrom(catalog);
  const resolved = resolveCategoryDetailed("review", { project: project.table, user: user.table }, connected);
  if (resolved.rejected !== undefined) {
    notices.push(describeFallbackNotice(resolved.rejected.assignment, resolved.assignment));
  }
  const { assignment } = resolved;
  if (assignment.kind === "model") {
    return { decision: { ...decision, provider: assignment.providerId, model: assignment.modelId }, routed: true, notices };
  }
  if (assignment.kind === "provider-default") {
    const modelId = resolveProviderDefaultModelId(assignment.providerId);
    if (modelId !== undefined) {
      return { decision: { ...decision, provider: assignment.providerId, model: modelId }, routed: true, notices };
    }
  }
  return { decision, routed: false, notices };
}

async function runTier(args: string[]): Promise<void> {
  rejectUnknownFlags(args, TIER_FLAGS, "tier");
  const signals = tierSignalsFromArgs(args);
  const { session, source } = sessionModelFromArgs(args);
  const catalog = await tierCatalog(args, session);
  const { decision, routed, notices } = await applyReviewRoutingCategory(
    decideDispatchModel(session, signals, catalog),
    process.cwd(),
    catalog,
  );
  // AC11(d): a routed pick is NEVER folded into `dispatchModelBlock`'s
  // `pinsModel`-gated provider/model — that path exists for the TIER's own
  // "discovered" resolution. `routed: true` is an ADDITIVE field on top of
  // the same block shape, not a replacement for `tier_resolution`.
  const block = routed
    ? { ...dispatchModelBlockRouted(decision), routed: true }
    : dispatchModelBlock(decision);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ model: block, ...(notices.length > 0 ? { notices } : {}) }, null, 2));
    return;
  }

  for (const notice of notices) {
    console.error(`routing: ${notice}`);
  }

  const discovery = decision.model_discovery;
  console.log("# review tier");
  console.log("");
  console.log(`tier: ${decision.tier}`);
  console.log(`tier_reasons: ${decision.tier_reasons.join(", ")}`);
  console.log(`session_source: ${SESSION_SOURCE_LABELS[source]}`);
  // Printed rather than assumed: `inherit` is an answer, and saying "not
  // resolved" would read as a failure — the next thing a reader does with a
  // failure is pick a model by hand.
  if (routed) {
    console.log(`provider: ${decision.provider}`);
    console.log(`model: ${decision.model}`);
    console.log(`routed: true (from the routing table's "review" category — not tier-discovered)`);
  } else if (pinsModel(decision)) {
    console.log(`provider: ${decision.provider}`);
    console.log(`model: ${decision.model}`);
  } else {
    console.log(`model: inherit — ${ADAPTIVE_GUIDANCE[decision.tier]}`);
  }
  console.log(`tier_resolution: ${decision.tier_resolution}`);
  console.log(
    `model_discovery: provider=${discovery.provider === "" ? "none" : discovery.provider} candidates=${discovery.candidates.length} ranked=${discovery.ranked.length} session_rank=${discovery.session_rank ?? "none"}`,
  );
  console.log(`fallback_reason: ${discovery.fallback_reason ?? "none (ranking was not refused)"}`);
  console.log("");
  console.log("## model block");
  console.log("");
  console.log("Paste this verbatim as the dispatch document's `model` field.");
  console.log("");
  console.log("```json");
  console.log(JSON.stringify({ model: block }, null, 2));
  console.log("```");
}

/** `dispatchModelBlock`'s shape, but unconditionally naming `provider`/`model` — used only when `routed` (AC11d), where `pinsModel`'s own tier-based gate does not apply. */
function dispatchModelBlockRouted(decision: DispatchModelDecision): Record<string, unknown> {
  return {
    tier: decision.tier,
    tier_reasons: decision.tier_reasons,
    provider: decision.provider,
    model: decision.model,
    tier_resolution: decision.tier_resolution,
    model_discovery: decision.model_discovery,
  };
}

/** The §4.4 signals, read from flags an orchestrator already has the answers to. */
function tierSignalsFromArgs(args: string[]): TierSignals {
  const scope = optionValue(args, "--scope");
  const verifier = optionValue(args, "--verifier");
  if (verifier !== undefined && !(VERIFICATION_METHODS as readonly string[]).includes(verifier)) {
    // Refused rather than passed through. An unrecognised method changes nothing
    // in `assignTier`, so a typo would silently produce `standard` and read as a
    // considered answer — the same failure shape as a silently dropped flag.
    throw new Error(
      `Invalid --verifier: ${verifier}. Expected one of ${VERIFICATION_METHODS.join(", ")}. Refused rather than ignored: an unrecognised method would silently leave the tier at its default and read as a decision.`,
    );
  }
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(verifier === undefined ? {} : { verifierMethod: verifier }),
    fixAttempt: parseNonNegativeInteger(optionValue(args, "--fix-attempt"), "--fix-attempt"),
    findingCount: parseNonNegativeInteger(optionValue(args, "--findings"), "--findings"),
    diffLines: parseNonNegativeInteger(optionValue(args, "--diff-lines"), "--diff-lines"),
    forcedStrategyChange: args.includes("--forced-strategy-change"),
    hasSecurityFinding: args.includes("--security"),
  };
}

/** What the host does with `inherit: true`, per tier. Names no model. */
const SESSION_SOURCE_LABELS: Readonly<Record<SessionSource, string>> = {
  flags: "flags (--session-provider/--session-model)",
  env: "environment (KERYX_SESSION_PROVIDER/KERYX_SESSION_MODEL)",
  "shell-config": "the selection `keryx shell` persisted (--from-shell-config)",
  none: "none — the caller named no model, so the block is adaptive",
};

const ADAPTIVE_GUIDANCE: Readonly<Record<string, string>> = {
  light:
    "dispatch on a lighter model your own runtime offers (its fast/small class), or on your session model if it offers no choice",
  standard: "dispatch on your session model",
  deep: "dispatch on the most capable model your own runtime offers, or on your session model if it offers no choice",
};

/** The caller's session for `review tier`; see `resolveCallerSession`. */
export function sessionModelFromArgs(
  args: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): { session: SessionModelContext; source: SessionSource } {
  const resolved = resolveCallerSession({
    flagProvider: optionValue(args, "--session-provider"),
    flagModel: optionValue(args, "--session-model"),
    fromShellConfig: args.includes("--from-shell-config"),
    env,
  });
  return { session: { providerId: resolved.providerId, modelId: resolved.modelId }, source: resolved.source };
}

/**
 * The candidate set, discovered at runtime — or supplied by a caller that
 * already holds a `detectProviders()` result.
 *
 * Detection is skipped when the session names no provider AND model, on the same
 * rule `runBlastRadius` follows for the graph: ranking is refused without an
 * anchor whatever the catalogue contains, so a round that cannot use the answer
 * should not pay for the probe.
 */
async function tierCatalog(args: string[], session: SessionModelContext): Promise<readonly DiscoveredProvider[]> {
  const file = optionValue(args, "--catalog");
  if (file !== undefined) {
    // The two guards below name the flag, the file and the shape. These two
    // reads are the likelier operator mistakes — a typo'd path and a file that
    // is not JSON — and unguarded they surfaced as `ENOENT: no such file or
    // directory` and `JSON Parse error: Unexpected identifier`, neither of which
    // mentions `--catalog`. Exiting non-zero on bad caller input is right; doing
    // it without naming what the caller passed is not.
    let raw: string;
    try {
      raw = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Preserve the sanitized public diagnostic without exposing the raw caught value or stack.
      throw new Error(
        `--catalog ${file} could not be read: ${error instanceof Error ? error.message : String(error)}. ` +
          `Pass a readable file containing \`[{"name": "<provider>", "models": ["<id>", …]}]\` — the shape \`detectProviders()\` returns — or \`--catalog -\` to read it from stdin.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Preserve the sanitized public diagnostic without exposing the raw caught value or stack.
      throw new Error(
        `--catalog ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}. ` +
          `Expected \`[{"name": "<provider>", "models": ["<id>", …]}]\` — the shape \`detectProviders()\` returns.`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `--catalog ${file} is not an array of detected providers. Pass \`[{"name": "<provider>", "models": ["<id>", …]}]\` — the shape \`detectProviders()\` returns.`,
      );
    }
    for (const entry of parsed) {
      const provider = entry as Partial<DiscoveredProvider>;
      if (typeof provider?.name !== "string" || !Array.isArray(provider.models)) {
        throw new Error(
          `--catalog ${file} carries an entry with no \`name\` string and \`models\` array. A half-read catalogue would starve discovery and report the fallback as if the environment had been consulted.`,
        );
      }
    }
    return parsed as DiscoveredProvider[];
  }
  if (session.providerId === "" || session.modelId === "") {
    return [];
  }
  return await detectProviders({ fetch, env: envWithSavedApiKeys() });
}

/**
 * Whether the block names a model: only when discovery assigned one that is
 * NOT the session's.
 *
 * `session-ranked` and `session-fallback` both resolve to the session's own
 * model, and naming it there adds nothing a dispatch can use — it only pins an
 * id the runner may not have (a different host, a model switched mid-session)
 * and turns "whatever you are running" into a stale literal.
 */
export function pinsModel(decision: DispatchModelDecision): boolean {
  return decision.tier_resolution === "discovered" && decision.provider !== "" && decision.model !== "";
}

/**
 * The dispatch document's `model` object, exactly as
 * `contracts/subagent-dispatch.schema.json` defines it.
 *
 * `provider`/`model` are written only when {@link pinsModel}; otherwise the
 * block carries `inherit: true` beside the tier — the adaptive answer, which the
 * host resolves to its own model for that tier. Writing an empty string into
 * either field would produce a schema-invalid dispatch that still looks like an
 * answer.
 */
export function dispatchModelBlock(decision: DispatchModelDecision): Record<string, unknown> {
  return {
    tier: decision.tier,
    tier_reasons: decision.tier_reasons,
    ...(pinsModel(decision) ? { provider: decision.provider, model: decision.model } : { inherit: true }),
    tier_resolution: decision.tier_resolution,
    model_discovery: decision.model_discovery,
  };
}

// ---------------------------------------------------------------------------
// `keryx review comments` — collect every round, reply once at the end
// ---------------------------------------------------------------------------

/**
 * The two halves of the external-comment loop, deliberately two commands.
 *
 * `collect` is safe, idempotent and runs every round. `reply` posts, runs once,
 * and refuses without `--final`. Fusing them into one command is how a mechanism
 * that must happen once ends up happening six times: the caller that already runs
 * collection per round would carry the posting along with it.
 *
 * `--fixtures <dir>` answers every read from JSON on disk and records writes
 * without sending them, so the whole loop can be rehearsed with no token, no
 * network and no pull request. It is not a test-only affordance — it is the
 * supported way to see what a reply pass would say before it says it.
 */
async function runComments(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "collect") {
    await runCommentsCollect(args.slice(1));
    return;
  }
  if (sub === "reply") {
    await runCommentsReply(args.slice(1));
    return;
  }
  throw new Error("Usage: keryx review comments <collect|reply> --repo <owner/repo> --pr <n> ...");
}

async function runCommentsCollect(args: string[]): Promise<void> {
  rejectUnknownFlags(args, COMMENTS_COLLECT_FLAGS, "comments collect");
  const repo = requiredOption(args, "--repo", "comments collect");
  const number = requiredInteger(args, "--pr");
  const round = parseNonNegativeInteger(optionValue(args, "--round"), "--round") ?? 1;
  // Required, and refused when it is not a SHA — the same rule `--head` follows
  // on `review ingest`. The completion gate reads this value as "the commit this
  // collection was true of"; a free-text one would satisfy the field and prove
  // nothing, which is the failure mode the field exists to close.
  const sha = requiredSha(args, "--sha", "comments collect");
  const port = await resolvePort(args);
  const self = optionValue(args, "--self") ?? (await resolveSelfLogin(args));
  const cwd = process.cwd();

  const state = await readPrCommentState(cwd, repo, number);
  const result = await collectPrComments({
    port,
    repo,
    number,
    self,
    handled: state.handled_comments,
  });
  const findings = externalFindingsFromComments(result.comments);
  const recorded = recordSeenComments(state, result.comments, round, { self, collectedSha: sha });
  await writePrCommentState(cwd, recorded);

  const out = optionValue(args, "--out");
  if (out !== undefined) {
    await writeFileAtomic(out, `${JSON.stringify(findings, null, 2)}\n`);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...result, findings, state: recorded }, null, 2));
    return;
  }
  console.log(renderPrCommentsMarkdown({ repo, number, round, result }));
  console.log(`findings: ${findings.length}${out === undefined ? "" : ` (written to ${out})`}`);
  console.log(`collected against: ${sha} (round ${round})`);
  // The pull request itself, every time. This output used to carry the SHA we
  // were given and nothing about the pull request, so a collection against a
  // pre-merge head of a merged PR looked exactly like a current one.
  console.log(`pull request: ${describePullRequest(result.pull)}`);
  if (result.pull.state === "unknown") {
    console.log("WARNING: the pull request's state could not be read — `comments reply` will refuse this pull request.");
  } else if (result.pull.merged || result.pull.state === "closed") {
    console.log(
      "WARNING: the pull request is no longer open — `comments reply` will refuse it unless --allow-closed-pr is passed.",
    );
  }
  if (result.pull.headSha !== null && !shaMatchesHead(sha, result.pull.headSha)) {
    console.log(
      `WARNING: --sha ${sha} is not the pull request's head (${result.pull.headSha}) — this collection is stale, and \`comments reply\` refuses a SHA that is not the head.`,
    );
  }
  console.log(
    `unanswered so far: ${unansweredComments(recorded).length} — replies are posted ONCE, after the final round.`,
  );
}

async function runCommentsReply(args: string[]): Promise<void> {
  rejectUnknownFlags(args, COMMENTS_REPLY_FLAGS, "comments reply");
  const repo = requiredOption(args, "--repo", "comments reply");
  const number = requiredInteger(args, "--pr");
  const round = parseNonNegativeInteger(optionValue(args, "--round"), "--round") ?? 1;
  const isFinal = args.includes("--final");
  const dryRun = args.includes("--dry-run");

  // Before any network call, not merely before the post. A self-contradictory
  // result is refusable from the file alone, and making the caller wait on a
  // comment collection to be told so would hide the refusal behind whatever
  // else can fail first — including, on an unreachable tracker, forever.
  await refuseInvalidResult(optionValue(args, "--result"), optionValue(args, "--outcomes"));
  await refuseUnmanagedReply(args, repo, number, dryRun || !isFinal);

  const cwd = process.cwd();
  const port = await resolvePort(args);
  const state = await readPrCommentState(cwd, repo, number);
  const collected = await collectPrComments({
    port,
    repo,
    number,
    // The identity recorded when this pull request was first collected. Resolving
    // it afresh here would let a reply pass run under a different login from the
    // collection it is answering, and filter the wrong person's comments.
    self: state.self ?? (await resolveSelfLogin(args)),
    handled: state.handled_comments,
  });

  const outcomes = await readOutcomes(optionValue(args, "--outcomes"));
  const pass = buildReplyPass({
    repo,
    number,
    comments: collected.comments,
    outcomes,
    maxReplies: parseNonNegativeInteger(optionValue(args, "--max-replies"), "--max-replies"),
    maxSentences: parseNonNegativeInteger(optionValue(args, "--max-sentences"), "--max-sentences"),
    maxChars: parseNonNegativeInteger(optionValue(args, "--max-chars"), "--max-chars"),
    flowLink: optionValue(args, "--flow-link"),
  });

  const result = await postReplyPass({
    port,
    cwd,
    repo,
    number,
    pass,
    // Checked for SHA shape, as `collect` already was — and then compared with
    // the pull request's head inside the pass, which it never used to be.
    sha: requiredSha(args, "--sha", "comments reply"),
    pull: collected.pull,
    allowClosed: args.includes("--allow-closed-pr"),
    round: { index: round, isFinal },
    state,
    dryRun,
  });

  console.log(`# review comments reply (${dryRun ? "dry run" : "posted"})`);
  console.log("");
  for (const request of result.requests) {
    console.log(`${request.method} ${request.path}`);
    console.log(`  ${(request.body as { body: string }).body}`);
  }
  console.log("");
  console.log(`posted: ${result.posted.length}`);
  console.log(`already answered (skipped): ${result.skipped.length}`);
  console.log(`backlog beyond the reply cap: ${result.backlog.length}${result.backlog.length === 0 ? "" : ` — ${result.backlog.join(", ")}`}`);
  if (result.escalated.length > 0) {
    console.error(
      `ESCALATE: ${result.escalated.length} comment(s) block progress rather than report a problem and were NOT replied to: ${result.escalated.join(
        ", ",
      )}. Ask the operator now; answering these at the end would answer the wrong question late.`,
    );
    process.exitCode = 1;
  }
}

/** `--fixtures <dir>` for an offline rehearsal, otherwise the live `gh` adapter. */
async function resolvePort(args: string[]): Promise<GitHubPort> {
  const fixtures = optionValue(args, "--fixtures");
  if (fixtures === undefined) {
    return createGhPort();
  }
  const files: Record<string, unknown> = {};
  for (const key of ["pull", "pull-comments", "pull-reviews", "issue-comments"]) {
    const file = join(fixtures, `${key}.json`);
    try {
      files[key] = JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch {
      files[key] = [];
    }
  }
  return createFixturePort(files);
}

// ---------------------------------------------------------------------------
// `keryx review ci-triage` — flow 306. Advisory-only flaky/infra/real-
// regression triage for one failed CI run's job, over a redacted, bounded log
// excerpt. See `src/review/ci-triage.ts` (the core logic) and
// `src/review/ci-port.ts` (the CI read port) for why each piece lives where
// it does; this function is the ADAPTER that glues the core-zone triage logic
// to the client-zone Jev client — the one place both may legally meet.
// ---------------------------------------------------------------------------

/**
 * `--fixtures <dir>`: the CI port answered from `ci-run-info.json`/
 * `ci-failed-log.txt`/`ci-history.json`, plus flow 307's signal files — all
 * optional; a fixtures dir built for flow 306 (none of them present) still
 * triages, just with every signal reading "not checked".
 *
 * `ci-related-runs.json` (optional: `{runs: {...}, logs: {...}}`, keyed by
 * run id) answers `runInfo`/`failedLog` for the OTHER runs a signal read
 * asks about — flow 307's cross-branch-history signal (AC1(b)) needs a
 * second run's own job list and log, not just the one under triage.
 */
async function fixtureCiPort(dir: string): Promise<CiPort> {
  const runInfo = JSON.parse(await readFile(join(dir, "ci-run-info.json"), "utf8")) as CiRunInfo;
  const log = await readFile(join(dir, "ci-failed-log.txt"), "utf8").catch(() => "");
  const history = await readFile(join(dir, "ci-history.json"), "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, readonly CiRunHistoryEntry[]>)
    .catch(() => ({}) as Record<string, readonly CiRunHistoryEntry[]>);
  const attempts = await readFile(join(dir, "ci-attempts.json"), "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, readonly CiAttemptJobs[]>)
    .catch(() => ({}) as Record<string, readonly CiAttemptJobs[]>);
  const changedFiles = await readFile(join(dir, "ci-changed-files.json"), "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, readonly string[]>)
    .catch(() => ({}) as Record<string, readonly string[]>);
  const runsByHeadSha = await readFile(join(dir, "ci-runs-by-head-sha.json"), "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, readonly CiRunHistoryEntry[]>)
    .catch(() => ({}) as Record<string, readonly CiRunHistoryEntry[]>);
  const related = await readFile(join(dir, "ci-related-runs.json"), "utf8")
    .then((raw) => JSON.parse(raw) as { runs?: Record<string, CiRunInfo>; logs?: Record<string, string> })
    .catch(() => ({}) as { runs?: Record<string, CiRunInfo>; logs?: Record<string, string> });
  return createFixtureCiPort({
    runs: { [runInfo.runId]: runInfo, ...related.runs },
    logs: { [runInfo.runId]: log, ...related.logs },
    history,
    attempts,
    changedFiles,
    runsByHeadSha,
  });
}

/** `--fixtures <dir>`: the Jev call answered from `jev-response.json`, verbatim, as a canned `Response`. No network call. */
async function fixtureJevFetch(dir: string): Promise<typeof fetch> {
  const body = await readFile(join(dir, "jev-response.json"), "utf8");
  const fn = async (): Promise<Response> => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  return fn as unknown as typeof fetch;
}

/** One job's full triage result — shared by the default `--run` path and the `--eval` harness. */
interface CiTriageJobResult {
  readonly runId: string;
  readonly job: string;
  readonly testName: string;
  readonly verdict: CiTriageVerdict;
  readonly signalLines: readonly string[];
  readonly usage: JevUsage;
}

/**
 * Flow 307: the shared pipeline — compute signals (AC1) when `useSignals`,
 * build `state`/`questions` accordingly (AC2), ask Jev, apply the
 * deterministic override (AC8). `useSignals: false` reproduces the flow 306
 * pipeline byte-for-byte, which is exactly what `--eval`'s "before" column
 * needs to stay an honest comparison.
 *
 * `rawLog` is a REQUIRED input, not read here (flow 307 review, item 2): the
 * failed-step log is a property of the RUN, not of the job, so a caller
 * triaging several jobs of the same run reads it once and passes the same
 * string to every call — `runCiTriage` below does exactly that. `precomputed`
 * is the matching run-level `computeCiSignals` input (`priorAttempts`/
 * `changedFiles`/`runsForHeadSha`), optional and only consulted when
 * `useSignals` is true; omitted, `computeCiSignals` reads them itself
 * exactly as it always did.
 */
async function triageOneJob(
  ciPort: CiPort,
  fetchFn: typeof fetch,
  info: CiRunInfo,
  job: CiJobSummary,
  opts: {
    readonly runId: string;
    readonly rawLog: string;
    readonly testNameOverride?: string | undefined;
    readonly model?: string | undefined;
    readonly useSignals: boolean;
    readonly precomputed?: CiSignalsPrecomputed;
  },
): Promise<CiTriageJobResult> {
  const rawLog = opts.rawLog;
  const testName = opts.testNameOverride ?? extractFailingTestName(rawLog, job.name) ?? "(unknown test)";
  const signals = opts.useSignals
    ? await computeCiSignals(
        ciPort,
        {
          runId: opts.runId,
          jobName: job.name,
          testName: testName === "(unknown test)" ? undefined : testName,
          rawLog,
          headSha: info.headSha,
          workflowName: info.workflowName,
        },
        undefined,
        opts.precomputed,
      )
    : undefined;
  const signalLines = signals?.lines ?? [];
  const state = buildCiTriageState({ testName, jobName: job.name, rawLog, ...(signalLines.length > 0 ? { signalLines } : {}) });
  const questions = buildCiTriageQuestions(opts.useSignals);
  const result = await callJevSystemOne(fetchFn, { model: opts.model ?? DEFAULT_JEV_MODEL, state, questions });
  const rawVerdict = computeCiTriageVerdict(result.answers as Record<string, { noul?: number }>);
  const verdict = signals !== undefined ? applyDeterministicOverride(rawVerdict, signals) : rawVerdict;
  return { runId: opts.runId, job: job.name, testName, verdict, signalLines, usage: result.usage };
}

/** AC10: the opt-in + credential gate, shared by `--run` and `--eval --live` — both refuse before any read/network call. */
async function refuseWithoutCiTriageGate(cwd: string): Promise<boolean> {
  if (!(await readCiTriageEnabled(cwd))) {
    console.error(
      "`review.jev.ci_triage` is not enabled for this project (.metaproject/tasks.config.json: " +
        '`{"review":{"jev":{"ci_triage":true}}}`). CI triage sends a redacted log excerpt to OpenRouter/TypeSafe, ' +
        "so it is opt-in — nothing was read and no network call was made.",
    );
    process.exitCode = 1;
    return true;
  }
  // AC7: the pre-flight message (no key at all) also names the two places a
  // key could have come from, even though there is no rejected credential to
  // attribute yet — consistent phrasing with the AC7 error the live call
  // raises when OpenRouter itself rejects one.
  const { key } = resolveJevApiKeyResolution(process.env);
  if (key === undefined || key.length === 0) {
    console.error(
      "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: CI triage needs a " +
        "Jev/OpenRouter credential (from either source) and made no network call.",
    );
    process.exitCode = 1;
    return true;
  }
  return false;
}

/**
 * How many failed jobs of one run `runCiTriage` will actually triage
 * (flow 307 review, item 2). A run with an unbounded number of failed jobs
 * previously triaged every one of them — one Jev call, and (with signals) up
 * to `HISTORY_RUNINFO_CAP` extra `gh` reads, PER JOB, with no ceiling. Beyond
 * this cap the remaining failed jobs are listed, in both the text and the
 * `--json` output, as not triaged rather than silently triaged anyway or
 * silently dropped — `--job <name>` still triages any one of them directly.
 */
export const MAX_JOBS_TRIAGED = 10;

async function runCiTriage(args: string[]): Promise<void> {
  rejectUnknownFlags(args, CI_TRIAGE_FLAGS, "ci-triage");
  const cwd = process.cwd();
  const evalFile = optionValue(args, "--eval");
  if (evalFile !== undefined) {
    await runCiTriageEval(cwd, args, evalFile);
    return;
  }
  const runId = requiredOption(args, "--run", "ci-triage");
  const repo = optionValue(args, "--repo");
  const fixturesDir = optionValue(args, "--fixtures");

  // AC10: opt-in per project, and refused before any network call — the log
  // excerpt leaves the machine only when the project asked for that.
  if (await refuseWithoutCiTriageGate(cwd)) {
    return;
  }

  const ciPort: CiPort = fixturesDir === undefined ? createGhCiPort(undefined, repo) : await fixtureCiPort(fixturesDir);
  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);

  const info = await ciPort.runInfo(runId);
  const jobArg = optionValue(args, "--job");
  // AC3: every failed job by default, one verdict per job; `--job` narrows to one.
  const failedJobs = jobArg !== undefined ? info.jobs.filter((j) => j.name === jobArg) : info.jobs.filter((j) => j.conclusion === "failure");
  if (failedJobs.length === 0) {
    throw new Error(
      `Run ${runId} has no ${jobArg !== undefined ? `job named "${jobArg}"` : "failed job"} to triage ` +
        `(jobs: ${info.jobs.map((j) => `${j.name} [${j.conclusion ?? "unknown"}]`).join(", ") || "none"}).`,
    );
  }
  const jobsToTriage = failedJobs.slice(0, MAX_JOBS_TRIAGED);
  const notTriaged = failedJobs.slice(MAX_JOBS_TRIAGED).map((j) => j.name);
  // `--test` only makes sense pinned to exactly one job; with several failed
  // jobs in scope it is ignored rather than silently mislabeling every job
  // with the same test name.
  const testOverride = failedJobs.length === 1 ? optionValue(args, "--test") : undefined;
  const model = optionValue(args, "--model");

  // Flow 307 review, item 2: the failed-step log is a property of the RUN,
  // not of the job — read it ONCE and reuse it for every job below, instead
  // of re-fetching the same text per job. `priorAttempts`/`changedFiles`/
  // `runsForHeadSha` likewise key on `runId`/`headSha`, never `jobName` — read
  // once here and handed to every `triageOneJob` call as `precomputed`, each
  // degrading to its own empty default on failure exactly as
  // `computeCiSignals`'s own internal reads already did.
  const rawLog = await ciPort.failedLog(runId);
  const [priorAttempts, changedFiles, runsForHeadSha] = await Promise.all([
    ciPort.priorAttempts(runId).catch(() => [] as readonly CiAttemptJobs[]),
    info.headSha === "" ? Promise.resolve([] as readonly string[]) : ciPort.changedFiles(info.headSha).catch(() => [] as readonly string[]),
    ciPort.runsForHeadSha(info.headSha, info.workflowName).catch(() => [] as readonly CiRunHistoryEntry[]),
  ]);
  // Flow 307 followups, item 4: one `runInfo` cache, shared across every job
  // below (via `precomputed`) — the same "read once, reuse per job" already
  // applied to `priorAttempts`/`changedFiles`/`runsForHeadSha` above, extended
  // to `computeCiSignals`'s OWN `runInfo` reads of other runs (cross-branch
  // history, same-head verification), which this precomputed object could not
  // cover before: those reads are not values that answer identically for
  // every job, they are lookups keyed on a DIFFERENT run id discovered while
  // computing each job's signals, so only a shared cache — not a shared value
  // — can de-duplicate them.
  const runInfoCache = new Map<string, Promise<CiRunInfo>>();
  const precomputed: CiSignalsPrecomputed = { priorAttempts, changedFiles, runsForHeadSha, runInfoCache };

  const results: CiTriageJobResult[] = [];
  for (const job of jobsToTriage) {
    results.push(
      await triageOneJob(ciPort, fetchFn, info, job, { runId, rawLog, testNameOverride: testOverride, model, useSignals: true, precomputed }),
    );
  }

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          results: results.map((r) => ({ runId: r.runId, job: r.job, testName: r.testName, verdict: r.verdict, usage: r.usage })),
          notTriaged,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    results
      .map((r) => renderCiTriageAdvisory({ runId: r.runId, jobName: r.job, testName: r.testName, verdict: r.verdict, signalLines: r.signalLines }))
      .join("\n\n"),
  );
  if (notTriaged.length > 0) {
    console.log("");
    console.log(`not triaged (cap ${MAX_JOBS_TRIAGED}; use --job): ${notTriaged.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// `keryx review ci-triage --eval` — flow 307, AC5/AC6. A committed, labelled
// evaluation set replayed either offline (each case's own fixtures, the
// default) or live (`--live`: real `gh` + real Jev, budgeted, opt-in and
// credential-gated exactly like `--run`). Reports "before" (flow 306: log
// only) and "after" (flow 307: log + signals) accuracy side by side, so a
// signals regression would show up as "after" reading worse than "before"
// rather than disappearing into a single number.
// ---------------------------------------------------------------------------

interface CiTriageEvalCase {
  readonly id: string;
  readonly runId: string;
  readonly job: string;
  readonly truth: CiTriageCriterion;
  /** Relative to the manifest file's own directory. Required unless `--live`. */
  readonly fixturesDir?: string;
}

interface CiTriageEvalManifest {
  readonly cases: readonly CiTriageEvalCase[];
}

interface CiTriageEvalCaseResult {
  readonly id: string;
  readonly runId: string;
  readonly job: string;
  readonly truth: CiTriageCriterion;
  readonly predictedBefore: CiTriageCriterion;
  readonly predictedAfter: CiTriageCriterion;
  readonly correctBefore: boolean;
  readonly correctAfter: boolean;
  readonly usageBefore: JevUsage;
  readonly usageAfter: JevUsage;
}

function accuracyOf(results: readonly CiTriageEvalCaseResult[], key: "correctBefore" | "correctAfter"): number {
  return results.length === 0 ? 0 : results.filter((r) => r[key]).length / results.length;
}

function costOf(results: readonly CiTriageEvalCaseResult[], key: "usageBefore" | "usageAfter"): number {
  return results.reduce((sum, r) => sum + (r[key].cost ?? 0), 0);
}

async function runCiTriageEval(cwd: string, args: string[], evalFile: string): Promise<void> {
  const live = args.includes("--live");
  const repo = optionValue(args, "--repo");
  const model = optionValue(args, "--model");

  if (live && (await refuseWithoutCiTriageGate(cwd))) {
    return;
  }

  let manifest: CiTriageEvalManifest;
  try {
    manifest = JSON.parse(await readFile(evalFile, "utf8")) as CiTriageEvalManifest;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- The file path is the actionable part; the cause is summarised inline.
    throw new Error(`\`--eval ${evalFile}\` could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error(`\`--eval ${evalFile}\` has no "cases" array — nothing to evaluate.`);
  }
  const manifestDir = path.dirname(evalFile);

  const results: CiTriageEvalCaseResult[] = [];
  for (const c of manifest.cases) {
    if (!live && c.fixturesDir === undefined) {
      throw new Error(`case "${c.id}" has no "fixturesDir", and this is not a \`--live\` run — nothing to replay it from.`);
    }
    const caseDir = c.fixturesDir !== undefined ? path.join(manifestDir, c.fixturesDir) : undefined;
    const ciPort: CiPort = live ? createGhCiPort(undefined, repo) : await fixtureCiPort(caseDir as string);
    const jevFetch: typeof fetch = live ? globalThis.fetch : await fixtureJevFetch(caseDir as string);
    const info = await ciPort.runInfo(c.runId);
    const job = info.jobs.find((j) => j.name === c.job);
    if (job === undefined) {
      throw new Error(`case "${c.id}": run ${c.runId} has no job named "${c.job}".`);
    }
    // One job per case, so one `failedLog` read is already the minimum — read
    // once and share it between the "before"/"after" passes rather than
    // fetching it twice for the same run (flow 307 review, item 2).
    const rawLog = await ciPort.failedLog(c.runId);
    const before = await triageOneJob(ciPort, jevFetch, info, job, { runId: c.runId, rawLog, model, useSignals: false });
    const after = await triageOneJob(ciPort, jevFetch, info, job, { runId: c.runId, rawLog, model, useSignals: true });
    results.push({
      id: c.id,
      runId: c.runId,
      job: c.job,
      truth: c.truth,
      predictedBefore: before.verdict.top,
      predictedAfter: after.verdict.top,
      correctBefore: before.verdict.top === c.truth,
      correctAfter: after.verdict.top === c.truth,
      usageBefore: before.usage,
      usageAfter: after.usage,
    });
  }

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          live,
          cases: results.length,
          before: { accuracy: accuracyOf(results, "correctBefore"), costUsd: costOf(results, "usageBefore") },
          after: { accuracy: accuracyOf(results, "correctAfter"), costUsd: costOf(results, "usageAfter") },
          results,
        },
        null,
        2,
      ),
    );
    return;
  }

  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  console.log(`# CI triage evaluation (${live ? "LIVE" : "fixtures"}) — ${results.length} case(s)`);
  console.log("");
  console.log(`before (flow 306, log only):     ${pct(accuracyOf(results, "correctBefore"))} correct, ~$${costOf(results, "usageBefore").toFixed(4)}`);
  console.log(`after  (flow 307, log + signals): ${pct(accuracyOf(results, "correctAfter"))} correct, ~$${costOf(results, "usageAfter").toFixed(4)}`);
  console.log("");
  for (const r of results) {
    const beforeMark = r.correctBefore ? "OK" : "X ";
    const afterMark = r.correctAfter ? "OK" : "X ";
    console.log(`  ${r.id}: truth=${r.truth}  before=${r.predictedBefore} [${beforeMark}]  after=${r.predictedAfter} [${afterMark}]`);
  }
}

// ---------------------------------------------------------------------------
// `keryx review conform` — flow 308, reference-document conformance mode
// (PRD.md Requirements 24-29 / PLAN.md Phase 2). Core logic lives in
// `src/review/conform-*.ts`; this is the ADAPTER that reads the reference
// document and the target off disk/`gh`, calls the client-zone Jev client,
// and (with `--explain`) a single-turn model call — the one place all three
// may legally meet, same shape as `ci-triage` above.
// ---------------------------------------------------------------------------

/** `--fixtures <dir>`: every Jev call in this command reads the SAME canned response, like `ci-triage`'s own `--fixtures`. */
async function fixtureConformJevFetch(dir: string): Promise<typeof fetch> {
  const body = await readFile(join(dir, "jev-response.json"), "utf8");
  const fn = async (): Promise<Response> => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  return fn as unknown as typeof fetch;
}

/** `--fixtures <dir>`: the pr-kind port answered from `pr.json` (`{number,title,body,diff}`). */
async function fixtureConformPrPortFrom(dir: string): Promise<ReturnType<typeof createFixtureConformPrPort>> {
  const pr = JSON.parse(await readFile(join(dir, "pr.json"), "utf8")) as { number: number; title: string; body: string; diff: string };
  return createFixtureConformPrPort({ pr });
}

interface ConformUsageAccumulator {
  jevCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sawUsage: boolean;
}

function accumulateJevUsage(acc: ConformUsageAccumulator, usage: { input_tokens?: number; output_tokens?: number; cost?: number }): void {
  acc.jevCalls += 1;
  if (usage.input_tokens !== undefined) {
    acc.inputTokens += usage.input_tokens;
    acc.sawUsage = true;
  }
  if (usage.output_tokens !== undefined) {
    acc.outputTokens += usage.output_tokens;
    acc.sawUsage = true;
  }
  if (usage.cost !== undefined) {
    acc.costUsd += usage.cost;
    acc.sawUsage = true;
  }
}

/**
 * AC2: resolve every raw clause's tag — explicit markers first (no Jev call),
 * then the project's cache, then one `choice` question per remaining clause,
 * batched into a single request (clause classification needs no per-clause
 * state beyond the clause text itself, so it is never split by the 64k
 * budget in practice — the questions alone would have to exceed it).
 */
async function resolveConformClauseTags(
  cwd: string,
  refPath: string,
  docText: string,
  rawClauses: ReturnType<typeof extractReferenceClauses>,
  fetchFn: typeof fetch,
  model: string,
  acc: ConformUsageAccumulator,
): Promise<ReferenceClause[]> {
  const contentHash = hashConformDocContent(docText);
  const cache = await readClauseTagCache(cwd);
  const cachedTags = cachedTagsFor(cache, refPath, contentHash) ?? {};
  const resolved = new Map<string, { source: "jev" | "cache"; tag: ReturnType<typeof clauseTagFromChoice> }>();
  for (const [id, tag] of Object.entries(cachedTags)) {
    resolved.set(id, { source: "cache", tag });
  }
  const needsTagging = rawClauses.filter((c) => c.explicit === undefined && cachedTags[c.clause_id] === undefined);
  const tagQuestions = buildClauseTagQuestions(needsTagging);
  if (Object.keys(tagQuestions).length > 0) {
    const result = await callJevSystemOne(fetchFn, {
      model,
      state: "Reference-document clause classification — no additional state beyond each clause's own text.",
      questions: tagQuestions,
    });
    accumulateJevUsage(acc, result.usage);
    const freshTags: Record<string, ReturnType<typeof clauseTagFromChoice>> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      if (answer.type !== "choice") continue;
      const tag = clauseTagFromChoice(answer.choice);
      resolved.set(id, { source: "jev", tag });
      freshTags[id] = tag;
    }
    if (Object.keys(freshTags).length > 0) {
      await writeClauseTagCache(cwd, refPath, contentHash, freshTags);
    }
  }
  return applyClauseTags(rawClauses, resolved);
}

/**
 * AC5: score every checkable clause of one kind against its shared redacted
 * state, batched under budget. `location` (flow 326, AC1) is set by the
 * caller when `items` is one hunk region's hunk-kind clauses — it is stamped
 * onto every verdict produced here so a later aggregation pass can group
 * multiple hunks' verdicts for the same clause_id back into one row.
 */
async function scoreConformClauses(
  items: readonly ConformBatchItem[],
  sharedRedactedText: string,
  fetchFn: typeof fetch,
  model: string,
  threshold: number,
  acc: ConformUsageAccumulator,
  location?: ConformHunkLocation,
): Promise<ConformVerdict[]> {
  const verdicts: ConformVerdict[] = [];
  for (const batch of batchConformItems(items, sharedRedactedText)) {
    const result = await callJevSystemOne(fetchFn, { model, state: batch.state, questions: batch.questions });
    accumulateJevUsage(acc, result.usage);
    for (const item of batch.items) {
      const answer = result.answers[item.clause.clause_id];
      const probability = answer?.type === "noul" ? answer.noul : 0;
      verdicts.push(evaluatedVerdict(item.clause, item.facts, probability, threshold, location));
    }
  }
  return verdicts;
}

/** AC7: the `review`-category model (the session model when unset), same resolution `applyReviewRoutingCategory` uses, without the live provider-catalog probe a text explanation does not need. */
async function resolveConformExplainModel(cwd: string): Promise<{ provider?: string; model?: string }> {
  const location = { cwd };
  const [project, user] = await Promise.all([loadRoutingConfig("project", location), loadRoutingConfig("user", location)]);
  const { assignment } = resolveCategoryDetailed("review", { project: project.table, user: user.table });
  if (assignment.kind === "model") return { provider: assignment.providerId, model: assignment.modelId };
  if (assignment.kind === "provider-default") {
    const modelId = resolveProviderDefaultModelId(assignment.providerId);
    if (modelId !== undefined) return { provider: assignment.providerId, model: modelId };
  }
  return {};
}

/**
 * AC7: explain every clause scored below `threshold` — citing the clause id
 * and its evidence, labelled advisory, never written to `findings.json` or
 * the PR (this function only returns text; nothing here has a write path).
 * `--fixtures <dir>` answers from `explain-response.json`
 * (`{[clause_id]: text}`) instead of calling a model at all — the wiring
 * under test is "the text ends up in the report, labelled advisory", not
 * `runModelTurn` itself, which has its own tests.
 *
 * `runTurn` is injectable (defaults to the real `runModelTurn`) so a test can
 * assert on the exact `user` prompt sent — including that it never carries
 * the full `refPath` — without `mock.module`-ing a shared provider module
 * for the whole `bun test` process (see `health-truthful-gate.test.ts`'s
 * comment on why that pattern was tried and rejected here).
 */
export async function explainConformVerdicts(
  cwd: string,
  refPath: string,
  verdicts: readonly ConformVerdict[],
  threshold: number,
  fixturesDir: string | undefined,
  runTurn: typeof runModelTurn = runModelTurn,
): Promise<Record<string, string>> {
  const toExplain = verdicts.filter((v) => v.status === "likely-violated" && v.probability !== undefined && v.probability < threshold);
  if (toExplain.length === 0) return {};
  if (fixturesDir !== undefined) {
    try {
      return JSON.parse(await readFile(join(fixturesDir, "explain-response.json"), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  const { provider, model } = await resolveConformExplainModel(cwd);
  const explanations: Record<string, string> = {};
  for (const verdict of toExplain) {
    const result = await runTurn({
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      system:
        "You explain, in 2-4 sentences, why a reference-document clause looks violated, citing the clause id and the " +
        "evidence given. This is ADVISORY analysis only — you are not writing a finding, not editing any file, and " +
        "nothing you say is posted anywhere automatically.",
      user: [
        // The full path is never sent — it can name a private project, a
        // username, or other local filesystem detail with no bearing on the
        // clause itself. Only the document's own filename, redacted like
        // every other piece of state this command sends to Jev.
        `Reference document: ${redactSensitiveText(path.basename(refPath))}`,
        `Clause ${verdict.clause_id} (kind: ${verdict.state_kind})`,
        `Jev's probability the state satisfies this clause: ${verdict.probability}`,
        "Deterministic evidence:",
        ...verdict.factLines.map((line) => `- ${line}`),
      ].join("\n"),
    });
    if (result.text.length > 0) explanations[verdict.clause_id] = result.text;
  }
  return explanations;
}

function parseThresholdFlag(args: string[]): number {
  const raw = optionValue(args, "--threshold");
  if (raw === undefined) return DEFAULT_CONFORM_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--threshold must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

/** Flow 326, AC1: `--max-hunks` (default {@link DEFAULT_MAX_HUNKS}) — further violating hunk locations shown per clause, beyond the worst. */
function parsePositiveIntFlag(args: string[], flag: string, fallback: number): number {
  const raw = optionValue(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

async function readReportFindings(reportDir: string): Promise<readonly ReportFindingLike[]> {
  try {
    const raw = JSON.parse(await readFile(join(reportDir, "findings.json"), "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as ReportFindingLike[]) : [];
  } catch {
    return [];
  }
}

interface HunkScoringResult {
  readonly verdicts: readonly ConformVerdict[];
  /** clause_ids that got at least 1 judged hunk this run — AC3: a clause whose budget share rounded to 0 is NOT in here. */
  readonly supplied: ReadonlySet<string>;
  readonly hunkBudget?: ConformHunkBudget;
  /** The diff's own hunk count (AC3's "N" in "0 of N hunks judged") — 0 when the diff has no hunks at all, distinct from "budget ran out". */
  readonly totalRegions: number;
}

/**
 * Flow 326, AC3: score every hunk-kind clause against `allRegions`, honoring
 * `--max-hunk-calls`'s per-clause floor (`boundHunkRegions`) — each region is
 * scored only for the clauses whose quota still reaches it
 * (`activeClausesAt`), so a clause that got fewer hunks than another (or
 * none at all) never gets asked about a hunk beyond its own share. Shared by
 * both the `--pr` and the diff/`--report`-absent branches of `runConform`
 * below, which otherwise duplicated this exact loop.
 */
async function scoreHunkClauses(
  hunkClauses: readonly ReferenceClause[],
  allRegions: readonly ScopedRegion[],
  maxHunkCalls: number,
  fetchFn: typeof fetch,
  model: string,
  threshold: number,
  acc: ConformUsageAccumulator,
): Promise<HunkScoringResult> {
  const hunkClauseIds = hunkClauses.map((c) => c.clause_id);
  const byId = new Map(hunkClauses.map((c) => [c.clause_id, c]));
  const bounded = boundHunkRegions(allRegions, hunkClauseIds, maxHunkCalls);
  const supplied = new Set<string>();
  for (const id of hunkClauseIds) {
    if ((bounded.judgedPerClause.get(id) ?? 0) > 0) supplied.add(id);
  }
  let verdicts: ConformVerdict[] = [];
  let index = 0;
  for (const region of bounded.regions) {
    const activeClauses = activeClausesAt(bounded.judgedPerClause, index, hunkClauseIds).map((id) => byId.get(id)!);
    const items: ConformBatchItem[] = activeClauses.map((clause) => ({ clause, facts: hunkClauseFacts(region) }));
    verdicts = verdicts.concat(
      await scoreConformClauses(items, hunkRedactedStateText(region), fetchFn, model, threshold, acc, {
        path: region.path,
        startLine: region.startLine,
        endLine: region.endLine,
      }),
    );
    index += 1;
  }
  let hunkBudget: ConformHunkBudget | undefined;
  if (bounded.skippedRegions > 0) {
    hunkBudget = {
      maxHunkCalls,
      totalHunks: bounded.totalRegions,
      hunksJudged: bounded.regions.length,
      hunksSkipped: bounded.skippedRegions,
      truncatedClauses: hunkClauseIds.filter((id) => (bounded.judgedPerClause.get(id) ?? 0) < bounded.totalRegions),
    };
  }
  return { verdicts, supplied, ...(hunkBudget !== undefined ? { hunkBudget } : {}), totalRegions: bounded.totalRegions };
}

async function runConform(args: string[]): Promise<void> {
  rejectUnknownFlags(args, CONFORM_FLAGS, "conform");
  const cwd = process.cwd();
  const refPath = requiredOption(args, "--ref", "conform");
  const prArg = optionValue(args, "--pr");
  const reportDir = optionValue(args, "--report");
  const diffRef = optionValue(args, "--diff");
  if ([prArg, reportDir, diffRef].filter((v) => v !== undefined).length !== 1) {
    throw new Error(
      "Usage: keryx review conform --ref <doc> (--pr <n> | --report <dir> | --diff <ref>) [--explain] [--json] " +
        "[--max-hunks N] [--max-hunk-calls N] [--detail]",
    );
  }
  const threshold = parseThresholdFlag(args);
  // Flow 326, AC1/AC3: how many further violating hunk locations a clause row
  // shows, and how many hunk × clause questions the whole run may ask.
  const maxHunks = parsePositiveIntFlag(args, "--max-hunks", DEFAULT_MAX_HUNKS);
  const maxHunkCalls = parsePositiveIntFlag(args, "--max-hunk-calls", DEFAULT_MAX_HUNK_CALLS);
  const detail = args.includes("--detail");
  const fixturesDir = optionValue(args, "--fixtures");
  const explain = args.includes("--explain");

  // AC9: opt-in per project, and refused before any network call.
  if (!(await readConformEnabled(cwd))) {
    console.error(
      "`review.jev.conform` is not enabled for this project (.metaproject/tasks.config.json: " +
        '`{"review":{"jev":{"conform":true}}}`). Conformance checking sends redacted PR/report/hunk text to ' +
        "OpenRouter/TypeSafe, so it is opt-in — nothing was read and no network call was made.",
    );
    process.exitCode = 1;
    return;
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    console.error(
      "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: conformance checking " +
        "needs a Jev/OpenRouter credential and made no network call.",
    );
    process.exitCode = 1;
    return;
  }

  const docText = await readFile(refPath, "utf8");
  const rawClauses = extractReferenceClauses(docText);
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;
  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureConformJevFetch(fixturesDir);
  const acc: ConformUsageAccumulator = { jevCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sawUsage: false };

  const clauses = await resolveConformClauseTags(cwd, refPath, docText, rawClauses, fetchFn, model, acc);
  // AC8 support: remember this reference document for the TUI picker's recents list.
  // 0o600: this file names reference documents the operator has been reading —
  // local filesystem paths other users on the same machine should not see.
  await writeFileAtomic(
    join(cwd, CONFORM_RECENTS_PATH),
    `${JSON.stringify(withRecentDoc(await readRecentConformDocs(cwd), refPath), null, 2)}\n`,
    { mode: 0o600 },
  ).catch(() => {});

  const notCheckable = clauses.filter((c) => !c.checkable);
  const checkable = clauses.filter((c) => c.checkable);

  let target: ConformTarget;
  let evaluated: ConformVerdict[] = [];
  // AC6: a checkable clause whose kind has no state supplied this run is
  // "not evaluated" — tracked per CLAUSE, not per kind, so a kind that DOES
  // have a target this run but happens to produce zero regions (an empty
  // diff, an empty report) still reports its clauses as not-evaluated rather
  // than silently vanishing them.
  const supplied = new Set<string>();
  // Flow 326, AC3: set only when `--max-hunk-calls` actually truncated the
  // hunks judged this run — never silently.
  let hunkBudget: ConformHunkBudget | undefined;
  // Flow 326, AC3: the diff's own hunk count, so a hunk-kind clause the
  // budget skipped entirely (0 judged) can say "0 of N" rather than being
  // indistinguishable from a diff with no hunks in it at all (N === 0 there).
  let hunkTotalRegions = 0;

  if (prArg !== undefined) {
    const number = Number(prArg);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`--pr must be a positive integer, got "${prArg}".`);
    const port = fixturesDir === undefined ? createGhConformPrPort(undefined, optionValue(args, "--repo")) : await fixtureConformPrPortFrom(fixturesDir);
    const info = await port.pr(number);
    target = { kind: "pr", label: `PR #${info.number} — ${info.title}` };
    const facts = computePrConformFacts(info);
    const redacted = prRedactedStateText(info);
    const prClauses = checkable.filter((c) => c.state_kind === "pr");
    for (const clause of prClauses) supplied.add(clause.clause_id);
    const prItems: ConformBatchItem[] = prClauses.map((clause) => ({ clause, facts: prClauseFacts(clause, facts) }));
    evaluated = evaluated.concat(await scoreConformClauses(prItems, redacted, fetchFn, model, threshold, acc));

    const hunkClauses = checkable.filter((c) => c.state_kind === "hunk");
    const hunkResult = await scoreHunkClauses(hunkClauses, hunkRegionsFromDiff(info.diff), maxHunkCalls, fetchFn, model, threshold, acc);
    evaluated = evaluated.concat(hunkResult.verdicts);
    for (const id of hunkResult.supplied) supplied.add(id);
    hunkBudget = hunkResult.hunkBudget;
    hunkTotalRegions = hunkResult.totalRegions;
  } else if (reportDir !== undefined) {
    target = { kind: "report", label: reportDir };
    const reportMarkdown = await readFile(join(reportDir, "report.md"), "utf8").catch(() => "");
    const findings = await readReportFindings(reportDir);
    const facts = computeReportConformFacts(reportMarkdown, findings);
    const redacted = reportRedactedStateText(reportMarkdown);
    const reportClauses = checkable.filter((c) => c.state_kind === "report");
    for (const clause of reportClauses) supplied.add(clause.clause_id);
    const items: ConformBatchItem[] = reportClauses.map((clause) => ({ clause, facts: reportClauseFacts(clause, facts) }));
    evaluated = await scoreConformClauses(items, redacted, fetchFn, model, threshold, acc);
  } else {
    const diff = await gitDiff(diffRef, DEFAULT_CONTEXT_LINES);
    target = { kind: "diff", label: diffRef ?? "working diff" };
    const hunkClauses = checkable.filter((c) => c.state_kind === "hunk");
    const hunkResult = await scoreHunkClauses(hunkClauses, hunkRegionsFromDiff(diff), maxHunkCalls, fetchFn, model, threshold, acc);
    evaluated = evaluated.concat(hunkResult.verdicts);
    for (const id of hunkResult.supplied) supplied.add(id);
    hunkBudget = hunkResult.hunkBudget;
    hunkTotalRegions = hunkResult.totalRegions;
  }

  // Flow 326, AC3: a hunk-kind clause the budget skipped entirely (0 judged,
  // but the diff DID have hunks — hunkTotalRegions > 0) is not-evaluated for
  // a specific, visible reason — distinct from a kind with no state at all
  // this run (a --report target, or a diff with literally no hunks).
  const notEvaluated = checkable
    .filter((c) => !supplied.has(c.clause_id))
    .map((c) =>
      c.state_kind === "hunk" && hunkTotalRegions > 0
        ? notEvaluatedVerdict(c, `skipped by --max-hunk-calls (0 of ${hunkTotalRegions} hunks judged)`)
        : notEvaluatedVerdict(c),
    );
  const verdicts: ConformVerdict[] = [...evaluated, ...notEvaluated, ...notCheckable.map((c) => notCheckableVerdict(c))];

  // Flow 326, AC1: explain the WORST hunk per clause, not every hunk that
  // scored below threshold — one advisory explanation per clause, matching
  // the one-row-per-clause report rather than re-introducing the hunk ×
  // clause explosion this flow removes from the report itself.
  const explainCandidates = explain
    ? aggregateConformVerdicts(verdicts, maxHunks)
        .map((a) => a.worstVerdict)
        .filter((v): v is ConformVerdict => v !== undefined)
    : [];
  const explanations = explain ? await explainConformVerdicts(cwd, refPath, explainCandidates, threshold, fixturesDir) : undefined;

  const result = {
    refPath,
    target,
    threshold,
    verdicts,
    ...(explanations !== undefined && Object.keys(explanations).length > 0 ? { explanations } : {}),
    ...(hunkBudget !== undefined ? { hunkBudget } : {}),
    usage: acc.sawUsage
      ? { jevCalls: acc.jevCalls, inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, costUsd: acc.costUsd }
      : { jevCalls: acc.jevCalls },
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(conformResultToJson(result, { maxHunks, detail }), null, 2));
    return;
  }
  console.log(renderConformMarkdown(result, { maxHunks, detail }));
}

async function readRecentConformDocs(cwd: string): Promise<readonly string[]> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, CONFORM_RECENTS_PATH), "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * The login we are acting as, resolved once.
 *
 * With `--fixtures` there is no `gh` to ask, so the flag is required; without an
 * identity the collector refuses rather than filtering nothing, which is the
 * behaviour that would make a reply pass answer its own replies.
 */
async function resolveSelfLogin(args: string[]): Promise<string> {
  const explicit = optionValue(args, "--self");
  if (explicit !== undefined) {
    return explicit;
  }
  if (optionValue(args, "--fixtures") !== undefined) {
    throw new Error("`--self <login>` is required with `--fixtures`: there is no `gh` to ask who we are.");
  }
  const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const login = stdout.trim();
  if (exitCode !== 0 || login === "") {
    throw new Error(
      "Could not resolve the acting GitHub login (`gh api user --jq .login`). Pass `--self <login>`. Collecting without it would treat our own replies as a reviewer's and answer them every round.",
    );
  }
  return login;
}

/**
 * The `review-pr-feedback` result, refused here or nowhere.
 *
 * This is the contract's only enforcement point, and it exists because the
 * skill's own SKILL.md said the quiet part: "Nothing refuses a dispatch that
 * ignores them — no production code loads either file". A schema nothing loads
 * describes a shape rather than requiring one.
 *
 * It sits on `comments reply` rather than anywhere cheaper because this is the
 * command that acts OUTWARD — it writes into someone else's pull request. A
 * result that contradicts itself is worth refusing at the last moment before
 * that, not after. So the check runs before the pass is built, and its failure
 * posts nothing.
 *
 * Optional, deliberately: the flag is how a caller offers the result for
 * checking, and making it required would break every existing invocation to no
 * benefit. A caller that omits it gets the behaviour it had before — which the
 * registry records honestly as the limit of this enforcement rather than
 * rounding up to "the contract is enforced".
 */
/**
 * Posting replies needs a managed context — a lightweight review is report-only.
 *
 * `review-orchestrator` declares `lightweight` as "report-only; no artifacts",
 * and its Step 14 still told an agent to run `comments reply` unconditionally —
 * so a plain "review this PR" ended by posting to the pull request. The mode is
 * not something this command can be told and trust, so it asks for evidence
 * instead: the managed review package the round wrote (`--review`, whose target
 * must be this pull request), or the `review-pr-feedback` result (`--result`,
 * already validated above). A lightweight review has neither. A dry run posts
 * nothing and is always allowed.
 */
async function refuseUnmanagedReply(args: string[], repo: string, number: number, postsNothing: boolean): Promise<void> {
  // `postsNothing`: a dry run, or a non-final round that the pass refuses with its own, more specific reason.
  if (postsNothing || optionValue(args, "--result") !== undefined) {
    return;
  }
  const where = `${repo}#${number}`;
  const ref = optionValue(args, "--review");
  if (ref === undefined) {
    throw new Error(
      `Refusing to reply on ${where}: posting is for a MANAGED review, and nothing here shows one. Pass \`--review <review-id-or-path>\` (the package \`keryx review start/attach\` wrote for this pull request) or \`--result <file>\` (a review-pr-feedback run). A lightweight review is report-only — it answers nobody. \`--dry-run\` still shows what would be posted.`,
    );
  }
  let manifest;
  try {
    manifest = await getManagedReviewStatus(process.cwd(), ref);
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- The package ref is the actionable part; the cause is summarised inline.
    throw new Error(
      `Refusing to reply on ${where}: \`--review ${ref}\` is not a readable managed review package (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const target = manifest.target;
  const refNumber = /(?:^|[/#])(\d+)\/?$/.exec(target.ref.trim())?.[1];
  const repoMismatch = target.repository !== undefined && target.repository !== "" && !target.repository.toLowerCase().endsWith(repo.toLowerCase());
  if (target.kind !== "pr" || refNumber !== String(number) || repoMismatch) {
    throw new Error(
      `Refusing to reply on ${where}: \`--review ${ref}\` reviewed ${target.kind} \`${target.ref}\`${target.repository ? ` in ${target.repository}` : ""}, not this pull request. A reply pass answers the review that produced its outcomes.`,
    );
  }
}

async function refuseInvalidResult(source: string | undefined, outcomesSource: string | undefined): Promise<void> {
  if (source === undefined) {
    return;
  }
  if (source === "-" && outcomesSource === "-") {
    throw new Error(
      "`--result -` and `--outcomes -` both read standard input, which can only be consumed once. Pass at least one of them as a file path.",
    );
  }

  const raw = source === "-" ? await Bun.stdin.text() : await readFile(source, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Surface the parse position without the raw stack.
    throw new Error(
      `\`--result ${source}\` is not JSON: ${error instanceof Error ? error.message : String(error)}. Nothing was posted.`,
    );
  }

  const schema = await loadSchema("review-pr-feedback-output");
  const errors = await validateJson(parsed, schema);
  if (errors.length > 0) {
    // Every failing field named, not just the count: a refusal that says "3
    // errors" sends the reader back to the schema to find out which three.
    throw new Error(
      `\`--result ${source}\` does not satisfy the review-pr-feedback-output contract, so nothing was posted:\n${errors
        .map((error) => `  ${error.path}: ${error.message}`)
        .join("\n")}`,
    );
  }
}

async function readOutcomes(source: string | undefined): Promise<CommentOutcome[]> {
  if (source === undefined) {
    throw new Error(
      "`--outcomes <file|->` is required: it carries one disposition and one reply sentence per collected comment. The judgement is the model's; this command only enforces the budget, the threading and the once-at-the-end rule.",
    );
  }
  const raw = source === "-" ? await Bun.stdin.text() : await readFile(source, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array of outcomes in ${source}, got ${typeof parsed}.`);
  }
  return parsed as CommentOutcome[];
}

function requiredOption(args: string[], name: string, usage: string): string {
  const value = optionValue(args, name);
  if (value === undefined || value === "") {
    throw new Error(`\`${name}\` is required for \`keryx review ${usage}\`.`);
  }
  return value;
}

/** A required flag that must carry a commit SHA, checked the way `--head` is. */
function requiredSha(args: string[], name: string, usage: string): string {
  const value = requiredOption(args, name, usage);
  if (!/^[0-9a-f]{7,40}$/i.test(value.trim())) {
    throw new Error(
      `\`${name} "${value}"\` is not a commit SHA. Give the head this pass ran against (\`git rev-parse HEAD\`), 7-40 hex characters.`,
    );
  }
  return value.trim().toLowerCase();
}

function requiredInteger(args: string[], name: string): number {
  const parsed = parseNonNegativeInteger(optionValue(args, name), name);
  if (parsed === undefined) {
    throw new Error(`\`${name} <n>\` is required.`);
  }
  return parsed;
}

/**
 * `keryx review learn` — the join, and nothing more.
 *
 * Reads the record `review comments collect` wrote, keeps the comments whose
 * author the project configured, renders them, and hands the rendering to the
 * existing `learnProjectSkill`. It makes no network call and it writes no
 * `SKILL.md`: the output is a proposal, and `keryx skills learn apply` remains
 * the only writer.
 *
 * Three exits worth naming:
 *
 *   - **No config**: one plain line, exit 0. A project that does not learn is the
 *     normal case, not a problem to warn about.
 *   - **No record**: an error. The caller asked to learn from a pull request that
 *     was never collected, and inventing an empty result would report a
 *     successful pass over comments nobody read.
 *   - **Config present, no configured author commented**: exit 0 with the counts.
 *     Nothing was learned and the reason is visible.
 */
async function runLearn(args: string[]): Promise<void> {
  rejectUnknownFlags(args, LEARN_FLAGS, "learn --pr <n> | --reviewer <id>");
  // R2-F7: parse the verb's own args ONCE with `parseLearnArgs` — the same
  // parser `--reviewer` mode already used below it — instead of re-deriving
  // `--dry-run`/`--json` with `args.includes` and `--reviewer` with
  // `optionValue` on the `--pr` path. Those disagreed with the parser in two
  // ways: `--dry-run=1` passed `rejectUnknownFlags` (it only checks flag
  // NAMES) and then `args.includes("--dry-run")` read it as absent, so a
  // preview request on the `--pr` path silently produced the real write;
  // and a repeated or valueless `--reviewer` was never refused at all
  // (`optionValue` just returns the last/`undefined` one).
  const parsed = parseLearnArgs(args, { boolean: ["--dry-run", "--json"], value: ["--pr", "--reviewer"] });
  if (parsed.bad.length > 0) {
    throw new Error(`Unknown option(s) for \`keryx review learn\`: ${parsed.bad.join(", ")}.`);
  }
  const reviewerOccurrences = args.filter((arg) => arg === "--reviewer" || arg.startsWith("--reviewer=")).length;
  if (reviewerOccurrences > 1) {
    throw new Error("`--reviewer` was given more than once for `keryx review learn`.");
  }
  const reviewerId = parsed.values.get("--reviewer");
  if (reviewerId !== undefined) {
    if (reviewerId.trim().length === 0) {
      throw new Error("`--reviewer <id>` needs a value.");
    }
    await runLearnReviewer(args, reviewerId);
    return;
  }
  const cwd = process.cwd();
  const config = await loadReviewLearningConfig(cwd);
  if (config === null) {
    console.log(
      `no review learning configured: ${path.relative(cwd, reviewLearningConfigPath(cwd))} is absent, so this project does not learn from pull-request comments.`,
    );
    return;
  }

  const number = parseNonNegativeInteger(parsed.values.get("--pr"), "--pr");
  if (number === undefined) {
    throw new Error("`--pr <n>` is required.");
  }
  const statePath = prCommentsStatePath(cwd, config.repo, number);
  if (!(await pathExists(statePath))) {
    throw new Error(
      `No collected comments for ${config.repo}#${number}: ${path.relative(cwd, statePath)} does not exist. Run \`keryx review comments collect --repo ${config.repo} --pr ${number} --sha <head-sha>\` first — this command reads that record and never fetches from GitHub.`,
    );
  }

  const state = await readPrCommentState(cwd, config.repo, number);
  const selection = selectLearnableComments(state, config.authors);
  const sourcePath = learningSourcePath(cwd, config.repo, number);
  const recordPath = learningRecordPath(cwd, config.repo, number);
  const relativeSourcePath = toPosix(path.relative(cwd, sourcePath));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFileAtomic(sourcePath, renderLearningSource(selection));
  await writeFileAtomic(
    recordPath,
    renderLearningRecord({
      repo: config.repo,
      number,
      skill: config.skill,
      authors: config.authors,
      selection,
      collectedSha: state.collected_sha,
    }),
  );

  if (selection.kept.length === 0) {
    const detail = [
      `comments in the record: ${state.seen.length}`,
      `from a configured author: ${selection.kept.length + selection.bodyless.length}`,
      `excluded as unconfigured: ${selection.unconfigured.length}`,
      `configured but with no recorded body: ${selection.bodyless.length}`,
    ].join(", ");
    if (parsed.flags.has("--json")) {
      console.log(
        JSON.stringify(
          { repo: config.repo, number, skill: config.skill, source: relativeSourcePath, proposal: null, selection: counts(state, selection) },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`nothing to learn from ${config.repo}#${number} — ${detail}.`);
    console.log(`Source: ${relativeSourcePath}`);
    console.log(`Record: ${toPosix(path.relative(cwd, recordPath))}`);
    return;
  }

  const proposal = await learnProjectSkill(cwd, {
    sourceType: "review",
    sourcePath: relativeSourcePath,
    skill: config.skill,
    dryRun: parsed.flags.has("--dry-run"),
  });

  if (parsed.flags.has("--json")) {
    console.log(
      JSON.stringify(
        { repo: config.repo, number, skill: config.skill, source: relativeSourcePath, proposal, selection: counts(state, selection) },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${proposal.dryRun ? "Would create" : "Created"} learning proposal: ${proposal.proposalId}`);
  console.log(`Skill: ${proposal.skill.module}/${proposal.skill.name}`);
  console.log(`Source: ${relativeSourcePath}`);
  console.log(`Record: ${toPosix(path.relative(cwd, recordPath))}`);
  console.log(`Authors: ${config.authors.join(", ")}`);
  console.log(
    `Comments: ${selection.kept.length} used, ${selection.unconfigured.length} excluded as unconfigured, ${selection.bodyless.length} with no recorded body`,
  );
  console.log(`Confidence: ${proposal.confidence}`);
  console.log(`Proposal: ${proposal.proposalPath}`);
  console.log("Lessons:");
  for (const lesson of proposal.lessons) {
    console.log(`- ${lesson}`);
  }
  console.log(
    `Nothing was written to the skill. Apply with: keryx skills learn apply ${proposal.proposalPath}`,
  );
}

/**
 * `keryx review learn --reviewer <id>` (W3, flow 312 T9) — the per-reviewer
 * sibling of the per-skill path above. Applies an accepted, `domain:
 * "review-conventions"` learned-pattern record generalized to this reviewer
 * identity into `.metaproject/rules/reviewers/<id>.mdc`. `--pr` is not read
 * in this mode: the source is `keryx learn accept`, not a pull request.
 */
async function runLearnReviewer(args: string[], reviewerId: string): Promise<void> {
  // R1-F3: `args.includes("--dry-run")` read `--dry-run=1` as absent — a
  // preview request silently became the real write. `parseLearnArgs` (shared
  // with `keryx learn`'s own flag parsing, `src/learning/cli-args.ts`) refuses
  // that spelling instead of misreading it. `LEARN_FLAGS` above this function
  // already validated the flag NAMES (`rejectUnknownFlags`); this pass adds
  // the "=value on a boolean" check that one does not make.
  const parsed = parseLearnArgs(args, { boolean: ["--dry-run", "--json"], value: ["--pr", "--reviewer"] });
  if (parsed.bad.length > 0) {
    throw new Error(`Unknown option(s) for \`keryx review learn --reviewer\`: ${parsed.bad.join(", ")}.`);
  }
  const dryRun = parsed.flags.has("--dry-run");
  const result = await applyReviewerProfile(process.cwd(), reviewerId, { dryRun });

  if (parsed.flags.has("--json")) {
    console.log(JSON.stringify({ reviewer: reviewerId, dryRun, ...result }, null, 2));
    return;
  }

  console.log(`${dryRun ? "Would write" : "Wrote"} reviewer profile: ${result.path}`);
  console.log(`Reviewer: ${reviewerId}`);
  console.log(`Version: ${result.version}`);
  console.log(`Conventions added this pass: ${result.added}`);
}

function counts(state: PrCommentState, selection: LearningSelection): Record<string, number> {
  return {
    seen: state.seen.length,
    used: selection.kept.length,
    unconfigured: selection.unconfigured.length,
    bodyless: selection.bodyless.length,
  };
}

/**
 * `keryx review loop` — detection, not counting (AC9).
 *
 * Reads the review packages a flow already has on disk and the flow's persisted
 * `attempts.count`, never this session's memory. Exits non-zero when it
 * escalates, and the escalation does not consult the remaining round budget.
 */
async function runLoop(args: string[]): Promise<void> {
  rejectUnknownFlags(args, LOOP_FLAGS, "loop --flow <id>");
  const flowRef = optionValue(args, "--flow") ?? args.find((item) => !item.startsWith("--"));
  if (!flowRef) {
    throw new Error("Usage: keryx review loop --flow <flow-id> [--task <Tn>]");
  }
  const taskId = optionValue(args, "--task");
  const rounds = await readFlowReviewRounds(process.cwd(), flowRef);
  const attempts = taskId === undefined ? undefined : await readTaskAttemptCount(process.cwd(), flowRef, taskId);
  const detection = detectReviewLoop({ rounds, attempts });
  console.log(renderLoopDetectionMarkdown(detection));
  if (detection.escalate) {
    console.error(
      `ESCALATE: ${detection.signals.length} repetition signal(s) across ${detection.roundsSeen} rounds. Change strategy — do not spend the remaining rounds on the same approach. The round budget was deliberately not consulted.`,
    );
    process.exitCode = 1;
  }
}

/**
 * `keryx review stack` — deterministic stack scoping for the reviewers whose
 * checklists target a framework this repository may not use (flow 203, AC13,
 * roadmap §3.2).
 *
 * Reads `package.json` once (never a model), then reads every installed
 * review-category skill's `metadata.stack_requires` frontmatter and reports,
 * per reviewer, whether its declared requirement is met — with the reason.
 * `detected.uncertain` (a missing or unparsable `package.json`) forces every
 * decision to `include: true`; see `review/stack.ts` for why that direction is
 * the only one this command will not reverse.
 *
 * `review-orchestrator` calls this before dispatch; it does not by itself change
 * dispatch. `review-orchestrator`'s routing table is where that answer would
 * be consulted, and wiring it in is a follow-up — see the flow journal.
 */
/**
 * `keryx review reviewers [--json]` — who can review in THIS project.
 *
 * The bundled half comes from the installed gdskills tree, so it reflects the
 * profile this project actually installed rather than everything keryx ships.
 * The project half is every project-skill under module `review`, with the
 * provenance recorded at import time and a freshly computed drift verdict.
 *
 * `review-orchestrator` calls this during detection and adds the project half
 * to its dispatch set. That is the whole point: before this, a reviewer a team
 * wrote for itself was invisible to every round, and the routing table was the
 * only answer to "who can review", which meant the answer could only ever be
 * "whoever keryx ships".
 */
async function runReviewers(args: string[]): Promise<void> {
  rejectUnknownFlags(args, REVIEWERS_FLAGS, "reviewers");
  const inventory = await collectReviewers(process.cwd());

  if (args.includes("--json")) {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }
  console.log(renderReviewerInventoryMarkdown(inventory));
}

async function runStack(args: string[]): Promise<void> {
  rejectUnknownFlags(args, STACK_FLAGS, "stack");
  const cwd = process.cwd();
  const detected = await detectProjectStack(cwd);
  const decisions = await stackScopingForInstalledReviewers(cwd, detected);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ detected, decisions }, null, 2));
    return;
  }
  console.log(renderStackScopingMarkdown(detected, decisions));
}

/**
 * Walk `.metaproject/skills/gdskills/review/*\/SKILL.md` (exact basename only,
 * matching `walkSkillCatalog` in `metaproject-adapter.ts`) and decide each
 * one's stack scoping. A reviewer with no `metadata.stack_requires` field — the
 * majority, since only NestJS/React/MobX/Prisma-specific reviewers declare one
 * — is a generic reviewer and always included. Never throws: a missing
 * gdskills root or an unreadable category yields no decisions, not a failure.
 */
async function stackScopingForInstalledReviewers(cwd: string, detected: DetectedStack): Promise<StackScopingDecision[]> {
  const reviewRoot = join(cwd, ".metaproject", "skills", "gdskills", "review");
  let entries;
  try {
    entries = await readdir(reviewRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const decisions: StackScopingDecision[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillMdPath = join(reviewRoot, entry.name, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillMdPath, "utf8");
    } catch {
      continue;
    }
    const requires = parseStackRequires(extractStackRequiresField(content));
    decisions.push(scopeReviewerByStack(entry.name, requires, detected));
  }
  return decisions.sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}

function parseNonNegativeInteger(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim() || parsed < 0) {
    throw new Error(`Invalid ${flag}: ${raw}. Expected a non-negative integer.`);
  }
  return parsed;
}

function parseMoney(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flag}: ${raw}. Expected a non-negative number of US dollars.`);
  }
  return parsed;
}

/**
 * `--parallel` / `--outstanding` on an ingest.
 *
 * Returns `undefined` when NEITHER was given, so a package whose caller said
 * nothing about dispatch records `not recorded` rather than a one-wave plan it
 * never made.
 */
function parseConcurrency(args: string[]): ManagedReviewInput["concurrency"] {
  const cap = parseNonNegativeInteger(optionValue(args, "--parallel"), "--parallel");
  const outstanding = parseNonNegativeInteger(optionValue(args, "--outstanding"), "--outstanding");
  if (cap === undefined && outstanding === undefined) {
    return undefined;
  }
  return {
    ...(cap === undefined ? {} : { cap }),
    ...(outstanding === undefined ? {} : { outstanding }),
  };
}

/**
 * What the round RAISED AND THEN DISMISSED, read from a file rather than typed.
 *
 * This channel is the one that unpins the measurement — a corpus holding only
 * the survivors of an unlogged triage reports 100% precision whatever the
 * reviewers got right — and until now it existed only in TypeScript, so the
 * shipped pipeline could never write into it.
 */
async function readRefuted(source: string | undefined): Promise<ReviewFindingsSource | undefined> {
  if (source === undefined) {
    return undefined;
  }
  const raw = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  try {
    return JSON.parse(raw) as ReviewFindingsSource;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Preserve the sanitized public diagnostic without exposing the raw caught value or stack.
    throw new Error(
      `--refuted ${source} is not JSON: ${error instanceof Error ? error.message : String(error)}. Nothing was recorded.`,
    );
  }
}

/**
 * The verifier's own output, read from a file rather than transcribed.
 *
 * Same reason `--report` takes a path: an orchestrator that retypes a structured
 * payload loses fields, and the loss is what made the recorded corpus
 * unmeasurable.
 */
async function readVerifications(source: string | undefined): Promise<ManagedReviewInput["verifications"]> {
  if (source === undefined) {
    return undefined;
  }
  const raw = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Preserve the sanitized public diagnostic without exposing the raw caught value or stack.
    throw new Error(
      `--verifications ${source} is not JSON: ${error instanceof Error ? error.message : String(error)}. Nothing was merged.`,
    );
  }
  return verificationClaims(parsed as VerificationSource);
}

/**
 * The pre-filter stage, from `keryx review scope --json` — WHOLE.
 *
 * It used to take the eight counts and discard `drops`, and that discard is what
 * left AC5 with no supported path: "a reason per drop" cannot survive a
 * projection to eight integers. The rows travelled instead by `keryx review
 * scope --append <package>/scope.md`, which `review ingest` then overwrote.
 */
async function readScope(source: string | undefined): Promise<ReviewScopeRecordLike | undefined> {
  if (source === undefined) {
    return undefined;
  }
  const raw = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  const parsed = JSON.parse(raw) as Partial<ReviewScopeRecordLike>;
  if (parsed.counts === undefined) {
    throw new Error(`--scope ${source} carries no \`counts\`. Pass the output of \`keryx review scope --json\`.`);
  }
  if (!Array.isArray(parsed.drops)) {
    // Refused rather than defaulted to `[]`. An empty drop list is the positive
    // claim "the pre-filter dropped nothing", and a document that simply lacks
    // the property is not making it.
    throw new Error(
      `--scope ${source} carries no \`drops\` array. Pass the whole \`keryx review scope --json\` document: an empty list means "dropped nothing", and a missing one means the reasons were never recorded.`,
    );
  }
  return { ...parsed, counts: parsed.counts, drops: parsed.drops };
}

/**
 * The blast-radius record, from `keryx review blast-radius --json` — the set the
 * scope-B screen holds findings against.
 *
 * Refused rather than defaulted when either half is missing, on the same rule
 * `readScope` follows: an empty `files` list is the positive claim "the radius is
 * empty", and a document that simply lacks the property is not making it. A screen
 * run against an invented empty set would reject every scope-B finding as
 * `outside-set` and report that as enforcement working.
 */
async function readBlastRadiusRecord(source: string | undefined): Promise<BlastRadiusScreenInput | undefined> {
  if (source === undefined) {
    return undefined;
  }
  const raw = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  const parsed = JSON.parse(raw) as Partial<BlastRadiusScreenInput>;
  if (!Array.isArray(parsed.files) || !Array.isArray(parsed.changedFiles)) {
    throw new Error(
      `--blast-radius ${source} carries no \`files\`/\`changedFiles\` arrays. Pass the output of \`keryx review blast-radius --json\`: an empty set means "the radius is empty", and a missing one means it was never computed.`,
    );
  }
  return { ...parsed, files: parsed.files, changedFiles: parsed.changedFiles };
}

/**
 * The §5.4 decision, from `keryx providers cross-family --json` (flow 209, AC2).
 *
 * Refused rather than defaulted on every malformed input, on the same rule
 * `readScope` and `readBlastRadiusRecord` follow. `single-family` is a DECISION
 * and quietly substituting it for an unreadable file would record that a
 * question was answered when nobody asked it — which is precisely the state the
 * field was added to make visible.
 */
async function readCrossFamilyReview(source: string | undefined): Promise<CrossFamilyReviewDecision | undefined> {
  if (source === undefined) {
    return undefined;
  }
  const raw = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Preserve the sanitized public diagnostic without exposing the raw caught value or stack.
    throw new Error(
      `--cross-family-review ${source} is not JSON: ${error instanceof Error ? error.message : String(error)}. Pass the output of \`keryx providers cross-family --json\`.`,
    );
  }
  return parseCrossFamilyReviewInput(parsed, `--cross-family-review ${source}`);
}

function parseVerificationMode(raw: string | undefined): ManagedReviewInput["verificationMode"] {
  if (raw === undefined) {
    return DEFAULT_VERIFICATION_MODE;
  }
  if (!isVerificationMode(raw)) {
    throw new Error(`Invalid --verification-mode: ${raw}. Expected one of ${VERIFICATION_MODES.join(", ")}.`);
  }
  return raw;
}

/**
 * `keryx review scope` — the deterministic pre-filter, run before reviewers are
 * dispatched (flow 202, AC3–AC5).
 *
 * This command exists so the orchestrator stops eyeballing a diff. Everything it
 * decides is decided in `review/scope.ts`, which is pure; the only work done
 * here is fetching the diff and choosing where the answer is written.
 */
async function runScope(args: string[]): Promise<void> {
  rejectUnknownFlags(args, SCOPE_FLAGS, "scope");
  const contextLines = parseContextLines(optionValue(args, "--context"));
  const pathList = optionValue(args, "--path");
  const diffFile = optionValue(args, "--diff");
  const ref = optionValue(args, "--ref") ?? optionValue(args, "--base");

  let scope: ReviewScope;
  if (pathList !== undefined) {
    const paths = pathList
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    scope = buildPathScope(paths, { contextLines });
  } else {
    const diff = diffFile !== undefined ? await readDiffSource(diffFile) : await gitDiff(ref, contextLines);
    scope = buildReviewScope(diff, { contextLines });
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(scope, null, 2));
  } else if (args.includes("--scoped-diff")) {
    console.log(renderScopedDiff(scope));
  } else {
    console.log(renderReviewScopeMarkdown(scope));
    // The price, while it is still a decision. This is the only point in the
    // pipeline where the round has not been spent yet, so it is the only place
    // an estimate can change what happens. Human-readable output only: `--json`
    // is a contract other commands parse and `--scoped-diff` is what a reviewer
    // is handed, and neither is a place to put prose about money.
    console.log("");
    console.log(renderScopeEstimate(renderScopedDiff(scope), reviewerList(args).length));
  }

  // AC5: the drop list belongs in the review record, not only on a terminal.
  //
  // REPLACES a pre-existing `## Pre-filter scope` block rather than adding a
  // second. The name is kept because it is what the orchestrator skill and the
  // docs already say, but appending was wrong: re-running the command after
  // amending a commit — an ordinary thing to do — left three contradictory
  // blocks in one record with no rule for which one to read.
  const append = optionValue(args, "--append");
  if (append !== undefined) {
    const existing = await readFile(append, "utf8").catch(() => "");
    await writeFileAtomic(append, upsertPreFilterScopeBlock(existing, renderReviewScopeMarkdown(scope)));
  }
}

/**
 * `keryx review floor` — the guard against a diff that quietly lowers the bar
 * (flow 258, T11).
 *
 * A sibling of `scope` in every way that matters: same diff sources, same
 * `buildReviewScope` input, no model call, and everything it decides is decided
 * in `review/floor.ts`, which is pure. The difference is the exit code.
 *
 * `scope` reports and always exits 0 because a scope is a description. This
 * exits 1 when it finds something, because a finding here is a QUESTION the
 * diff has not answered — why is that threshold lower, why is that test off —
 * and a guard that asks its question with exit 0 is a guard that gets scrolled
 * past. It is the same choice `budget` and `loop` already make.
 *
 * `--report-only` is the adoption path, and it mirrors `--verification-mode
 * annotate`: print the findings, exit 0, let a project measure its own rate
 * before the guard starts refusing. Nothing is hidden either way — the report
 * is identical, only the exit code moves.
 *
 * ## Three exit codes, because the branch that added this rule demands three
 *
 * `rules/core/cli-interface-design.mdc` — added on this same branch — reserves
 * **2** for "could not tell" and says a NEW command uses 0/1/2 as defined. This
 * command went out with the shared `catch` at the top of {@link reviewCommand}
 * collapsing every failure to **1**, which made a typo'd `--ref` indistinguish-
 * able from a lowered bar: both exit 1, and under `--json` both wrote zero bytes
 * to stdout. That is the failure the rule exists to name, in the command that
 * shipped alongside it.
 *
 * So the diff-acquisition step is caught HERE:
 *
 * - a ref that will not resolve, a diff file that will not open, a `git diff`
 *   that fails — the guard could not look — is **2**, with
 *   `{ outcome: "cannot-scan", error }` on stdout under `--json`, mirroring
 *   `keryx memory search`'s `store-unreadable` (`src/commands/memory.ts:188-196`);
 * - a bad flag, a bad `--context` value, or a value-taking flag whose value the
 *   shell dropped ({@link FLOOR_VALUE_FLAGS}) is a VALIDATION error and stays
 *   **1**, which is the same split `memory search` draws;
 * - a finding is **1**; a clean scan is **0**.
 *
 * Free to do today and breaking tomorrow: `keryx review floor` is in no released
 * tag and nothing in this repository or its CI gates on it yet.
 */
async function runFloor(args: string[]): Promise<void> {
  // Outside the try on purpose: an unknown flag, a flag whose value was dropped
  // and an unparseable --context are the caller getting the invocation wrong,
  // not the guard being unable to look.
  rejectUnknownFlags(args, FLOOR_FLAGS, "floor");
  rejectValuelessOptions(args, FLOOR_VALUE_FLAGS, "floor");
  const contextLines = parseContextLines(optionValue(args, "--context"));
  const asJson = args.includes("--json");
  const diffFile = optionValue(args, "--diff");
  const ref = optionValue(args, "--ref") ?? optionValue(args, "--base");

  let diff: string;
  try {
    const base = ref === undefined ? undefined : await mergeBaseWithHead(ref);
    diff = diffFile !== undefined ? await readDiffSource(diffFile) : await gitDiff(base, contextLines);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (asJson) {
      console.log(JSON.stringify(floorCannotScan(message), null, 2));
    } else {
      console.error(`cannot-scan: ${message}`);
    }
    process.exitCode = 2;
    return;
  }
  const report = detectFloorRegressions(buildReviewScope(diff, { contextLines }));

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderFloorMarkdown(report));
  }

  if (report.counts.total === 0) {
    return;
  }
  const summary = FLOOR_FINDING_KINDS.filter((kind) => report.counts.byKind[kind] > 0)
    .map((kind) => `${kind}=${report.counts.byKind[kind]}`)
    .join(", ");
  if (args.includes("--report-only")) {
    console.error(`floor: ${report.counts.total} finding(s) (${summary}); reported only, --report-only was given.`);
    return;
  }
  console.error(
    `floor: ${report.counts.total} finding(s) (${summary}). Each may be correct; none is self-evident. Say why in the diff, or re-run with --report-only to record them without failing.`,
  );
  process.exitCode = 1;
}

/**
 * `keryx review blast-radius` — scope B, computed (flow 204, AC1–AC4).
 *
 * Scope A asks whether the change is correct. This asks whether it broke
 * something that was working, over a set derived from `gdgraph affected` rather
 * than from a model's choice of files to open. Everything it decides is decided
 * in `review/blast-radius.ts`, which is pure; the only work done here is loading
 * the graph, resolving the changed-file list, and choosing where the record goes.
 *
 * `--previous` + `--final` make AC4 mechanical: the recompute decision is
 * printed and acted on rather than left to whoever remembers the rule.
 */
async function runBlastRadius(args: string[]): Promise<void> {
  rejectUnknownFlags(args, BLAST_RADIUS_FLAGS, "blast-radius");
  const cwd = process.cwd();
  const depth = parseNonNegativeInteger(optionValue(args, "--depth"), "--depth");
  const maxFiles = parseNonNegativeInteger(optionValue(args, "--max-files"), "--max-files");
  const includeRelatedTests = !args.includes("--no-related-tests");
  const isFinalRound = args.includes("--final");

  const explicit = optionValue(args, "--changed");
  const ref = optionValue(args, "--ref") ?? optionValue(args, "--base");
  const changedFiles =
    explicit !== undefined
      ? explicit.split(",").map((item) => item.trim()).filter(Boolean)
      : await gitChangedFiles(ref);

  // AC4 first: a round that must not recompute should not pay for a graph load.
  const previousPath = optionValue(args, "--previous");
  const previous = previousPath === undefined ? undefined : await readPreviousRadius(previousPath);
  const decision = blastRadiusRecomputeDecision({
    changedFiles,
    isFinalRound,
    previous:
      previous === undefined
        ? undefined
        : { changedFiles: previous.changedFiles, depth: previous.depth, maxFiles: previous.maxFiles },
    depth,
    maxFiles,
  });
  console.error(`recompute: ${decision.recompute ? "yes" : "no"} — ${decision.reason}`);
  if (!decision.recompute && previous !== undefined) {
    await emitBlastRadius(previous, args);
    return;
  }

  const graph = await loadGraph(cwd);
  if (graph.nodes.length === 0) {
    // An empty graph would produce an empty radius, which reads as "nothing
    // depends on this change". Refuse instead: a scope that shrank to nothing
    // because a prerequisite did not run is the failure shape this flow exists
    // to end.
    throw new Error(
      "The code graph is empty or absent, so no blast radius can be computed. Run `keryx gdgraph build` first. " +
        "An empty radius would read as `nothing depends on the change`, which is a different fact.",
    );
  }
  const testFiles = includeRelatedTests ? await gitTestFiles() : [];
  const radius = computeBlastRadius({
    graph,
    changedFiles,
    testFiles,
    config: { depth, maxFiles, includeRelatedTests },
  });
  await emitBlastRadius(radius, args);

  if (radius.counts.droppedByCap > 0) {
    console.error(
      `cap: ${radius.counts.droppedByCap} of ${radius.counts.candidates} candidate files were NOT reviewed (blast_radius_max_files=${radius.maxFiles}). They are listed in the record.`,
    );
  }
  if (radius.counts.changedFilesUnresolved > 0) {
    console.error(
      `unresolved: ${radius.counts.changedFilesUnresolved} changed file(s) are absent from the code graph; their blast radius is unknown, not empty.`,
    );
  }
}

async function emitBlastRadius(radius: BlastRadius, args: string[]): Promise<void> {
  if (args.includes("--json")) {
    console.log(JSON.stringify(radius, null, 2));
  } else if (args.includes("--brief")) {
    console.log(renderBlastRadiusDispatchBrief(radius));
  } else {
    console.log(renderBlastRadiusMarkdown(radius));
  }
  const out = optionValue(args, "--out");
  if (out === undefined) {
    return;
  }
  if (out.endsWith(".json")) {
    await writeFileAtomic(out, `${JSON.stringify(radius, null, 2)}\n`);
    return;
  }
  const existing = await readFile(out, "utf8").catch(() => "");
  await writeFileAtomic(out, upsertBlastRadiusBlock(existing, renderBlastRadiusMarkdown(radius)));
}

async function readPreviousRadius(source: string): Promise<BlastRadius> {
  const text = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as BlastRadius).changedFiles)) {
    throw new Error(
      `--previous ${source} is not a blast-radius record (expected the \`--json\` output of \`keryx review blast-radius\`).`,
    );
  }
  return parsed as BlastRadius;
}

/** The changed-file list scope B is seeded from. Deleted paths are excluded. */
async function gitChangedFiles(ref: string | undefined): Promise<string[]> {
  const command = ["git", "diff", "--name-only", "--diff-filter=d", ...(ref === undefined ? [] : [ref])];
  return (await gitLines(command)).filter(Boolean);
}

async function gitTestFiles(): Promise<string[]> {
  return (await gitLines(["git", "ls-files"])).filter((file) => TEST_FILE_RE.test(file));
}

async function gitLines(command: readonly string[]): Promise<string[]> {
  const proc = Bun.spawn([...command], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseContextLines(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_CONTEXT_LINES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --context: ${raw}. Expected a non-negative integer.`);
  }
  return parsed;
}

async function readDiffSource(source: string): Promise<string> {
  if (source === "-") {
    return await Bun.stdin.text();
  }
  return await Bun.file(source).text();
}

/**
 * The diff the scope is built from.
 *
 * `-U${contextLines}` matters: the window the pre-filter reports is bounded by
 * what the diff actually carries, so asking git for less context than the window
 * would make every region report `context_truncated` and hand reviewers less
 * than the configured bound.
 */
async function gitDiff(ref: string | undefined, contextLines: number): Promise<string> {
  const command = ["git", "diff", "--no-color", `-U${contextLines}`, ...(ref === undefined ? [] : [ref])];
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * The commit `floor` actually compares against: the MERGE BASE of `HEAD` and
 * `ref`, not `ref` itself.
 *
 * `git diff <ref>` is a two-dot diff, so every commit `<ref>` gained while the
 * branch was in flight appears INVERTED — the base's own additions read as this
 * branch's removals. Measured, not theorised: on `skills/skill-gaps` two commits
 * behind `origin/main`, `keryx review floor --ref origin/main` reported two
 * `assertion-removed` findings, in `src/commands/review.test.ts` and
 * `src/gdskills/install.test.ts`. No commit of the branch touches either file.
 * Both are touched by #543 and #544, which ADDED those assertions on `main`.
 *
 * That is the worst failure mode a guard has. It does not merely cry wolf: this
 * guard's whole demand is "say why in the diff", so a finding about work that is
 * not in the diff cannot be answered honestly at all. The only ways out are to
 * write a justification for someone else's change or to turn the guard off — and
 * when it goes off, the three real detections go with it.
 *
 * Resolved explicitly rather than through git's `<ref>...` three-dot spelling,
 * which would be shorter and is wrong here: the three-dot form ends at `HEAD`,
 * so it drops the working tree, and a guard that cannot see uncommitted work
 * cannot be run before the commit that needs it. `git diff <merge-base>` keeps
 * both properties at once — the base's own commits are excluded AND uncommitted
 * changes are still scanned.
 *
 * For an ancestor ref — `HEAD~3`, a tag already merged, a base nothing has moved
 * — the merge base IS the ref, so this resolves to exactly what it resolved to
 * before. It diverges only in the case that was broken.
 *
 * ## The divergence from `scope` and `blast-radius`, stated
 *
 * `runScope` and `runBlastRadius` still resolve `--ref` the two-dot way, through
 * {@link gitDiff} and {@link gitChangedFiles} below, and so carry this same
 * defect. They are not fixed here on purpose: both shipped (they are in
 * `v0.2.98`, where `keryx review floor` is absent — floor is in no released tag
 * at all), and `rules/core/cli-interface-design.mdc` puts a published command's
 * stdout under the same contract as an API. Changing what `--ref` selects would
 * change what `scope` prints for callers already parsing it, which is a change
 * that ships with its consumers named, not as a side effect of a floor fix.
 * Named here rather than left for the next person to rediscover.
 */
async function gitOutput(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * True when this checkout does not hold enough history to HAVE a merge base.
 *
 * Asked only on the failure path, because it is a second `git` call and the
 * answer is only ever needed to choose the wording of a refusal.
 */
async function isShallowClone(): Promise<boolean> {
  const { stdout, exitCode } = await gitOutput(["rev-parse", "--is-shallow-repository"]);
  return exitCode === 0 && stdout.trim() === "true";
}

async function mergeBaseWithHead(ref: string): Promise<string> {
  const { stdout, stderr, exitCode } = await gitOutput(["merge-base", "HEAD", ref]);
  const base = stdout.trim();
  if (exitCode !== 0 || base.length === 0) {
    // Refused rather than silently falling back to `ref`: the fallback IS the
    // bug this function exists to remove, and a guard that quietly returns to
    // blaming the base would be worse than one that stops and says so.
    //
    // The shallow case is separated out because the generic advice is actively
    // WRONG there and sends the reader looking for a problem they do not have.
    // `git merge-base` exits 1 with no output in a `--depth 1` clone, which is
    // indistinguishable from unrelated histories from the exit code alone — and
    // `actions/checkout` defaults to `fetch-depth: 1`, so a CI job is the most
    // likely place this guard is ever run. HEAD and the base do share history;
    // the clone simply does not have it.
    if (await isShallowClone()) {
      throw new Error(
        `Cannot resolve a merge base between HEAD and ${ref}: this is a SHALLOW clone, so the commit where the branch forked is not present. ` +
          `HEAD and ${ref} do share history — this checkout does not have it. ` +
          `Run \`git fetch --unshallow\` (or \`git fetch --deepen=<n>\`), or set \`fetch-depth: 0\` on actions/checkout, then re-run.`,
      );
    }
    throw new Error(
      `Cannot resolve a merge base between HEAD and ${ref}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : " (no common ancestor)"}. ` +
        `\`floor\` compares against the merge base so that commits ${ref} gained since this branch forked are not reported as this branch's removals. ` +
        `Pass a ref that shares history with HEAD, or pass the diff directly with --diff.`,
    );
  }
  return base;
}

async function runStatus(args: string[]): Promise<void> {
  rejectUnknownFlags(args, [], "status <review-id-or-path>");
  const ref = args[0];
  if (!ref) {
    throw new Error("Usage: keryx review status <review-id-or-path>");
  }
  const manifest = await getManagedReviewStatus(process.cwd(), ref);
  console.log(`# managed review: ${manifest.reviewId}`);
  console.log("");
  console.log(`mode: ${manifest.mode}`);
  console.log(`status: ${manifest.status}`);
  console.log(`target: ${manifest.target.kind} ${manifest.target.ref}`);
  console.log(`head: ${manifest.target.head ?? "not recorded (`flow complete` will refuse this round)"}`);
  console.log(`flow: ${manifest.flow?.id ?? "none"}`);
  console.log(`coverage: ${manifest.coverage.length}`);

  // Flow 207 AC3: the consumer. `filter_stats` is READ BACK HERE, out of the
  // manifest on disk, by a different invocation from the one that wrote it — and
  // then checked, and then refused on.
  //
  // Reporting alone would not have been enough. `attempts.count` and
  // `metrics.steps[].retries` were declared and never written for a whole
  // release, and the reason nobody noticed is that nothing read them: a field
  // with no reader has no way of being found wrong. So this prints every stage,
  // saying `not-measured` where the record says `null`, and exits 1 when the
  // arithmetic does not hold or when a `null` count has no stated reason.
  //
  // A package written before this existed carries no `filter_stats` at all. That
  // is reported and exits 0: it is a fact about old packages, not a
  // contradiction inside a new one, and failing on it would make the check
  // impossible to adopt.
  // Flow 209 AC2: THE CONSUMER. `cross_family_review` is read back HERE, out of
  // `manifest.json`, by an invocation that shares nothing with the ingest that
  // wrote it — and then checked, and then refused on.
  //
  // A same-process reader would not have been enough, and this is not a
  // hypothetical: `attempts.count` was written and read inside one process and
  // stayed green for a whole release. The separation is the check.
  //
  // Reported BEFORE the `filter_stats` early return, because a package that
  // predates `filter_stats` can still carry a family decision, and returning
  // first would make this reader unreachable on exactly the old packages a
  // recall comparison most wants to group.
  console.log(renderCrossFamilyReviewLine(manifest.cross_family_review));
  reportCrossFamilyReviewProblems(manifest.cross_family_review, `${ref}/manifest.json`);

  const stats = manifest.filter_stats;
  if (stats === undefined) {
    console.log("filter_stats: not recorded — this package predates it. Re-ingest the round to record what it filtered.");
    return;
  }
  console.log(renderFilterStatsLine(stats));
  for (const row of stats.not_measured) {
    console.log(`  ${row.stage}: not measured — ${row.reason}`);
  }
  for (const [key, value] of Object.entries(stats.by_reason).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  by_reason ${key}: ${value}`);
  }
  reportFilterStatsProblems(stats, `${ref}/manifest.json`);
}

/**
 * Print whatever is wrong with a `filter_stats`, and fail the command if
 * anything is.
 *
 * Shared by `ingest` and `status` so the producer and the reader hold the record
 * to the same standard — a check that only ran on read would let a broken
 * producer write for weeks before anyone looked.
 *
 * The exit code is set rather than thrown for `ingest`, where the package is
 * already on disk: a refusal that deleted the record of its own failure is the
 * shape this whole pipeline exists to remove.
 */
/**
 * Print whatever is wrong with a persisted `cross_family_review`, and fail the
 * command if anything is (flow 209, AC2).
 *
 * `not-recorded` is filtered out and never fails, exactly as it is for
 * `filter_stats`: a round that did not run `keryx providers cross-family` has
 * recorded an absence, which is honest. A round that recorded a
 * self-contradictory decision has recorded a claim, and that is the one this
 * refuses — because a consumer that can only agree with the producer is a
 * printer, and a printer is what `attempts.count` had.
 */
function reportCrossFamilyReviewProblems(decision: unknown, where: string): void {
  const problems = checkCrossFamilyReview(decision).filter((problem) => problem.code !== "not-recorded");
  if (problems.length === 0) {
    return;
  }
  for (const problem of problems) {
    console.error(`cross_family_review [${problem.code}] in ${where}: ${problem.message}`);
  }
  process.exitCode = 1;
}

function reportFilterStatsProblems(stats: unknown, where: string): void {
  const problems = checkFilterStats(stats).filter((problem) => problem.code !== "not-recorded");
  if (problems.length === 0) {
    return;
  }
  for (const problem of problems) {
    console.error(`filter_stats [${problem.code}] in ${where}: ${problem.message}`);
  }
  process.exitCode = 1;
}

async function runComplete(args: string[]): Promise<void> {
  rejectUnknownFlags(args, COMPLETE_FLAGS, "complete <review-id-or-path>");
  const ref = args[0];
  if (!ref) {
    throw new Error("Usage: keryx review complete <review-id-or-path>");
  }
  const dispositions = parseDispositions(args);
  const {
    manifest,
    reviewNotes,
    dispositions: tally,
  } = await completeManagedReview(process.cwd(), ref, { dispositions });
  console.log(`# managed review complete: ${manifest.reviewId}`);
  console.log(`status: ${manifest.status}`);
  console.log(`dispositions recorded: ${dispositions.length}`);
  // The price, now that both halves are known. This is the first moment the
  // round's cost and what survived it are on the same screen, and it is the
  // number the fan-out has to justify itself with. `not recorded` when nobody
  // measured — never `0`, which would read as a round that was free.
  for (const line of renderCostPerFinding(manifest.cost, manifest.filter_stats?.retained ?? 0)) {
    console.log(line);
  }
  // Flow 207 AC5/AC6, on the attended path. A `dismissed-incorrect` whose
  // evidence names nobody writes no note and says so here, rather than reaching
  // the learning loop as an unattributed claim that our own reviewer was wrong.
  for (const note of reviewNotes.written) {
    console.log(`review-note: ${note.finding} -> ${note.path} (attested by ${note.attestation})`);
  }
  for (const skip of reviewNotes.skipped) {
    console.log(`review-note NOT written for ${skip.finding}: ${skip.reason}`);
  }
  // Said out loud, because the silence is the failure mode: a corpus of unknowns
  // is what makes precision unmeasurable. Counted off the package rather than
  // asserted from the absence of flags — this line used to claim "every finding
  // still reads `unknown`" whenever no --disposition was passed, which was false
  // for every package dispositioned across more than one close, and a false
  // report of an unrecorded outcome destroys the signal the field exists for.
  console.log(
    `findings: ${tally.total} — ${tally.recorded} with a recorded disposition, ${tally.unknown} still \`unknown\``,
  );
  if (tally.unknown > 0) {
    console.log(
      `${tally.unknown} of ${tally.total} findings read \`unknown\` — nobody recorded an outcome for them.`,
    );
  }
}

/**
 * `--finding <id> --disposition <state> [--evidence <text>]`, repeatable.
 *
 * Read positionally rather than by `optionValue`, which answers with the FIRST
 * occurrence and so could only ever express one record. Each `--finding` opens a
 * record and the flags after it belong to that record, which is the shape an
 * operator writes without being told.
 *
 * `--disposition` before any `--finding` is refused rather than applied to the
 * whole package: a disposition names one finding by construction, and guessing
 * "all of them" would write an outcome nobody decided onto findings nobody
 * looked at.
 */
function parseDispositions(args: readonly string[]): FindingDispositionRecord[] {
  const records: FindingDispositionRecord[] = [];
  let open: { finding: string; state?: FindingDispositionState; evidence?: string } | undefined;

  const flush = (): void => {
    if (open === undefined) {
      return;
    }
    if (open.state === undefined) {
      throw new Error(
        `--finding ${open.finding} was given no --disposition. Name one of ${FINDING_DISPOSITION_STATES.join(", ")}.`,
      );
    }
    records.push(
      open.evidence === undefined
        ? { finding: open.finding, state: open.state }
        : { finding: open.finding, state: open.state, evidence: open.evidence },
    );
    open = undefined;
  };

  for (const token of flagTokens(args)) {
    if (!(COMPLETE_FLAGS as readonly string[]).includes(token.name)) {
      continue;
    }
    if (token.value === undefined) {
      throw new Error(`${token.name} needs a value.`);
    }
    if (token.name === "--finding") {
      flush();
      open = { finding: token.value };
      continue;
    }
    if (open === undefined) {
      throw new Error(
        `${token.name} was given before any --finding. A disposition names ONE finding; write \`--finding <id> ${token.name} <value>\`.`,
      );
    }
    if (token.name === "--disposition") {
      if (!(FINDING_DISPOSITION_STATES as readonly string[]).includes(token.value)) {
        throw new Error(
          `Invalid --disposition: ${token.value}. Expected one of ${FINDING_DISPOSITION_STATES.join(", ")}.`,
        );
      }
      open.state = token.value as FindingDispositionState;
      continue;
    }
    open.evidence = token.value;
  }
  flush();
  return records;
}

function targetKindFromArgs(mode: ManagedReviewMode, args: string[]): ReviewTargetKind {
  const value = optionValue(args, "--target") ?? (mode === "ingest" ? "report" : undefined);
  if (!value || !REVIEW_TARGET_KINDS.includes(value as ReviewTargetKind)) {
    throw new Error(`Invalid --target. Use one of: ${REVIEW_TARGET_KINDS.join(", ")}`);
  }
  return value as ReviewTargetKind;
}

function printHelp(): void {
  console.log(`keryx review

Usage:
  keryx review attach --flow <id> --target <kind> --ref <ref> [--head <sha>]
                      [--reviewers a,b] [--report <path>]
  keryx review start --target <kind> --ref <ref> [--head <sha>] [--reviewers a,b] [--report <path>]
  keryx review ingest --report <path> [--flow <id>] --ref <ref> [--head <sha>]
                      [--verifications <file|->] [--verification-mode ${VERIFICATION_MODES.join("|")}]
                      [--scope <scope.json>] [--blast-radius <blast-radius.json>]
                      [--cross-family-review <file|->]
                    [--refuted <file|->]
                      [--max-findings <n>] [--spent <usd>] [--spend-ceiling <usd>]
                      [--parallel <n>] [--outstanding <n>]
  keryx review scope [--ref <base>] [--diff <file|->] [--path a,b] [--context <n>]
                     [--json | --scoped-diff] [--append <file>]
  keryx review floor [--ref <base>] [--diff <file|->] [--context <n>]
                     [--json] [--report-only]
                     --ref WIDENS the diff to the MERGE BASE of HEAD and <base>,
                     so commits <base> gained since this branch forked are not
                     reported as this branch's removals. Uncommitted work is
                     still scanned, with or without --ref.
  keryx review blast-radius [--ref <base> | --changed a,b] [--depth <n>] [--max-files <n>]
                            [--no-related-tests] [--final] [--previous <blast-radius.json>]
                            [--json | --brief] [--out <file>]
  keryx review budget [--spent <usd>] [--ceiling <usd>]
                      [--reviewers a,b] [--parallel <n>] [--outstanding <n>]
  keryx review tier [--scope <scope>] [--fix-attempt <n>] [--forced-strategy-change]
                    [--findings <n>] [--diff-lines <n>]
                    [--verifier ${VERIFICATION_METHODS.join("|")}] [--security]
                    [--session-provider <id>] [--session-model <id>]
                    [--catalog <file|->] [--json]
  keryx review comments collect --repo <owner/repo> --pr <n> --sha <head-sha>
                                [--self <login>] [--round <n>]
                                [--out <findings.json>] [--json] [--fixtures <dir>]
  keryx review comments reply --repo <owner/repo> --pr <n> --outcomes <file|->
                              --sha <head-sha> --final [--round <n>] [--dry-run]
                              [--max-replies <n>] [--max-sentences <n>] [--max-chars <n>]
                              [--flow-link <url>] [--fixtures <dir>]
  keryx review ci-triage --run <id> [--job <name>] [--test <name>] [--repo <owner/repo>]
                         [--model <jev-1.13|jev-latest>] [--fixtures <dir>] [--json]
  keryx review conform --ref <doc> (--pr <n> | --report <dir> | --diff <ref>)
                       [--repo <owner/repo>] [--explain] [--threshold <0..1>]
                       [--model <jev-1.13|jev-latest>] [--fixtures <dir>] [--json]
                       [--max-hunks <n>] [--max-hunk-calls <n>] [--detail]
  keryx review learn --pr <n> [--dry-run] [--json]
  keryx review learn --reviewer <id> [--dry-run] [--json]
  keryx review loop --flow <flow-id> [--task <Tn>]
  keryx review stack [--json]
  keryx review reviewers [--json]
  keryx review import --from <dir> [--dry-run] [--force] [--json]
  keryx review status <review-id-or-path>
  keryx review complete <review-id-or-path>
                        [--finding <id> --disposition <state> --evidence <text>]...
  keryx review lightweight

An unrecognised option is REFUSED, not ignored. A flag that is silently dropped
writes nothing and still reports success, which is how a round can close with
zero dispositions and still print \`status: closed\`.

Modes:
  ${MANAGED_REVIEW_MODES.join(", ")}

--head:
  The commit the round ran against, written to \`manifest.target.head\` and read
  by the \`review\` completion gate, which refuses to complete a flow whose last
  round cannot say which tree it read. Omitted, it is \`git rev-parse HEAD\` —
  the tree the reviewers actually read, which is deliberately preferred over a
  \`pr\` target's own head so that a round run against something other than what
  will merge FAILS the gate instead of passing it.

scope:
  Deterministic pre-filter, no model call. Drops generated, lockfile, snapshot,
  vendored and minified paths, drops whitespace-only and comment-only change
  blocks, and bounds each retained change to +/-${DEFAULT_CONTEXT_LINES} lines of context by default.
  Prints the retained scope AND every drop with its reason; --append writes the
  same record into the review package's scope.md, REPLACING a
  \`## Pre-filter scope\` block already there rather than adding a second.

floor:
  The guard against a diff that quietly lowers the bar. Deterministic, no model
  call, over the same scoped regions \`review scope\` builds. Reports four edits:
  a floor named on the line moving DOWN or a ceiling named on the line moving UP
  (the rest of the line unchanged), a test disabled with .skip/.only/xit, a test
  region that ends up with FEWER assertion-carrying lines, and a new suppression
  comment (eslint-disable, @ts-expect-error, ts-ignore, type: ignore, noqa).
  Each is individually defensible; the guard does not claim any is wrong, only
  that the diff should say why. EXITS 1 when it finds anything — a question
  asked with exit 0 is a question nobody answers — and 0 when it finds nothing.
  EXITS 2 when it could not look at all: a ref that will not resolve, a --diff
  that will not open, a shallow clone with no merge base. Under --json that is
  \`{"schemaVersion":1,"outcome":"cannot-scan","error":...}\` on STDOUT, so a
  script tells "nothing weakened" from "nothing was read" by a field and not by
  an exit code alone. A bad flag or a bad flag VALUE stays 1.
  \`--report-only\` prints the same report and exits 0, which is how a project
  measures its own rate before the guard starts refusing.
  It sees only what the pre-filter retained: a threshold lowered inside a
  vendored or generated path is invisible, by construction.

blast-radius:
  Scope B: what the change can BREAK, as opposed to whether the change is
  correct. Computed from \`gdgraph affected\` over the changed files, ranked by
  edge distance, cut at depth ${DEFAULT_BLAST_RADIUS_DEPTH} and ${DEFAULT_BLAST_RADIUS_MAX_FILES} files. Prints the set, the depth, and
  EVERY file the cap removed — a silent truncation reads as "we checked
  everything". \`--brief\` renders the dispatch text for a scope-B reviewer.
  \`--previous <json> [--final]\` decides whether this round must recompute:
  the final round always does, whatever the changed-file set did.
  Requires a built graph (\`keryx gdgraph build\`); an absent graph is refused
  rather than reported as an empty radius.

cross-family-review:
  The block \`keryx providers cross-family --json\` prints: which model family
  reviewed this round, and why. Recorded on \`manifest.cross_family_review\` and
  read back — and CHECKED — by \`keryx review status\`, which exits non-zero on a
  record that contradicts itself (\`cross-family\` naming no reviewer, naming the
  authoring family, or naming a reviewer that was never a candidate).
  Omitted, the round records NOTHING, and \`status\` says \`not recorded\`.
  That is not \`single-family\`: nobody decided.

ci-triage:
  Advisory-only flaky/infra/real-regression triage for one failed CI run's job
  (flow 306). Scores a redacted, bounded excerpt of the job's own log against
  Jev (TypeSafe System One): three probabilities, one per bucket, printed with
  the top pick and labelled ADVISORY — it never reruns a job, writes a status
  check, or merges anything; that path does not exist in this command.
  Opt-in per project: \`.metaproject/tasks.config.json\`'s
  \`review.jev.ci_triage: true\`, absent by default, because the log excerpt
  leaves the machine to OpenRouter/TypeSafe. With it off, or with no
  OPENROUTER_API_KEY (env, or a saved \`openrouterKey\`), the command refuses
  and makes no network call. \`--fixtures <dir>\` answers BOTH the CI read and
  the Jev call from files on disk (\`ci-run-info.json\`, \`ci-failed-log.txt\`,
  optional \`ci-history.json\`, \`jev-response.json\`) — no real \`gh\` call, no
  real network, the same discipline \`--fixtures\` already gives \`comments\`.
  Vendor-reported accuracy only: this classifier ships with no measured
  precision/recall on this repository's own history (PLAN.md's Phase 7
  evaluation is where that gets measured).

conform:
  Reference-document conformance mode (flow 308): a rules file, a skill, or a
  project skill is split deterministically into clauses (no model call), each
  tagged \`state_kind: pr|report|hunk\` and \`checkable\`. Every checkable clause
  is scored by Jev against DETERMINISTIC FACTS keryx computes first (PR body
  sections present/non-empty and hand-written size for \`pr\`; a report's
  section order and whether every finding carries a severity/evidence/location
  class for \`report\`; the hunk itself for \`hunk\`) placed above the redacted
  state — this is what makes the answers useful, not raw text alone.
  \`--pr <n>\` scores \`pr\`-kind clauses against that pull request's title/body,
  AND \`hunk\`-kind clauses against its diff. \`--report <dir>\` scores
  \`report\`-kind clauses against an existing review package's own
  \`report.md\`/\`findings.json\` — no new artifact format. \`--diff <ref>\` scores
  \`hunk\`-kind clauses against \`git diff <ref>\`. Exactly one of the three is
  required. A clause whose kind has no matching target this run is reported
  \`not evaluated\`; a \`not-checkable\` clause (a live/manual step, or a
  reviewer-process obligation no artefact records) is ALWAYS listed, never
  dropped, and never sent to Jev.
  \`--explain\` sends every clause scored below \`--threshold\` (default 0.5) to
  the model the routing table assigns the \`review\` category (the session
  model when the table is empty), citing the clause id and the evidence. The
  explanation is labelled ADVISORY and is never written to the PR or to
  \`findings.json\` — this command has no write path to either.
  Opt-in per project, and named as a privacy decision: PR text, report content
  and code hunks leave the machine to OpenRouter/TypeSafe. Enable with
  \`.metaproject/tasks.config.json\`'s \`review.jev.conform: true\`, absent by
  default. With it off, or with no OpenRouter credential, the command refuses
  before any read and makes no network call; every redacted state is passed
  through \`redactSensitiveText\` before it is sent.
  \`--fixtures <dir>\` answers the pr-kind read (\`pr.json\`), every Jev call
  (\`jev-response.json\`), and (with \`--explain\`) the explanation pass
  (\`explain-response.json\`) — no real \`gh\` call, no real network.
  Flow 326: the report is ONE row per clause, not one row per hunk × clause.
  A hunk-kind clause's row names how many hunks were judged and how many fell
  below \`--threshold\`, the single worst hunk (location + probability), and up
  to \`--max-hunks\` (default ${DEFAULT_MAX_HUNKS}) further violating hunk locations;
  \`--json\` nests the full per-hunk detail under each clause regardless, and
  \`--detail\` prints it in the text report too. \`--max-hunk-calls\` (default
  ${DEFAULT_MAX_HUNK_CALLS}) caps hunk × clause Jev questions per run; when it truncates,
  the report names which clauses were judged on a subset and how many hunks
  were skipped.
  Honest limits: this mode is the least mechanical use of Jev in this
  repository — deciding whether a PR body names an out-of-scope list is closer
  to judgement than a styling checklist bullet. See flow 308's own journal
  (.metaproject/flows/308-*/journal.md) for the measured usefulness and
  limits of a live run against real pull requests and a real review package.

complete:
  --finding/--disposition/--evidence record what became of a named finding, and
  are repeatable. States: ${FINDING_DISPOSITION_STATES.join(", ")}.
  Everything except \`unknown\` must cite where the outcome is written down. A
  recorded verdict — and its citation — cannot be overwritten by a later close.

ingest --refuted:
  What the round RAISED AND THEN DISMISSED, in the same finding shape, each with
  a dismissal disposition and its evidence. Without it a package keeps only the
  survivors of an unlogged triage, and precision measured over survivors is 100%
  whatever the reviewers got right.

verification (attach/start/ingest):
  --verifications takes what review-verifier returned. The merge is DELETE-ONLY:
  it cannot raise a severity, add a finding, or change a finding's text, and a
  claim carrying any of those is discarded whole with the attempt recorded. A
  finding is never verified by the reviewer that raised it. A verdict reached by
  reasoning alone is capped at unverifiable.
  --verification-mode defaults to \`${DEFAULT_VERIFICATION_MODE}\`: verdicts are recorded and
  NOTHING is removed, so the drop rate is measured before it bites. Only
  \`filter\` removes a refuted finding.
  --scope takes the WHOLE \`keryx review scope --json\` document — counts and the
  per-drop reasons — so the package records what the pre-filter dropped and why.
  Omitted, a \`## Pre-filter scope\` block already in the package's scope.md is
  carried forward verbatim; with neither, that stage reads \`not recorded\`, which
  is not the same fact as \`dropped 0\`.

caps (attach/start/ingest):
  Findings are capped at ${DEFAULT_MAX_FINDINGS_PER_REVIEWER} per reviewer by default (--max-findings), with
  \`blocker\` and \`blocking_merge\` findings EXEMPT and not consuming the budget.
  The cap runs over reported findings only, never over the dismissal records:
  truncating those would rebuild the unlogged triage the --refuted channel
  exists to end. Everything it truncates is named, by reviewer and by id, in
  \`scope.md\` under \`## Caps\` and on this terminal.
  --spent/--spend-ceiling record the round's cost against a ${DEFAULT_SPEND_CEILING_USD} USD default
  ceiling; over it, the package is still written and the command exits non-zero.
  --parallel/--outstanding record the dispatch plan. Every cap that is not given
  reads \`not recorded\`, never \`0\`.

comments:
  External PR comments, collected EVERY round and answered ONCE at the end.
  \`collect\` reads all three sources — inline review comments, review submissions
  and PR-level discussion — excludes only our own identity and comments already
  answered, and keeps bot reviewers on exactly the same path as humans. A comment
  already answered comes back if someone else replied in its thread since.
  Severity is CLASSIFIED, never invented: CHANGES_REQUESTED starts at \`major\`,
  everything else at \`minor\`, and a comment whose parent review was never seen
  stays at the floor marked \`unclassified\` rather than being dropped or guessed.
  \`collect --sha <head-sha>\` is REQUIRED and records which commit the pass read.
  The completion gate compares it with the pull request's head: a state file
  written before the comments arrived is a stale collection, and \`rounds_collected\`
  — a count that a default \`--round 1\` pins at 1 however often collection runs —
  could never tell the two apart. A record with no recorded head reads as
  UNOBSERVED, on the same rule as no record at all.
  \`reply\` refuses without --final: replying per round turns one review thread
  into six, and a reply written mid-flow states an intention rather than an
  outcome. It also refuses a pull request that is closed or merged (override:
  --allow-closed-pr), one whose state could not be read, and a --sha that is not
  the pull request's head — the answers must describe the commit it points at. Each reply is at most ${DEFAULT_MAX_SENTENCES_PER_REPLY} sentences (--max-sentences) AND ${DEFAULT_MAX_REPLY_CHARS} characters
  (--max-chars) — CUT to both in code, with the remainder replaced by a link,
  because a sentence budget alone lets one 4,000-character sentence through —
  threaded where GitHub gives a thread, and capped
  at ${DEFAULT_MAX_REPLIES_TOTAL} (--max-replies) with one summary comment and a reported backlog
  beyond it. --max-sentences and --max-chars refuse a value below 1: a reply of
  zero sentences or zero characters is silence with extra steps. --max-replies 0
  is legal and means "one summary comment stands for everybody". Nothing
  here can resolve, hide or dismiss a thread: those endpoints are unreachable
  through the port. --dry-run and --fixtures rehearse the whole pass offline.

budget:
  The gate to run BEFORE dispatching, where stopping is still possible. Exits
  non-zero when spend has reached the ceiling (default ${DEFAULT_SPEND_CEILING_USD} USD) so the
  orchestrator asks the operator instead of proceeding. Also prints the reviewer
  dispatch waves for the concurrency cap (default ${DEFAULT_MAX_PARALLEL_REVIEWERS} in flight).
  --outstanding <n> is what an enclosing orchestrator already has in flight.
  WITHOUT it the cap bounds this plan only: keryx cannot observe subagents in
  another process, so it does NOT bind the total across job-orchestrator ->
  flow-orchestrator -> review-orchestrator, and it says so rather than implying
  otherwise.

tier:
  The \`model\` block a dispatch document carries, COMPUTED — run this instead of
  working the tier out by hand. The signals are ones the orchestrator already
  holds: --scope, --fix-attempt, --forced-strategy-change, --findings,
  --diff-lines, --verifier and --security. Prints the tier, the ordered rule ids
  that produced it, the resolved provider/model, \`tier_resolution\`, and what was
  on the table when it resolved; --json prints the block alone.
  NO MODEL NAME EXISTS IN THIS COMMAND. The session's provider/model come from
  the caller: --session-provider / --session-model, else KERYX_SESSION_PROVIDER /
  KERYX_SESSION_MODEL, else (only with --from-shell-config) the selection
  \`keryx shell\` persisted. The candidate set comes from live provider detection
  (override with --catalog, the \`detectProviders()\` shape). A model is named
  only when discovery assigned one other than the session's; otherwise the block
  says \`inherit\` with the tier, and the host picks its own model for that tier
  (standard: the session model). Never a non-zero exit. Detection is skipped
  entirely when the session names no provider and model, because ranking is
  refused without an anchor whatever the catalogue holds.

learn:
  The join between collected comments and this project's own review skill.
  Reads \`.metaproject/review-learning.config.json\` — which local skill, which
  repository, which comment authors — then reads the record
  \`review comments collect\` already wrote and NEVER fetches from GitHub. Keeps
  only comments whose author the config names; an author it does not name
  contributes nothing to any proposal. Writes a proposal under
  \`.metaproject/data/gdskills/proposals/\` and changes no skill:
  \`keryx skills learn apply\` remains the only writer, and it refuses any target
  outside \`.metaproject/project-skills/\`.
  A project with NO config file does not learn. That prints one line and exits 0
  — it is a supported state, not a warning.
  There is no --authors, --skill or --repo flag on purpose: a flag would make the
  configured list a default, and one invocation could teach a project from
  somebody it never named.

  \`--reviewer <id>\` (W3) is a sibling mode: it applies an accepted, human-reviewed
  \`domain: review-conventions\` learned-pattern record (from \`keryx learn accept\`)
  into \`.metaproject/rules/reviewers/<id>.mdc\` — the per-reviewer rule this
  project has learned from that reviewer's own comments, never the literal login.
  \`--pr\` is not read in this mode.

loop:
  Loop DETECTION, not counting. Escalates (exit non-zero) when the same finding
  recurs in two rounds, or two consecutive rounds produce identical output —
  regardless of the remaining round budget, which it deliberately never reads.
  It reads the flow's review packages on disk and the persisted
  \`tasks[].attempts.count\`, never a session's own memory: a resumed session
  starts at zero while the real count does not.

stack:
  Deterministic stack scoping, no model call. Reads package.json once and every
  installed review-category skill's \`metadata.stack_requires\`, then reports
  per reviewer whether its declared requirement (nestjs, react, mobx, prisma)
  is met. UNCERTAIN detection (package.json missing or unparsable) — and any
  reviewer that declares no requirement — always resolves to \`include: true\`;
  a stack-gated reviewer is excluded ONLY when detection ran cleanly and found
  none of its declared tags. \`review-orchestrator\` calls this before dispatch
  and records the exclusions with their reasons; a reviewer silently absent from
  a report would read as having had nothing to say.
`);
}
