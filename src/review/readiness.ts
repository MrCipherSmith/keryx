// One checklist that a review passes before it may be called completed or reach GitHub. Every item reuses a check that
// already exists; this module only puts them in one list, names the repair command of each, and records a waiver in the
// operator's own words. Nothing here writes except `waiveReadiness`.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { shellWord } from "../lib/shell-quote";
import { testsNotRunWarning } from "./tests-to-run";
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { isCapDrop, isReasonedDrop } from "./blast-radius";
import { computeCoverage } from "./coverage-complete";
import { hasChunkPlan } from "./chunks";
import { packageScopeFiles } from "./coverage";
import { completeHeadGate, isPrBound, type PrLookup } from "./complete-head-gate";
import { dispatchErrors } from "./dispatch";
import { ORCHESTRATOR_LOG, memoryCalls, readToolLog } from "./layers-usage";
import { CALLER_ORCHESTRATOR, CALLER_UNATTRIBUTED, ENV_REVIEW_CALLER_TOKEN } from "./orchestrator-log";
import { readRunProfile } from "./run-profile";
import type { PremiseQuestionDecision } from "./operator-decisions";
import { awaitingOperator, premiseHoldState } from "./premise";
import { premiseRecords } from "./verdict";
import { packageParityWarnings } from "./parity";
import { packageCoverageErrors, researchErrors } from "./research";
import type { ConfirmedVia, ManagedReviewManifest, ReadinessWaiver } from "./types";

export const READINESS_ITEMS = [
  { number: 1, id: "files-covered", title: "every changed file is covered by a wave or a recorded waiver" },
  { number: 2, id: "blast-radius", title: "no file the blast radius cut is left unreviewed" },
  { number: 3, id: "reviewers", title: "every planned reviewer was dispatched and its result ingested" },
  { number: 4, id: "verifier", title: "the verifier checked every finding it should, or the report says how many it did not" },
  { number: 5, id: "ledger", title: "the ledger is READY: every obligation has a closure" },
  { number: 6, id: "coverage-md", title: "coverage.md states the ingest status of each reviewer truthfully" },
  { number: 7, id: "head", title: "the report's head matches the PR head" },
  { number: 8, id: "report-names", title: "pending mutation candidates and parity warnings are named in the report" },
  { number: 9, id: "pr-files", title: "the changed-file count equals the PR's own file list" },
  { number: 10, id: "memory-outside-stage", title: "the orchestrator read memory only in its own memory stage" },
  { number: 11, id: "premise-decisions", title: "every held finding has an operator decision" },
  { number: 12, id: "quotes-located", title: "every open finding's quote is placed in its file, or the finding is answered" },
] as const;

export type ReadinessItemId = (typeof READINESS_ITEMS)[number]["id"];
export type ReadinessStatus = "pass" | "fail" | "waived";

export type ReadinessItem = {
  number: number;
  id: ReadinessItemId;
  title: string;
  status: ReadinessStatus;
  evidence: string;
  /** The exact command (or edit) that repairs a failing item. Absent when the item passes. */
  repair?: string;
  /** The operator's own words, for a waived item. */
  waiver?: { operatorQuote: string; time: string };
};

export type ReadinessReport = {
  schemaVersion: 1;
  review: string;
  verdict: "READY" | "NOT READY";
  items: ReadinessItem[];
  /** Non-blocking notes, e.g. "N tests listed to run; none recorded as run". Absent when there is none. */
  warnings?: string[];
};

export type ReadinessOptions = {
  /** Reads the PR's state and head; absent means the head check is not made. */
  prLookup?: PrLookup | undefined;
  /** Reads the PR's own file list; absent means item 9 checks the recorded scope against the blast-radius record only. */
  prFiles?: ((ref: string) => Promise<string[] | null>) | undefined;
  /** True when the caller has already run the head gate against the head it will record (`review complete --head`). */
  headChecked?: boolean | undefined;
};

/** A recount whose changed-file count exceeds this multiple of the PR's own list was made against the wrong base. */
export const RECOUNT_RATIO = 3;

