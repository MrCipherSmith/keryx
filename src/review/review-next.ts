import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type DriverFile } from "./driver-read";
import { evaluateRetry, withProcessed } from "./retry-eval";
import { writeFileAtomic } from "../lib/fs";
import { parseReviewResult, sha, type ParsedResult } from "./ledger";
import { type RetryState, type ReviewerResult, applyEscalations, emptyRetryState, escalationsFor, scopeFingerprint } from "./retry-plan";
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
  applied: boolean;
};

type Latest = { name: string; hash: string; body: string; mtimeMs: number; result: ParsedResult };

async function latestResults(packageDir: string, driverOf: ReadonlyMap<string, string>): Promise<Map<string, Latest>> {
  const latest = new Map<string, Latest>();
  const dir = path.join(packageDir, RAW_DIR);
  if (!existsSync(dir)) return latest;
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".txt")).sort()) {
    const file = path.join(dir, name);
    const body = await readFile(file, "utf8");
    const result = parseReviewResult(body);
    if (result === undefined) continue;
    const reviewer = typeof result.reviewer === "string" && result.reviewer !== "" ? result.reviewer : driverOf.get(name);
    if (reviewer === undefined) continue;
    const mtimeMs = (await stat(file)).mtimeMs;
    const known = latest.get(reviewer);
    if (known === undefined || mtimeMs >= known.mtimeMs) latest.set(reviewer, { name: `${RAW_DIR}/${name}`, hash: sha(body), body, mtimeMs, result: { ...result, reviewer } });
  }
  return latest;
}

const FINISHED = new Set(["DONE", "DONE_WITH_CONCERNS"]);

