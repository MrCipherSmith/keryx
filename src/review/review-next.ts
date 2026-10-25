import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type DriverFile } from "./driver-read";
import { packagePlanGate } from "./estimate";
import { evaluateRetry, withProcessed } from "./retry-eval";
import { writeFileAtomic } from "../lib/fs";
import { parseReviewResult, sha, type ParsedResult } from "./ledger";
import { type RetryState, type ReviewerResult, applyEscalations, emptyRetryState, escalationsFor, needsContextQuestions, normalizeRetryState, scopeFingerprint } from "./retry-plan";
import { type SliceEntry, type SliceManifest } from "./slice";
import { DRIVERS_DIR, RAW_DIR, packageReviewers } from "./wave-drivers";
import { requiredSlices } from "./waves";

/**
 * Flow 458 AC12: `keryx review next --package <dir>`. One call answers what is left to dispatch for the whole package, for
 * every reviewer at once, so the agent does not poll `retry-plan` once per reviewer after every batch.
 *
 * It does not fork retry-plan: each reviewer goes through the same `evaluateRetry` (the late results its drivers name, its
 * retry state, `planRetry`) that `keryx review retry-plan` runs. What it adds is the loop over reviewers, the escalations
 * every result causes (a major finding re-opens a light slice deep for the whole core set), and idempotence: a reply already
 * counted (its hash is in the retry state) is not counted again by the next poll.
 *
 * Flow 475 (R3): a reviewer's replies are all read, not only the newest. They are fed in wave order through the same retry
 * state, so a slice an older wave covered stays covered; `*.prev*.txt` copies are never read; a finished reply with no `slices`
 * array is rejected with a reason instead of being accepted silently.
 */

/** Why a reviewer is handed another dispatch. */
export type NextReason = "missing" | "stalled" | "escalated" | "retry";

export type NextDispatch = {
  reviewer: string;
  /** Which wave this is: the driver's `wave` when `review slice --package` wrote one for these slices, else the next ordinal. */
  wave: number;
  /** Waves this reviewer still owes, this one included. */
  wavesLeft: number;
  slices: string[];
  /** Absolute paths of the slice files, in the same order as `slices`. */
  paths: string[];
  bytes: number;
  reason: NextReason;
  detail: string;
  /** The model recorded for this reviewer (a driver or an earlier reply), echoed so the dispatcher keeps it. */
  model?: string;
  /** Where the reply is to be saved: the driver's `result`, else `raw/<reviewer>-w<wave>.txt`. */
  result: string;
  driver?: string;
  needsContext?: string[];
  /** A stalled reviewer's open slices re-cut smaller: they exist on disk only after `--apply` (or `retry-plan`). */
  recut?: number;
  needsApply?: boolean;
};

export type NextResult = {
  done: boolean;
  package: string;
  dispatches: NextDispatch[];
  /** Reviewers with nothing left to hand out that did not finish: never a clean pass. */
  notRun: Array<{ reviewer: string; reason: string }>;
  /** Reviewers whose state could not be read; the message says what to fix. */
  blocked: Array<{ reviewer: string; message: string }>;
  /** Light slices a finding re-opened deep in this call. */
  escalated: Array<{ slice: string; finding: string; by: string }>;
  /** Finished replies that list no `slices`: nothing is counted from them, their reviewer's slices stay open. They stay listed until the reply is replaced. */
  rejected: Array<{ reviewer: string; file: string; reason: string }>;
  applied: boolean;
  /**
   * Whether the operator's plan covers what is dispatched now: `packagePlanGate(...).refusal === undefined` over the plan with this call's
   * escalations applied. `null` when the gate could not be evaluated; it never changes what is dispatched.
   */
  planAuthorized: boolean | null;
  /** True when the plan is authorized and there is something to dispatch: the orchestrator goes on without asking. */
  continue: boolean;
};

type Reply = { name: string; hash: string; mtimeMs: number; wave: number | undefined; result: ParsedResult };