/** The refusal text for a recount that would replace the package's scope with a base that changes the count past {@link RECOUNT_RATIO}x. */
export function recountRefusal(recountedCount: number, recordedScope: readonly string[], packageArg: string): string | undefined {
  if (recordedScope.length === 0 || recountedCount <= RECOUNT_RATIO * recordedScope.length) return undefined;
  return (
    `recount refused: this base gives ${recountedCount} changed file(s) but the package's recorded scope holds ${recordedScope.length} (more than ${RECOUNT_RATIO}x), which a recount against the wrong base produces. The recorded scope is kept and nothing was written. ` +
    `Recount from the PR's own file list: keryx review blast-radius --package ${packageArg} --changed <the PR's files, comma-separated>`
  );
}
const MIN_WAIVER_QUOTE_CHARS = 8;
const FIRST = 5;

const readJson = <T>(file: string): Promise<T | undefined> => readJsonFileOr<T | undefined>(file, undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const some = (names: readonly string[]): string => names.slice(0, FIRST).join(", ") + (names.length > FIRST ? `, … (+${names.length - FIRST})` : "");

function packageArg(packageDir: string): string {
  return shellWord(path.relative(process.cwd(), packageDir) || ".");
}

export function readinessItemId(selector: string): ReadinessItemId | undefined {
  const wanted = selector.trim().toLowerCase();
  const byNumber = /^\d+$/.test(wanted) ? READINESS_ITEMS.find((item) => item.number === Number(wanted)) : undefined;
  return (byNumber ?? READINESS_ITEMS.find((item) => item.id === wanted))?.id;
}

type Verdict = { pass: true; evidence: string } | { pass: false; evidence: string; repair: string };
const ok = (evidence: string): Verdict => ({ pass: true, evidence });
const bad = (evidence: string, repair: string): Verdict => ({ pass: false, evidence, repair });

type Context = {
  dir: string;
  arg: string;
  manifest: ManagedReviewManifest;
  report: string;
  research: Record<string, unknown> | undefined;
  findings: Array<Record<string, unknown>>;
  /**
   * The records the premise check reads, exactly as the verdict reads them (findings.json once ingested, raw results with
   * premises.json before), and the operator's answers to held findings (`premise-question` decisions).
   */
  premise: { records: Array<Record<string, unknown>>; decisions: PremiseQuestionDecision[]; ingested: boolean };
  /** True when the package carries the dispatch record (a package cut before it existed is not held to it). */
  dispatched: boolean;
};

async function filesChecks(ctx: Context): Promise<{ files: Verdict; radius: Verdict }> {
  const coverage = await computeCoverage(ctx.dir, ctx.research === undefined ? {} : { research: ctx.research });
  if (!coverage.tracked) {
    const note = ok("coverage is not tracked: no slice manifest, no dropped blast-radius files");
    return { files: note, radius: note };
  }
  const blast = await readJson<{ dropped?: Array<{ file?: unknown; reason?: unknown }> }>(path.join(ctx.dir, "blast-radius.json"));
  const cut = new Set((blast?.dropped ?? []).filter((entry) => text(entry.file) && isCapDrop(entry.reason)).map((entry) => entry.file as string));
  const uncovered = coverage.files.filter((entry) => entry.status === "uncovered");
  const uncoveredCut = uncovered.filter((entry) => cut.has(entry.file)).map((entry) => entry.file);
  const uncoveredRest = uncovered.filter((entry) => !cut.has(entry.file)).map((entry) => entry.file);
  const counts = `${coverage.counts.covered} of ${coverage.counts.inScope} in-scope files covered, ${coverage.counts.omitted} omitted`;
  const waived = coverage.waived ? " (the uncovered files are waived by the recorded coverage waiver)" : "";
  const sliceRepair = `keryx review ledger build <input-dir> --package ${ctx.arg}`;
  const files: Verdict = uncoveredRest.length === 0 || coverage.waived
    ? ok(`${counts}${waived}`)
    : bad(`${uncoveredRest.length} file(s) uncovered: ${some(uncoveredRest)}; ${counts}`, sliceRepair);
  const waveRepair = hasChunkPlan(ctx.dir) ? `keryx review chunks next --package ${ctx.arg}` : `keryx review chunks plan --package ${ctx.arg}`;
  const reasoned = (blast?.dropped ?? []).filter((entry) => text(entry.file) && isReasonedDrop(entry.reason)).length;
  const omittedNote = reasoned === 0 ? "" : `; ${reasoned} graph-related file(s) omitted with a reason (not consumers of the changed contract)`;
  const radius: Verdict = uncoveredCut.length === 0 || coverage.waived
    ? ok(`${cut.size === 0 ? "the blast radius cut nothing" : `${cut.size} file(s) cut by the cap, all covered by a chunk pass${waived}`}${omittedNote}`)
    : bad(`${uncoveredCut.length} of ${cut.size} file(s) cut by the cap were never reviewed: ${some(uncoveredCut)}`, waveRepair);
  return { files, radius };
}

async function reviewersCheck(ctx: Context): Promise<Verdict> {
  if (!ctx.dispatched) return ok("this package predates the dispatch record, so there is nothing to hold it against");
  const dispatch = record(ctx.research?.dispatch);
  if (dispatch === undefined) return bad("no reviewer dispatch is recorded in research.json", `keryx review ledger build <input-dir> --package ${ctx.arg}`);
  const problems = dispatchErrors(dispatch);
  const runs = (Array.isArray(dispatch.runs) ? dispatch.runs : []).map(record).filter((run): run is Record<string, unknown> => run !== undefined);
  const selected = Array.isArray(dispatch.selected) ? dispatch.selected.filter(text) : [];
  const ran = new Set(runs.map((run) => String(run.reviewer)));
  const unfinished = runs.filter((run) => run.status !== "complete" || run.scopeComplete === false).map((run) => String(run.reviewer));
  const unplanned = selected.filter((name) => !ran.has(name));
  const lost: string[] = [];
  for (const run of runs) {
    const evidence = typeof run.rawEvidence === "string" ? run.rawEvidence.split("#")[0] : undefined;
    if (run.status !== "complete" || evidence === undefined || evidence === "") continue;
    if (!(await pathExists(path.join(ctx.dir, evidence))) && (await pathExists(path.join(ctx.dir, "raw")))) lost.push(String(run.reviewer));
  }
  const all = [...new Set([...unfinished, ...unplanned, ...lost])];
  // The coverage gate `review complete` runs, with the same options (flow 460): readiness must not say READY while
  // complete refuses the reviewer set, the round depth or an unwaived mutation pass.
  const coverage = problems.length === 0 ? await packageCoverageErrors(ctx.dir, dispatch) : [];
  if (problems.length === 0 && all.length === 0 && coverage.length === 0) return ok(`${runs.length} reviewer run(s), all complete with their result on disk; the coverage gate accepts the dispatch`);
  const parts = [
    ...(unfinished.length > 0 ? [`not run or incomplete: ${some(unfinished)}`] : []),
    ...(unplanned.length > 0 ? [`planned with no run recorded: ${some(unplanned)}`] : []),
    ...(lost.length > 0 ? [`result file missing from raw/: ${some(lost)}`] : []),
    ...problems.slice(0, 2),
    ...coverage.map((error) => `coverage gate (as review complete runs it): ${error}`),
  ];
  const repair = all.length === 0 && coverage.length > 0
    ? "do what the coverage gate message names (dispatch the missing reviewers, or record the operator's decision), then re-run `keryx review readiness`"
    : `dispatch ${some(all.length > 0 ? all : ["the missing reviewers"])}, save each reply to raw/<reviewer>.txt, then \`keryx review ledger build <input-dir> --package ${ctx.arg}\``;
  return bad(parts.join("; "), repair);
}

const pathExists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

const NOT_VERIFIED = /not\s+verified\s*[:=]?\s*(\d+)/i;

function verifierCheck(ctx: Context): Verdict {
  const heavy = ctx.findings.filter((finding) => ["blocker", "major"].includes(String(finding.severity)));
  const unverified = heavy.filter((finding) => record(finding.verification) === undefined);
  if (unverified.length === 0) return ok(`${heavy.length} blocker/major finding(s), all verified`);
  const stated = NOT_VERIFIED.exec(ctx.report);
  if (stated !== null && Number(stated[1]) >= unverified.length) return ok(`${unverified.length} of ${heavy.length} blocker/major finding(s) unverified, and the report says so`);
  return bad(
    `${unverified.length} of ${heavy.length} blocker/major finding(s) carry no verification and the report does not state the count`,
    `run the verifier (review-verifier) on them, or add the line \`Not verified: ${unverified.length}\` to report.md`,
  );
}

/**
 * Flow 459. A finding the premise judge held (`challenged` / `owner-decision`) is a question for the operator, and a
 * review with an unanswered question is not finished: it is neither fixed nor dismissed. The repair is the answer, not a
 * waiver of the question.
 */
function premiseDecisionsCheck(ctx: Context): Verdict {
  const { records, decisions } = ctx.premise;
  const held = records.filter((finding) => premiseHoldState(finding, decisions) !== "none");
  if (held.length === 0) return ok("no finding is held by the premise judge");
  const awaiting = awaitingOperator(records, decisions);
  if (awaiting.length === 0) return ok(`${held.length} held finding(s), every one with an operator decision`);
  const evidence = `${awaiting.length} of ${held.length} held finding(s) have no operator decision: ${some(awaiting)}`;
  // Before an ingest the held records come from raw results and premises.json, and the answer commands read
  // findings.json only (review F-002): the first repair is the ingest.
  if (!ctx.premise.ingested) {
    return bad(`${evidence} (not ingested yet)`, `ingest the round with its premise results first (\`keryx review ingest ... --premises ${ctx.arg}/research-evidence/premises.json\`), then ask the operator to answer each held finding`);
  }
  return bad(
    evidence,
    `ask the operator: in keryx shell call the review_decide_premise tool (a card); in a terminal run keryx review decide-premise --package ${ctx.arg} --finding <id> --answer uphold|dismiss --reason "<why>"`,
  );
}

/** Why `premise-decisions` is never waived (shared by `waiveReadiness` and the `review_waive_readiness` card). */
export const PREMISE_DECISIONS_NOT_WAIVABLE =
  "premise-decisions cannot be waived in the operator's own words. A held finding needs its own answer: run `keryx review decide-premise --package <review-dir> --finding <id> --answer uphold|dismiss --reason \"<why>\"`, or in keryx shell call the review_decide_premise tool (the operator answers a card).";

/**
 * Flow 460. `review ingest` keeps a finding whose quote is absent from its file, or in it more than once, with no line
 * and the flag `quote_unlocated`, instead of refusing the round. Such a finding is a claim nobody could place, so it may
 * not pass silently: while it has no disposition this item FAILS and names it. It is waivable in the operator's own
 * words like any other item (unlike `premise-decisions`): the repair is a re-quote and re-ingest, or a disposition with
 * evidence, and an operator may decide an unplaced claim is acceptable for this round.
 */
function quotesLocatedCheck(ctx: Context): Verdict {
  const flagged = ctx.findings.filter((finding) => record(finding.quote_unlocated) !== undefined);
  if (flagged.length === 0) return ok("every quoted finding was placed in its file at the reviewed head");
  const name = (finding: Record<string, unknown>): string => {
    const flag = record(finding.quote_unlocated) ?? {};
    const lines = Array.isArray(flag.candidate_lines) ? ` lines ${flag.candidate_lines.join(", ")}` : "";
    return `${String(finding.global_id ?? finding.id)} (${String(finding.file ?? "no file")}: ${String(flag.reason)}${lines})`;
  };
  const answered = (finding: Record<string, unknown>): boolean => {
    const state = record(finding.disposition)?.state;
    return typeof state === "string" && state !== "" && state !== "unknown";
  };
  const open = flagged.filter((finding) => !answered(finding));
  if (open.length === 0) return ok(`${flagged.length} finding(s) with an unplaced quote, every one with a disposition: ${some(flagged.map(name))}`);
  return bad(
    `${open.length} open finding(s) quote code that could not be placed in the file at the reviewed head (kept with no line, flagged quote_unlocated): ${some(open.map(name))}`,
    `re-quote one distinct line from \`git show <head>:<path>\` in the reviewer's result and re-ingest, or record a disposition with evidence; or the operator waives it: in keryx shell call the review_waive_readiness tool with item quotes-located; in a terminal run keryx review complete ${ctx.arg} --waive quotes-located "<operator quote>"`,
  );
}

function ledgerCheck(ctx: Context): Verdict {
  if (!ctx.dispatched) return ok("this package predates the research ledger");
  if (ctx.research === undefined) return bad("research.json is missing or unreadable", `keryx review ledger build <input-dir> --package ${ctx.arg}`);
  const problems = researchErrors(ctx.research, ctx.findings);
  if (problems.length === 0) return ok(`ledger READY: ${Array.isArray(ctx.research.obligations) ? ctx.research.obligations.length : 0} obligation(s) all closed`);
  return bad(`${problems.length} ledger problem(s): ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "; …" : ""}`, `close each obligation with a disposition, then \`keryx review ledger build <input-dir> --package ${ctx.arg} --dispositions <file>\``);
}

async function coverageMdCheck(ctx: Context): Promise<Verdict> {
  const raw = await readFile(path.join(ctx.dir, "coverage.md"), "utf8").catch(() => undefined);
  const runs = (Array.isArray(record(ctx.research?.dispatch)?.runs) ? (record(ctx.research?.dispatch)!.runs as unknown[]) : []).map(record);
  const bad2 = new Set(runs.filter((run) => run !== undefined && run.status !== "complete").map((run) => String(run!.reviewer)));
  if (raw === undefined) return bad("coverage.md is missing", `re-run keryx review ingest <input> for this package: it writes coverage.md`);
  const claimed = [...raw.matchAll(/reviewer:\s*(\S+)\s*\n\s*status:\s*(\S+)/g)].filter((match) => match[2] === "run").map((match) => match[1] as string);
  const lying = claimed.filter((name) => bad2.has(name));
  if (lying.length === 0) return ok(`${claimed.length} reviewer(s) listed as run, none contradicted by the dispatch record`);
  return bad(`coverage.md lists ${some(lying)} as "run", but the dispatch record says they did not finish`, `re-run keryx review ingest <input> for this package: it rewrites coverage.md from the dispatch record`);
}

async function headCheck(ctx: Context, options: ReadinessOptions): Promise<Verdict> {
  if (!isPrBound(ctx.manifest.target)) return ok("not a pull-request package");
  if (options.headChecked === true) return ok("the head gate ran at this close");
  if (options.prLookup === undefined) return ok("the PR head was not read (no tracker available)");
  try {
    const { warnings } = await completeHeadGate({ manifest: ctx.manifest, report: withoutPartialHeader(ctx.report), lookup: options.prLookup });
    return ok(warnings.length === 0 ? "the reviewed head is the PR head" : warnings.join("; "));
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/^Cannot complete managed review;\s*/, "");
    return bad(message, `edit the first line of report.md to name the reviewed SHA and say the PR moved, or re-run the round on the new head`);
  }
}