/** Everything still to dispatch for the package, every reviewer at once. Writes only with `apply`. */
export async function reviewNext(input: { packageDir: string; reviewers?: readonly string[] | undefined; apply?: boolean | undefined }): Promise<NextResult> {
  const packageDir = path.resolve(input.packageDir);
  const sliceDir = path.join(packageDir, "slices");
  const manifestSource = path.join(sliceDir, "manifest.json");
  if (!existsSync(manifestSource)) throw new Error(`${manifestSource} is missing: run \`keryx review slice --package ${packageDir}\` first.`);
  let manifest = JSON.parse(await readFile(manifestSource, "utf8")) as SliceManifest;
  const statePath = path.join(sliceDir, "retry-state.json");
  let state: RetryState = existsSync(statePath) ? (JSON.parse(await readFile(statePath, "utf8")) as RetryState) : emptyRetryState();
  const driverFiles = await readDriverFiles(packageDir);
  const driverOf = new Map<string, string>();
  for (const driver of driverFiles) if (driver.result !== undefined) driverOf.set(path.basename(driver.result), driver.reviewer);
  let fingerprint: string | undefined;
  try { fingerprint = scopeFingerprint(manifest, (entry) => readFileSync(path.resolve(sliceDir, entry.path), "utf8")); } catch { fingerprint = undefined; }
  const currentState = fingerprint !== undefined && state.scopeFingerprint === fingerprint;
  const reviewers = [...(input.reviewers ?? (await packageReviewers(packageDir, manifest)))].sort();
  const latest = await latestResults(packageDir, driverOf);

  // Escalations first: a major finding on a light slice re-opens it deep for every core role, whoever reported it.
  const before = new Map(reviewers.map((reviewer) => [reviewer, new Set(requiredSlices(manifest, reviewer))]));
  const found = reviewers.flatMap((reviewer) => {
    const reply = latest.get(reviewer);
    return reply === undefined ? [] : escalationsFor(manifest, reviewer, reply.result.findings, driverSlices(driverFiles, reviewer));
  });
  const escalations = [...new Map(found.map((entry) => [entry.slice, entry])).values()];
  if (escalations.length > 0) manifest = applyEscalations(manifest, escalations);
  const newlyOwned = new Map(reviewers.map((reviewer) => [reviewer, new Set(requiredSlices(manifest, reviewer).filter((id) => !before.get(reviewer)!.has(id)))]));

  const dispatches: NextDispatch[] = [];
  const notRun: NextResult["notRun"] = [];
  const blocked: NextResult["blocked"] = [];
  const added: Array<SliceEntry & { text: string }> = [];
  for (const reviewer of reviewers) {
    if (currentState && state.reviewers[reviewer]?.notRun === true) {
      notRun.push({ reviewer, reason: `${state.reviewers[reviewer]!.status || "no result"} after the allowed retry (retry-state)` });
      continue;
    }
    const reply = latest.get(reviewer);
    const counted = reply !== undefined && currentState && (state.reviewers[reviewer]?.processed ?? []).includes(reply.hash);
    const result: ReviewerResult = reply === undefined || counted ? {} : (reply.result as ReviewerResult);
    try {
      const evaluation = await evaluateRetry({ manifestSource, manifest, state, statePath, result, reviewer, packageSource: packageDir, nextWave: reply === undefined || counted });
      const { plan } = evaluation;
      state = withProcessed(plan.state, reviewer, reply !== undefined && !counted ? reply.hash : undefined);
      if (plan.decision === "not-run") { notRun.push({ reviewer, reason: plan.reason }); continue; }
      if (plan.wave.length === 0) {
        // A reviewer of the package that has no reply and no slice to be handed did no work: it is owed, not done.
        if (reply === undefined && requiredSlices(manifest, reviewer).length === 0) notRun.push({ reviewer, reason: "no reply recorded and no slice routed to it, so it never ran" });
        continue;
      }
      const status = String(reply?.result.status ?? "").toUpperCase();
      const owned = newlyOwned.get(reviewer)!;
      const reason: NextReason = reply === undefined ? "missing"
        : plan.newSlices.length > 0 ? "stalled"
        : plan.wave.some((entry) => owned.has(entry.id)) && FINISHED.has(status) ? "escalated"
        : FINISHED.has(status) && plan.decision === "wave" ? "missing"
        : "retry";
      added.push(...plan.newSlices);
      dispatches.push(describeDispatch({ reviewer, plan, reason, reply, sliceDir, driverFiles, manifest }));
    } catch (error) {
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
  return {
    done: dispatches.length === 0 && blocked.length === 0,
    package: packageDir,
    dispatches,
    notRun,
    blocked,
    escalated: escalations.map((entry) => ({ slice: entry.slice, finding: entry.finding, by: entry.by })),
    applied: input.apply === true,
  };
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
  reply: Latest | undefined;
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
export function renderNext(result: NextResult, relativeTo: string = process.cwd()): string {
  const rel = (file: string): string => path.relative(relativeTo, file) || file;
  const lines: string[] = [];
  if (result.dispatches.length === 0 && result.blocked.length === 0) {
    lines.push(`review next: done — nothing is left to dispatch. Run \`keryx review ledger build --package ${rel(result.package)}\`.`);
  } else {
    const reviewers = new Set(result.dispatches.map((entry) => entry.reviewer)).size;
    lines.push(`review next: ${result.dispatches.length} dispatch(es) for ${reviewers} reviewer(s); dispatch them in one batch, save each reply under its result path, then run \`keryx review next --package ${rel(result.package)}\` again.`);
  }
  for (const entry of result.dispatches) {
    lines.push(`- ${entry.reviewer} wave ${entry.wave} (${entry.wavesLeft} left) [${entry.reason}] ${entry.slices.join(", ")} (${entry.bytes} bytes) model: ${entry.model ?? "model not recorded"}`);
    lines.push(`    result: ${entry.result}${entry.driver === undefined ? "" : `  driver: ${entry.driver}`}`);
    lines.push(`    ${entry.detail}`);
    for (const question of entry.needsContext ?? []) lines.push(`    context: ${question}`);
    if (entry.needsApply === true) lines.push(`    ${entry.recut} re-cut slice(s) are written by \`keryx review next --package ${rel(result.package)} --apply\``);
  }
  for (const item of result.escalated) lines.push(`- escalate ${item.slice}: finding ${item.finding} from ${item.by} on a light slice; it is re-opened deep and every core role now owns it`);
  for (const item of result.notRun) lines.push(`- **Not run:** ${item.reviewer} — ${item.reason}; never counted as a clean pass`);
  for (const item of result.blocked) lines.push(`- blocked ${item.reviewer}: ${item.message}`);
  if (!result.applied && result.dispatches.some((entry) => entry.needsApply === true)) lines.push("(read-only: nothing was written)");
  return lines.join("\n");
}