/** A saved earlier attempt (`X.prev.txt`, `X.prev2.txt`): it is history, not a reply, and never takes part in the choice. */
const PREV_COPY = /\.prev[^/]*\.txt$/;
const waveOfName = (name: string): number | undefined => {
  const match = /-w(\d+)\.txt$/.exec(name);
  return match === null ? undefined : Number(match[1]);
};

/** Every parseable reply in `raw/`, grouped by reviewer and ordered by wave (the driver's `wave`, else the `-w<n>` of the name; a file with neither goes first, by mtime). */
async function collectReplies(packageDir: string, driverOf: ReadonlyMap<string, { reviewer: string; wave?: number | undefined }>): Promise<Map<string, Reply[]>> {
  const replies = new Map<string, Reply[]>();
  const dir = path.join(packageDir, RAW_DIR);
  if (!existsSync(dir)) return replies;
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".txt") && !PREV_COPY.test(entry)).sort()) {
    const file = path.join(dir, name);
    const body = await readFile(file, "utf8");
    const result = parseReviewResult(body);
    if (result === undefined) continue;
    const driver = driverOf.get(name);
    const reviewer = typeof result.reviewer === "string" && result.reviewer !== "" ? result.reviewer : driver?.reviewer;
    if (reviewer === undefined) continue;
    const mine = replies.get(reviewer) ?? [];
    const hash = sha(body);
    if (mine.some((known) => known.hash === hash)) continue;
    mine.push({ name: `${RAW_DIR}/${name}`, hash, mtimeMs: (await stat(file)).mtimeMs, wave: driver?.wave ?? waveOfName(name), result: { ...result, reviewer } });
    replies.set(reviewer, mine);
  }
  for (const mine of replies.values()) mine.sort((a, b) => (a.wave ?? 0) - (b.wave ?? 0) || a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  return replies;
}

const FINISHED = new Set(["DONE", "DONE_WITH_CONCERNS"]);

const statusOf = (reply: Reply): string => String(reply.result.status ?? "").trim().toUpperCase();

/** A finished reply that lists no `slices` and asks nothing: it says nothing about what was covered, so nothing is taken from it. */
const isSliceless = (reply: Reply): boolean => FINISHED.has(statusOf(reply)) && !Array.isArray(reply.result.slices) && needsContextQuestions(reply.result.needs_context).length === 0;