async function reportNamesCheck(ctx: Context): Promise<Verdict> {
  const warnings = await packageParityWarnings(ctx.dir, ctx.report).catch(() => []);
  if (warnings.length === 0) return ok("every pending mutation candidate, held severity and follow-up is named in the report");
  return bad(warnings.slice(0, 2).join("; "), "add the lines named above to report.md (keryx review parity prints them)");
}

async function prFilesCheck(ctx: Context, options: ReadinessOptions): Promise<Verdict> {
  if (!isPrBound(ctx.manifest.target)) return ok("not a pull-request package");
  const scope = (await packageScopeFiles(ctx.dir)) ?? [];
  const blast = await readJson<{ changedFiles?: unknown }>(path.join(ctx.dir, "blast-radius.json"));
  const recounted = Array.isArray(blast?.changedFiles) ? blast!.changedFiles.length : undefined;
  if (recounted !== undefined && scope.length > 0 && recounted > RECOUNT_RATIO * scope.length) {
    return bad(
      `blast-radius.json was computed for ${recounted} changed file(s) but the package scope holds ${scope.length}: more than ${RECOUNT_RATIO}x, which a recount against the wrong base produces`,
      `restore the recorded scope and recount from the PR's own file list: keryx review blast-radius --package ${ctx.arg} --changed <the PR's files, comma-separated>`,
    );
  }
  if (options.prFiles === undefined) return ok(`${scope.length} changed file(s) in scope; the PR's own file list was not read`);
  let list: string[] | null;
  try { list = await options.prFiles(ctx.manifest.target.ref); } catch { list = null; }
  if (list === null) return ok(`${scope.length} changed file(s) in scope; the PR's own file list could not be read`);
  const have = new Set(scope);
  const missing = list.filter((file) => !have.has(file));
  const extra = scope.filter((file) => !list!.includes(file));
  if (missing.length === 0 && extra.length === 0) return ok(`${scope.length} changed file(s), equal to the PR's file list`);
  return bad(`the package scope holds ${scope.length} file(s), the PR lists ${list.length}${missing.length > 0 ? `; not in scope: ${some(missing)}` : ""}${extra.length > 0 ? `; not in the PR: ${some(extra)}` : ""}`, `re-cut the scope from the PR's file list: keryx review start --pr ${ctx.manifest.target.ref}`);
}

