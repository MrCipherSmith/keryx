import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { optionValue } from "../lib/args";
import { writeFileAtomic } from "../lib/fs";
import {
  completeManagedReview,
  createManagedReviewPackage,
  getManagedReviewStatus,
  upsertPreFilterScopeBlock,
  type FindingDispositionRecord,
} from "../review/managed";
import {
  buildPathScope,
  buildReviewScope,
  DEFAULT_CONTEXT_LINES,
  renderReviewScopeMarkdown,
  renderScopedDiff,
  type ReviewScope,
} from "../review/scope";
import { isVerificationMode, verificationClaims } from "../review/verification";
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
  VERIFICATION_MODES,
  type FindingDispositionState,
  type ManagedReviewInput,
  type ManagedReviewMode,
  type ReviewFindingsSource,
  type ReviewScopeRecordLike,
  type ReviewTargetKind,
  type VerificationSource,
} from "../review/types";

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
  "--flow",
  "--review-id",
  "--reviewers",
  "--report",
  "--verifications",
  "--verification-mode",
  "--scope",
  "--refuted",
  "--max-findings",
  "--spent",
  "--spend-ceiling",
  "--parallel",
  "--outstanding",
] as const;

const BUDGET_FLAGS = ["--spent", "--ceiling", "--parallel", "--outstanding", "--reviewers"] as const;

const LOOP_FLAGS = ["--flow", "--task"] as const;

const SCOPE_FLAGS = [
  "--context",
  "--path",
  "--diff",
  "--ref",
  "--base",
  "--json",
  "--scoped-diff",
  "--append",
] as const;

const COMPLETE_FLAGS = ["--finding", "--disposition", "--evidence"] as const;

const STACK_FLAGS = ["--json"] as const;

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
    if (command === "budget") {
      await runBudget(args.slice(1));
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
  const input: ManagedReviewInput = {
    cwd: process.cwd(),
    mode,
    target: { kind: targetKind, ref: targetRef },
    flowId: optionValue(args, "--flow"),
    reviewId: optionValue(args, "--review-id"),
    reviewers,
    reportPath: optionValue(args, "--report"),
    refuted: await readRefuted(optionValue(args, "--refuted")),
    verifications: await readVerifications(optionValue(args, "--verifications")),
    verificationMode: parseVerificationMode(optionValue(args, "--verification-mode")),
    scope: await readScope(optionValue(args, "--scope")),
    maxFindingsPerReviewer: parseNonNegativeInteger(optionValue(args, "--max-findings"), "--max-findings"),
    spend: parseMoney(optionValue(args, "--spent"), "--spent"),
    spendCeiling: parseMoney(optionValue(args, "--spend-ceiling"), "--spend-ceiling"),
    concurrency: parseConcurrency(args),
  };
  const result = await createManagedReviewPackage(input);
  console.log(`# managed review: ${result.reviewId}`);
  console.log("");
  console.log(`mode: ${result.manifest.mode}`);
  console.log(`status: ${result.manifest.status}`);
  console.log(`path: ${result.path}`);
  console.log(`flow: ${result.manifest.flow?.id ?? "none"}`);
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
  const concurrency = caps.concurrency;
  if (concurrency !== undefined) {
    console.log(
      `concurrency cap: cap=${concurrency.cap} effective=${concurrency.effective} waves=${concurrency.waves.length} queued=${concurrency.queued} holds_across_nesting=${
        concurrency.holdsAcrossNesting ? "yes (declared)" : "no"
      }`,
    );
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
  console.log(`flow: ${manifest.flow?.id ?? "none"}`);
  console.log(`coverage: ${manifest.coverage.length}`);
}

async function runComplete(args: string[]): Promise<void> {
  rejectUnknownFlags(args, COMPLETE_FLAGS, "complete <review-id-or-path>");
  const ref = args[0];
  if (!ref) {
    throw new Error("Usage: keryx review complete <review-id-or-path>");
  }
  const dispositions = parseDispositions(args);
  const manifest = await completeManagedReview(process.cwd(), ref, { dispositions });
  console.log(`# managed review complete: ${manifest.reviewId}`);
  console.log(`status: ${manifest.status}`);
  console.log(`dispositions recorded: ${dispositions.length}`);
  if (dispositions.length === 0) {
    // Said out loud, because the silence is the failure mode. A round that
    // closes with nothing recorded leaves 100% of its findings reading
    // `unknown`, and a corpus of unknowns is what makes precision unmeasurable.
    console.log(
      "no --finding/--disposition given: every finding in this package still reads `unknown` — nobody recorded an outcome.",
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
  keryx review attach --flow <id> --target <kind> --ref <ref> [--reviewers a,b] [--report <path>]
  keryx review start --target <kind> --ref <ref> [--reviewers a,b] [--report <path>]
  keryx review ingest --report <path> [--flow <id>] --ref <ref>
                      [--verifications <file|->] [--verification-mode ${VERIFICATION_MODES.join("|")}]
                      [--scope <scope.json>] [--refuted <file|->]
                      [--max-findings <n>] [--spent <usd>] [--spend-ceiling <usd>]
                      [--parallel <n>] [--outstanding <n>]
  keryx review scope [--ref <base>] [--diff <file|->] [--path a,b] [--context <n>]
                     [--json | --scoped-diff] [--append <file>]
  keryx review budget [--spent <usd>] [--ceiling <usd>]
                      [--reviewers a,b] [--parallel <n>] [--outstanding <n>]
  keryx review loop --flow <flow-id> [--task <Tn>]
  keryx review stack [--json]
  keryx review status <review-id-or-path>
  keryx review complete <review-id-or-path>
                        [--finding <id> --disposition <state> --evidence <text>]...
  keryx review lightweight

An unrecognised option is REFUSED, not ignored. A flag that is silently dropped
writes nothing and still reports success, which is how a round can close with
zero dispositions and still print \`status: closed\`.

Modes:
  ${MANAGED_REVIEW_MODES.join(", ")}

scope:
  Deterministic pre-filter, no model call. Drops generated, lockfile, snapshot,
  vendored and minified paths, drops whitespace-only and comment-only change
  blocks, and bounds each retained change to +/-${DEFAULT_CONTEXT_LINES} lines of context by default.
  Prints the retained scope AND every drop with its reason; --append writes the
  same record into the review package's scope.md, REPLACING a
  \`## Pre-filter scope\` block already there rather than adding a second.

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