/** Everything still to dispatch for the package, every reviewer at once. Writes only with `apply`. */
export async function reviewNext(input: { packageDir: string; reviewers?: readonly string[] | undefined; apply?: boolean | undefined }): Promise<NextResult> {
  const packageDir = path.resolve(input.packageDir);
  const sliceDir = path.join(packageDir, "slices");
  const manifestSource = path.join(sliceDir, "manifest.json");
  if (!existsSync(manifestSource)) throw new Error(`${manifestSource} is missing: run \`keryx review slice --package ${packageDir}\` first.`);
  let manifest = JSON.parse(await readFile(manifestSource, "utf8")) as SliceManifest;
  const statePath = path.join(sliceDir, "retry-state.json");
  let state: RetryState = existsSync(statePath) ? normalizeRetryState(JSON.parse(await readFile(statePath, "utf8"))) : emptyRetryState();
  const driverFiles = await readDriverFiles(packageDir);
  const driverOf = new Map<string, { reviewer: string; wave?: number | undefined }>();
  for (const driver of driverFiles) if (driver.result !== undefined) driverOf.set(path.basename(driver.result), { reviewer: driver.reviewer, wave: driver.wave });
  let fingerprint: string | undefined;
  try { fingerprint = scopeFingerprint(manifest, (entry) => readFileSync(path.resolve(sliceDir, entry.path), "utf8")); } catch { fingerprint = undefined; }
  const reviewers = [...(input.reviewers ?? (await packageReviewers(packageDir, manifest, { withDrivers: true })))].sort();
  const repliesOf = await collectReplies(packageDir, driverOf);

  // Escalations first: a major finding on a light slice re-opens it deep for every core role, whoever reported it.
  const before = new Map(reviewers.map((reviewer) => [reviewer, new Set(requiredSlices(manifest, reviewer))]));
  const found = reviewers.flatMap((reviewer) => {
    return (repliesOf.get(reviewer) ?? []).flatMap((reply) => escalationsFor(manifest, reviewer, reply.result.findings, driverSlices(driverFiles, reviewer)));
  });
  const escalations = [...new Map(found.map((entry) => [entry.slice, entry])).values()];
  if (escalations.length > 0) manifest = applyEscalations(manifest, escalations);
  const newlyOwned = new Map(reviewers.map((reviewer) => [reviewer, new Set(requiredSlices(manifest, reviewer).filter((id) => !before.get(reviewer)!.has(id)))]));

  const dispatches: NextDispatch[] = [];
  const notRun: NextResult["notRun"] = [];
  const blocked: NextResult["blocked"] = [];
  const rejected: NextResult["rejected"] = [];
  const added: Array<SliceEntry & { text: string }> = [];
  const isCurrent = (): boolean => fingerprint !== undefined && state.scopeFingerprint === fingerprint;
  for (const reviewer of reviewers) {
    const replies = repliesOf.get(reviewer) ?? [];
    const seen = new Set(isCurrent() ? state.reviewers[reviewer]?.processed ?? [] : []);
    const fresh = replies.filter((reply) => !seen.has(reply.hash));
    const refused = fresh.filter(isSliceless);
    for (const reply of refused) rejected.push({ reviewer, file: reply.name, reason: `${statusOf(reply)} without a "slices" list: nothing is counted as covered; list the slice ids that were read` });
    // A reply stamped with another scope is a stale round's: it only blocks the reviewer when it is the newest.
    const usable = fresh.filter((reply) => !isSliceless(reply)).filter((reply) => {
      const stamped = (reply.result as { scopeFingerprint?: unknown }).scopeFingerprint;
      return reply === replies[replies.length - 1] || typeof stamped !== "string" || fingerprint === undefined || stamped === fingerprint;
    });
    if (isCurrent() && state.reviewers[reviewer]?.notRun === true && usable.length === 0) {
      notRun.push({ reviewer, reason: `${state.reviewers[reviewer]!.status || "no result"} after the allowed retry (retry-state)` });
      continue;
    }
    const saved = state;
    try {
      let evaluation: Awaited<ReturnType<typeof evaluateRetry>> | undefined;
      // The late-result collector credits every driver-named reply to the first one evaluated, so a later reply of the same
      // batch would read as "nothing new" and spend a stall it did not earn: once the batch has moved coverage, stalls restart.
      const coveredAtStart = new Set(isCurrent() ? state.reviewers[reviewer]?.covered ?? [] : []);
      const grown = (): boolean => (state.reviewers[reviewer]?.covered ?? []).some((id) => !coveredAtStart.has(id));
      const withStalls = (value: number): RetryState => {
        const entry = state.reviewers[reviewer];
        return entry === undefined ? state : { ...state, reviewers: { ...state.reviewers, [reviewer]: { ...entry, stalls: value } } };
      };
      for (const reply of usable) {
        if (grown()) state = withStalls(0);
        evaluation = await evaluateRetry({ manifestSource, manifest, state, statePath, result: reply.result as ReviewerResult, reviewer, packageSource: packageDir, nextWave: false });
        state = withProcessed(evaluation.plan.state, reviewer, reply.hash);
      }
      if (usable.length > 1 && grown()) state = withStalls(0);
      if (evaluation === undefined) {
        evaluation = await evaluateRetry({ manifestSource, manifest, state, statePath, result: {}, reviewer, packageSource: packageDir, nextWave: true });
        state = withProcessed(evaluation.plan.state, reviewer, undefined);
      }
      const { plan } = evaluation;
      if (plan.decision === "not-run") { notRun.push({ reviewer, reason: plan.reason }); continue; }
      if (plan.wave.length === 0) {
        // A reviewer of the package that has no reply and no slice to be handed did no work: it is owed, not done.
        if (replies.length === 0 && requiredSlices(manifest, reviewer).length === 0) notRun.push({ reviewer, reason: "no reply recorded and no slice routed to it, so it never ran" });
        continue;
      }
      const reply = usable[usable.length - 1] ?? replies[replies.length - 1];
      const status = reply === undefined ? "" : statusOf(reply);
      const owned = newlyOwned.get(reviewer)!;
      const reason: NextReason = reply === undefined ? "missing"
        : plan.newSlices.length > 0 ? "stalled"
        : plan.wave.some((entry) => owned.has(entry.id)) && FINISHED.has(status) ? "escalated"
        : FINISHED.has(status) && plan.decision === "wave" && refused.length === 0 ? "missing"
        : "retry";
      added.push(...plan.newSlices);
      const dispatch = describeDispatch({ reviewer, plan, reason, reply, sliceDir, driverFiles, manifest });
      if (refused.length > 0 && usable.length === 0) dispatch.detail = `${refused.map((entry) => entry.name).join(", ")} rejected (no "slices" list); ${dispatch.detail}`;
      dispatches.push(dispatch);
    } catch (error) {
      state = saved;
      blocked.push({ reviewer, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (input.apply === true) {
    if (added.length > 0) for (const piece of added) await writeFileAtomic(path.join(sliceDir, piece.path), piece.text);
    if (escalations.length > 0 || added.length > 0) {
      const slices = [...manifest.slices, ...added.map(({ text: _text, ...entry }) => entry)];
      await writeFileAtomic(manifestSource, `${JSON.stringify({ ...manifest, slices }, null, 2)}\n`);
    }
    await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    for (const dispatch of dispatches) if (dispatch.needsApply === true) delete dispatch.needsApply;
  }
  const planAuthorized = await planAuthorization(packageDir, manifest);
  return {
    done: dispatches.length === 0 && blocked.length === 0,
    package: packageDir,
    dispatches,
    notRun,
    blocked,
    escalated: escalations.map((entry) => ({ slice: entry.slice, finding: entry.finding, by: entry.by })),
    rejected,
    applied: input.apply === true,
    planAuthorized,
    continue: planAuthorized === true && dispatches.length > 0,
  };
}

async function planAuthorization(packageDir: string, manifest: SliceManifest): Promise<boolean | null> {
  try {
    return (await packagePlanGate(packageDir, { manifestValue: manifest })).refusal === undefined;
  } catch {
    return null;
  }
}

type DriverView = { reviewer: string; file: string; wave?: number; slices: string[]; result?: string; model?: string };

async function readDriverFiles(packageDir: string): Promise<DriverView[]> {
  const dir = path.join(packageDir, DRIVERS_DIR);
  if (!existsSync(dir)) return [];
  const out: DriverView[] = [];
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".json")).sort()) {
    let driver: DriverFile;
    try { driver = JSON.parse(await readFile(path.join(dir, name), "utf8")) as DriverFile; } catch { continue; }
    if (typeof driver.reviewer !== "string") continue;
    const slices = (Array.isArray(driver.slices) ? driver.slices : []).map((entry) => (typeof entry === "string" ? entry : (entry as { id?: unknown })?.id)).filter((id): id is string => typeof id === "string");
    out.push({
      reviewer: driver.reviewer,
      file: `${DRIVERS_DIR}/${name}`,
      ...(typeof driver.wave === "number" ? { wave: driver.wave } : {}),
      slices,
      ...(typeof driver.result === "string" ? { result: driver.result } : {}),
      ...(typeof driver.model === "string" && driver.model.trim() !== "" ? { model: driver.model.trim() } : {}),
    });
  }
  return out;
}

const driverSlices = (drivers: readonly DriverView[], reviewer: string): string[] => drivers.filter((driver) => driver.reviewer === reviewer).flatMap((driver) => driver.slices);

function describeDispatch(input: {
  reviewer: string;
  plan: Awaited<ReturnType<typeof evaluateRetry>>["plan"];
  reason: NextReason;
  reply: Reply | undefined;
  sliceDir: string;
  driverFiles: readonly DriverView[];
  manifest: SliceManifest;
}): NextDispatch {
  const { reviewer, plan, reason, reply, sliceDir, driverFiles } = input;
  const ids = plan.wave.map((entry) => entry.id);
  const mine = driverFiles.filter((driver) => driver.reviewer === reviewer);
  const matching = mine.find((driver) => ids.length > 0 && ids.every((id) => driver.slices.includes(id)));
  const wave = matching?.wave ?? mine.filter((driver) => driver.result !== undefined && existsSync(path.resolve(sliceDir, "..", driver.result))).length + 1;
  const model = [...mine].reverse().map((driver) => driver.model).find((value) => value !== undefined) ?? (typeof reply?.result.model === "string" && reply.result.model.trim() !== "" ? reply.result.model.trim() : undefined);
  return {
    reviewer,
    wave,
    wavesLeft: Math.max(plan.remaining.waves, 1),
    slices: ids,
    paths: plan.wave.map((entry) => path.resolve(sliceDir, entry.path)),
    bytes: plan.wave.reduce((total, entry) => total + entry.bytes, 0),
    reason,
    detail: plan.reason,
    ...(model === undefined ? {} : { model }),
    result: matching?.result ?? `${RAW_DIR}/${reviewer}-w${wave}.txt`,
    ...(matching === undefined ? {} : { driver: matching.file }),
    ...(plan.needsContext === undefined || plan.needsContext.length === 0 ? {} : { needsContext: plan.needsContext }),
    ...(plan.newSlices.length === 0 ? {} : { recut: plan.newSlices.length, needsApply: true }),
  };
}

/** The text a `review next` run prints. */
export const CONTINUE_LINE = "plan authorized; continue the loop without asking the operator; stop only for the card list, for plan growth, or on done / Not run";

export function renderNext(result: NextResult, relativeTo: string = process.cwd()): string {
  const rel = (file: string): string => path.relative(relativeTo, file) || file;
  const lines: string[] = [];
  if (result.dispatches.length === 0 && result.blocked.length === 0) {
    lines.push(`review next: done — nothing is left to dispatch. Run \`keryx review ledger build --package ${rel(result.package)}\`.`);
  } else {
    const reviewers = new Set(result.dispatches.map((entry) => entry.reviewer)).size;
    lines.push(`review next: ${result.dispatches.length} dispatch(es) for ${reviewers} reviewer(s); dispatch them in one batch, save each reply under its result path, then run \`keryx review next --package ${rel(result.package)}\` again.`);
  }
  if (result.continue) lines.push(CONTINUE_LINE);
  for (const entry of result.dispatches) {
    lines.push(`- ${entry.reviewer} wave ${entry.wave} (${entry.wavesLeft} left) [${entry.reason}] ${entry.slices.join(", ")} (${entry.bytes} bytes) model: ${entry.model ?? "model not recorded"}`);
    lines.push(`    result: ${entry.result}${entry.driver === undefined ? "" : `  driver: ${entry.driver}`}`);
    lines.push(`    ${entry.detail}`);
    for (const question of entry.needsContext ?? []) lines.push(`    context: ${question}`);
    if (entry.needsApply === true) lines.push(`    ${entry.recut} re-cut slice(s) are written by \`keryx review next --package ${rel(result.package)} --apply\``);
  }
  for (const item of result.escalated) lines.push(`- escalate ${item.slice}: finding ${item.finding} from ${item.by} on a light slice; it is re-opened deep and every core role now owns it`);
  for (const item of result.rejected) lines.push(`- rejected ${item.file} (${item.reviewer}): ${item.reason}`);
  for (const item of result.notRun) lines.push(`- **Not run:** ${item.reviewer} — ${item.reason}; never counted as a clean pass`);
  for (const item of result.blocked) lines.push(`- blocked ${item.reviewer}: ${item.message}`);
  if (!result.applied && result.dispatches.some((entry) => entry.needsApply === true)) lines.push("(--apply not given: the re-cut slices, the manifest and the retry state were not written)");
  return lines.join("\n");
}