const sameQuery = (a: string, b: string): boolean => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

/**
 * Flow 452. The orchestrator may read project memory once, in its memory stage (`keryx memory search "<query>" --status accepted`);
 * any other memory call in its own tool log is a read from outside that stage. The stage query is the one the manifest records,
 * else the first accepted search in the log. A reviewer's lookups are in the reviewers' own logs and are not read here.
 */
async function memoryStageCheck(ctx: Context): Promise<Verdict> {
  const log = await readToolLog(ctx.dir, ORCHESTRATOR_LOG);
  // Flow 457: outside keryx shell no layer can tell the orchestrator's calls from a reviewer's unless the host passes
  // the caller token; the item then says so instead of passing on a log it could not read.
  const host = readRunProfile(ctx.dir)?.host;
  const blind = host !== undefined && host !== "keryx-shell";
  const notObservable = (why: string): Verdict => ok(`not observable on this host (${host}): ${why}`);
  if (log === undefined) {
    return blind
      ? notObservable(`no orchestrator tool log (tool-calls/${ORCHESTRATOR_LOG}.jsonl) to read`)
      : ok(`no orchestrator tool log (tool-calls/${ORCHESTRATOR_LOG}.jsonl): this check could not see the orchestrator's own memory reads`);
  }
  const clean = ctx.manifest.cleanContext;
  const started = clean === undefined ? Number.NaN : Date.parse(clean.startedAt);
  let stage = clean?.memoryQuery;
  const outside: string[] = [];
  const unattributed: string[] = [];
  let inStage = 0;
  for (const call of memoryCalls(log)) {
    // A reviewer's lookups are its own; a call keryx could not attribute only warns (flow 454, D1).
    if (call.caller === CALLER_UNATTRIBUTED) { unattributed.push(call.summary); continue; }
    if (call.caller !== undefined && call.caller !== CALLER_ORCHESTRATOR) continue;
    const time = call.time === undefined ? Number.NaN : Date.parse(call.time);
    const stageCall = call.search && call.accepted && call.query !== undefined && (stage === undefined || sameQuery(call.query, stage));
    if (!stageCall) outside.push(call.summary);
    else if (time < started) outside.push(`${call.summary} (before the round started)`);
    else {
      stage ??= call.query;
      inStage += 1;
    }
  }
  const warning = unattributed.length === 0 ? "" : `; warning: ${unattributed.length} unattributed memory call(s) (CLI or MCP from a host that names no caller, not counted against the orchestrator): ${some(unattributed)}`;
  if (outside.length === 0 && inStage === 0 && blind) {
    return notObservable(
      `no memory call in the log is attributable to the orchestrator; export ${ENV_REVIEW_CALLER_TOKEN} from the token \`keryx review start\` printed so the host's own keryx calls are attributed${warning}`,
    );
  }
  if (outside.length === 0) {
    const recorded = log.split("\n").some((line) => line.includes('"log-start"') || line.includes('"source"'));
    const none = recorded ? "no memory call recorded by the orchestrator (log written by keryx)" : "the orchestrator made no memory call";
    return ok(`${inStage === 0 ? none : `${inStage} memory call(s) by the orchestrator, all the stage query${stage === undefined ? "" : ` "${stage}"`}`}${warning}`);
  }
  return bad(
    `${outside.length} memory call(s) by the orchestrator outside its memory stage: ${some(outside)}${warning}`,
    `run the review from a session whose only memory read is the stage query (keryx memory search "<query>" --status accepted, once), or record the operator's decision: in keryx shell call the review_waive_readiness tool with item memory-outside-stage (the operator answers a card); in a terminal run keryx review complete ${ctx.arg} --waive memory-outside-stage "<operator quote>"`,
  );
}

/** The checklist, computed from what the package holds. Writes nothing. */
export async function computeReadiness(packageDir: string, options: ReadinessOptions = {}): Promise<ReadinessReport> {
  const manifest = await readJson<ManagedReviewManifest>(path.join(packageDir, "manifest.json"));
  if (manifest === undefined) throw new Error(`Managed review package has no readable manifest.json: ${packageDir}`);
  const research = record(await readJson<unknown>(path.join(packageDir, "research.json")));
  const findingsRaw = await readJson<unknown>(path.join(packageDir, "findings.json"));
  const ctx: Context = {
    dir: packageDir,
    arg: packageArg(packageDir),
    manifest,
    report: (await readFile(path.join(packageDir, "report.md"), "utf8").catch(() => "")) as string,
    research,
    findings: Array.isArray(findingsRaw) ? findingsRaw.map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [],
    premise: await premiseRecords(packageDir),
    dispatched: manifest.artifacts.reviewerDispatch !== undefined || manifest.artifacts.research !== undefined,
  };
  const { files, radius } = await filesChecks(ctx);
  const verdicts: Record<ReadinessItemId, Verdict> = {
    "files-covered": files,
    "blast-radius": radius,
    reviewers: await reviewersCheck(ctx),
    verifier: verifierCheck(ctx),
    ledger: ledgerCheck(ctx),
    "coverage-md": await coverageMdCheck(ctx),
    head: await headCheck(ctx, options),
    "report-names": await reportNamesCheck(ctx),
    "pr-files": await prFilesCheck(ctx, options),
    "memory-outside-stage": await memoryStageCheck(ctx),
    "premise-decisions": premiseDecisionsCheck(ctx),
    "quotes-located": quotesLocatedCheck(ctx),
  };
  const waivers = new Map((manifest.readiness_waivers ?? []).map((waiver) => [waiver.item, waiver]));
  const items: ReadinessItem[] = READINESS_ITEMS.map((spec) => {
    const verdict = verdicts[spec.id];
    const waiver = waivers.get(spec.id);
    if (verdict.pass) return { ...spec, status: "pass", evidence: verdict.evidence };
    if (waiver !== undefined) return { ...spec, status: "waived", evidence: verdict.evidence, repair: verdict.repair, waiver: { operatorQuote: waiver.operator_quote, time: waiver.time } };
    return { ...spec, status: "fail", evidence: verdict.evidence, repair: verdict.repair };
  });
  const testsNotRun = testsNotRunWarning(packageDir);
  return { schemaVersion: 1, review: manifest.reviewId, verdict: items.every((item) => item.status !== "fail") ? "READY" : "NOT READY", items, ...(testsNotRun === undefined ? {} : { warnings: [testsNotRun] }) };
}

export const failingItems = (report: ReadinessReport): ReadinessItem[] => report.items.filter((item) => item.status === "fail");

/** The checklist as the CLI, `review status` and the panel print it. */
export function renderReadiness(report: ReadinessReport): string[] {
  const lines = [`readiness: ${report.verdict} (${report.review})`];
  for (const item of report.items) {
    const mark = item.status === "pass" ? "pass  " : item.status === "waived" ? "waived" : "FAIL  ";
    lines.push(`  ${item.number}. [${mark}] ${item.id}: ${item.title}`);
    lines.push(`       ${item.evidence}`);
    if (item.id === "memory-outside-stage") lines.push(`       ${memoryLogNote(report)}`);
    if (item.status === "waived" && item.waiver !== undefined) lines.push(`       waived by the operator: ${item.waiver.operatorQuote}`);
    if (item.status === "fail" && item.repair !== undefined) lines.push(`       repair: ${item.repair}`);
  }
  for (const warning of report.warnings ?? []) lines.push(`  warning (not blocking): ${warning}`);
  return lines;
}

/** One line with the verdict and the failing item ids, for a status screen. */
export function readinessLine(report: ReadinessReport): string {
  const failing = failingItems(report);
  return failing.length === 0 ? `readiness: ${report.verdict}` : `readiness: ${report.verdict} — ${failing.length} failing: ${failing.map((item) => item.id).join(", ")}`;
}

/** The verdict and each failing item with what is missing; one projection for the depth tab, the readline text and `review status`. */
export function readinessDepthLines(report: ReadinessReport | undefined): string[] {
  if (report === undefined) return ["readiness: not read"];
  const memory = report.items.find((item) => item.id === "memory-outside-stage");
  const note = memoryLogNote(report);
  // A passing item is not listed above, yet whether its log was recorded or absent is what tells a pass from a blind pass (flow 454).
  const logLine = memory === undefined || memory.status === "fail" || note === "" ? [] : [`  memory-outside-stage: ${note}`];
  return [readinessLine(report), ...failingItems(report).map((item) => `  ${item.id}: ${item.evidence}`), ...logLine];
}

/**
 * The orchestrator log as the compact surfaces say it: `orchestrator log: recorded` or `orchestrator log: none`, and the count of
 * calls keryx could not attribute (flow 454). The same words the item's own detail line uses, taken from it so they cannot drift.
 */
export function memoryLogNote(report: ReadinessReport): string {
  const item = report.items.find((entry) => entry.id === "memory-outside-stage");
  if (item === undefined) return "";
  const state = item.evidence.startsWith("no orchestrator tool log") ? "none" : "recorded";
  const unattributed = /(\d+) unattributed memory call/.exec(item.evidence)?.[1];
  return `orchestrator log: ${state}${unattributed === undefined ? "" : `, ${unattributed} unattributed`}`;
}

/** What `complete` and `publish` refuse with. */
export function readinessRefusal(report: ReadinessReport, action: string): string {
  const failing = failingItems(report);
  return [
    `Cannot ${action}; the readiness checklist has ${failing.length} failing item(s):`,
    ...failing.flatMap((item) => [`  ${item.number}. ${item.id}: ${item.evidence}`, `     repair: ${item.repair}`]),
    action === "publish"
      ? "Repair them, or publish a partial review (the page says what is missing): `keryx review publish <review> --partial`."
      : "Repair them, or waive an item in the operator's own words: `keryx review complete <review> --waive <item> \"<operator quote>\"`.",
  ].join("\n");
}

const PARTIAL_LINE = /^Partial review:/;

/** The report without its waiver header, for checks that read the report's own first line. */
export const withoutPartialHeader = (report: string): string => report.split(/\r?\n/).filter((line) => !PARTIAL_LINE.test(line)).join("\n");

/** The first lines of report.md: one line per waived item, replacing any earlier set. */
export function partialHeader(waivers: readonly ReadinessWaiver[]): string[] {
  return waivers.map((waiver) => `Partial review: ${waiver.item} waived by the operator: ${waiver.operator_quote}`);
}

async function writePartialHeader(packageDir: string, waivers: readonly ReadinessWaiver[]): Promise<void> {
  const file = path.join(packageDir, "report.md");
  const lines = (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/);
  while (lines.length > 0 && (PARTIAL_LINE.test(lines[0]!) || (lines[0]!.trim() === "" && PARTIAL_LINE.test(lines[1] ?? "")))) lines.shift();
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  await writeFileAtomic(file, `${[...partialHeader(waivers), "", ...lines].join("\n").replace(/\n+$/, "")}\n`);
}

/**
 * Waives the named failing items in the operator's own words: written into the manifest and into the first lines of
 * report.md. A quote that is a flag name, a one-word "ok" or too short is refused, as the coverage waiver does.
 * `premise-decisions` (item 11) is the one item that cannot be waived: a held finding needs its own answer
 * (`keryx review decide-premise` / the `review_decide_premise` card), which says uphold or dismiss for that finding; a
 * blanket quote would let every held finding through unanswered.
 */
export async function waiveReadiness(packageDir: string, selectors: readonly string[], operatorQuote: string, options: ReadinessOptions & { now?: Date; confirmedVia?: ConfirmedVia } = {}): Promise<ReadinessWaiver[]> {
  const quote = operatorQuote.replace(/-{0,2}waive/gi, "").trim();
  if (quote.length < MIN_WAIVER_QUOTE_CHARS || !/[\p{L}\p{N}]/u.test(quote)) {
    throw new Error(`--waive needs the operator's own words as its value: at least ${MIN_WAIVER_QUOTE_CHARS} characters, with letters or digits in them.`);
  }
  const ids = selectors.map((selector) => {
    const id = readinessItemId(selector);
    if (id === undefined) throw new Error(`--waive: "${selector}" is not a readiness item. Items: ${READINESS_ITEMS.map((item) => `${item.number} ${item.id}`).join(", ")}.`);
    return id;
  });
  if (ids.includes("premise-decisions")) {
    throw new Error(`--waive: ${PREMISE_DECISIONS_NOT_WAIVABLE}`);
  }
  const report = await computeReadiness(packageDir, options);
  const notFailing = ids.filter((id) => report.items.find((item) => item.id === id)?.status === "pass");
  if (notFailing.length > 0) throw new Error(`--waive: ${notFailing.join(", ")} already pass${notFailing.length === 1 ? "es" : ""}; there is nothing to waive.`);
  const manifestPath = path.join(packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  const time = (options.now ?? new Date()).toISOString();
  const kept = (manifest.readiness_waivers ?? []).filter((waiver) => !(ids as string[]).includes(waiver.item));
  const added: ReadinessWaiver[] = ids.map((item) => ({ item, operator_quote: quote, time, ...(options.confirmedVia === undefined ? {} : { confirmedVia: options.confirmedVia }) }));
  const all = [...kept, ...added].sort((a, b) => READINESS_ITEMS.findIndex((i) => (i.id as string) === a.item) - READINESS_ITEMS.findIndex((i) => (i.id as string) === b.item));
  await writeFileAtomic(manifestPath, `${JSON.stringify({ ...manifest, readiness_waivers: all }, null, 2)}\n`);
  await writePartialHeader(packageDir, all);
  return added;
}
