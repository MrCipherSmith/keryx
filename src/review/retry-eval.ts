import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { hasStatus, parseReviewResult, unreadableInputClaim } from "./ledger";
import { splitUsage } from "./dispatch-usage";
import { type RetryState, type ReviewerResult, applyEscalations, emptyRetryState, needsContextQuestions, normalizeRetryState, planRetry, readSliceIds, scopeFingerprint } from "./retry-plan";
import type { SliceEntry, SliceManifest } from "./slice";

/**
 * Flow 458 AC12: the one place a reviewer's next step is decided. `keryx review retry-plan` and `keryx review next` both go
 * through {@link evaluateRetry}; they differ only in how many reviewers they ask about and what they print.
 */

export const RETRY_STATE_NAME = "retry-state.json";

export async function writeSliceFiles(dir: string, slices: ReadonlyArray<{ path: string; text: string }>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const slice of slices) {
    await writeFileAtomic(path.join(dir, slice.path), slice.text);
  }
}

export async function readJsonSource<T>(source: string, label: string): Promise<T> {
  let raw: string;
  try {
    raw = source === "-" ? await Bun.stdin.text() : await readFile(source, "utf8");
  } catch (error) {
    throw new UnreadableInput(`${label} is unreadable: ${source} (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    // A saved reviewer result may end with the host's KERYX_USAGE lines (flow 460 H): they are not part of the JSON.
    return JSON.parse(splitUsage(raw).body) as T;
  } catch {
    throw new UnreadableInput(`${label} is not valid JSON: ${source}`);
  }
}

export class UnreadableInput extends Error {}

/**
 * A file that is one JSON object with a status is the documented plain-JSON input; `--reviewer` may name a reviewer it
 * leaves out. The usage lines a host appends after it (KERYX_USAGE) are set aside first, as every reader of a raw result does.
 */
export function wholeFileResult(raw: string): ReviewerResult | undefined {
  try {
    const whole: unknown = JSON.parse(splitUsage(raw).body);
    return hasStatus(whole) ? whole as ReviewerResult : undefined;
  } catch { return undefined; }
}

/**
 * Finished results a reviewer left in the package after its caller stopped waiting: for each driver of `reviewer` that
 * names its result file, a raw file that parses as DONE or DONE_WITH_CONCERNS with no open needs_context (and no statement
 * that a mandatory input could not be read) covers the slices its `slices` list names among those the driver handed out;
 * a reply that names none covers none, as in the ledger. `collected` counts those files that add a slice not yet in `known`. Anything unreadable, malformed
 * or unfinished covers nothing.
 */
export async function collectLateResults(packageDir: string, reviewer: string, known: ReadonlySet<string>, fingerprint?: string): Promise<{ covered: string[]; collected: number }> {
  const covered = new Set<string>();
  const countedFiles = new Set<string>();
  let collected = 0;
  const driversDir = path.join(packageDir, "drivers");
  if (!existsSync(driversDir)) return { covered: [], collected: 0 };
  for (const name of (await readdir(driversDir)).filter((entry) => entry.endsWith(".json")).sort()) {
    let driver: { reviewer?: unknown; slices?: unknown; result?: unknown };
    try {
      driver = JSON.parse(await readFile(path.join(driversDir, name), "utf8"));
    } catch { continue; }
    if (driver === null || typeof driver !== "object" || driver.reviewer !== reviewer || typeof driver.result !== "string" || !Array.isArray(driver.slices)) continue;
    const file = path.join(packageDir, "raw", path.basename(driver.result));
    if (!existsSync(file)) continue;
    let raw: string;
    try { raw = await readFile(file, "utf8"); } catch { continue; }
    const result = wholeFileResult(raw) ?? parseReviewResult(raw);
    if (result === undefined) continue;
    const status = String(result.status ?? "").trim().toUpperCase();
    const open = needsContextQuestions(result.needs_context).length > 0;
    if (open || (status !== "DONE" && status !== "DONE_WITH_CONCERNS") || unreadableInputClaim(result) !== undefined) continue;
    if (result.reviewer !== undefined && result.reviewer !== reviewer) continue;
    const stamped = (result as { scopeFingerprint?: unknown }).scopeFingerprint;
    if (typeof stamped === "string" && stamped !== fingerprint) continue;
    const assigned = readSliceIds(driver.slices, "assigned");
    if (assigned.unusable > 0) continue;
    // Same rule as the ledger (flow 460 D): the reply's own slice list bounded by what was assigned; no list claims none.
    const allowed = new Set(assigned.ids);
    const claimed = readSliceIds(result.slices).ids.filter((id) => allowed.has(id));
    if (!countedFiles.has(file) && claimed.some((id) => !known.has(id) && !covered.has(id))) {
      collected += 1;
      countedFiles.add(file);
    }
    for (const id of claimed) covered.add(id);
  }
  return { covered: [...covered], collected };
}

/**
 * Flow 457 (T7, audit row 11): the review package a slice manifest belongs to — `<package>/slices/manifest.json` —
 * so retry-plan reads that package's raw/ and drivers/ without `--package`. Undefined for the shared slice directory.
 */
export function packageOfManifest(manifestDir: string): string | undefined {
  const candidate = path.dirname(manifestDir);
  return path.basename(manifestDir) === "slices" && existsSync(path.join(candidate, "manifest.json")) && existsSync(path.join(candidate, "raw"))
    ? candidate
    : undefined;
}

/** What `retry-plan` decided for one reviewer, before anything is written. */
export type RetryEvaluation = {
  plan: ReturnType<typeof planRetry>;
  late: { covered: string[]; collected: number };
  manifest: SliceManifest;
  manifestSource: string;
  manifestDir: string;
  statePath: string;
  packageSource: string | undefined;
};

/**
 * The one place a reviewer's next step is decided (`retry-plan` and `review next` both call it): reads the manifest, the retry
 * state and, with a package, the late results its drivers name, then runs `planRetry`. Nothing is written; see {@link commitRetryPlan}.
 */
export async function evaluateRetry(input: {
  manifestSource: string;
  manifest?: SliceManifest | undefined;
  state?: RetryState | undefined;
  statePath?: string | undefined;
  result: ReviewerResult;
  reviewer: string;
  sliceList?: string[] | undefined;
  coveredList?: string[] | undefined;
  packageSource?: string | undefined;
  nextWave: boolean;
}): Promise<RetryEvaluation> {
  const { manifestSource, reviewer } = input;
  const manifestDir = path.dirname(manifestSource);
  const manifest = input.manifest ?? await readJsonSource<SliceManifest>(manifestSource, "manifest");
  const statePath = input.statePath ?? path.join(manifestDir, RETRY_STATE_NAME);
  const state = input.state ?? (existsSync(statePath) ? normalizeRetryState(await readJsonSource<unknown>(statePath, "state")) : emptyRetryState());
  const packageSource = input.packageSource ?? packageOfManifest(manifestDir);
  if (packageSource !== undefined && (!existsSync(packageSource) || !statSync(packageSource).isDirectory())) {
    throw new Error(`--package ${packageSource} is not a directory.`);
  }
  const knownCovered = state.scopeFingerprint === undefined ? [] : state.reviewers[reviewer]?.covered ?? [];
  const readSliceText = (entry: SliceEntry): string => {
    const file = path.resolve(manifestDir, entry.path);
    if (!existsSync(file)) {
      throw new UnreadableInput(`slice file is missing: ${file}`);
    }
    return readFileSync(file, "utf8");
  };
  const late = packageSource === undefined ? { covered: [], collected: 0 } : await collectLateResults(packageSource, reviewer, new Set(knownCovered), scopeFingerprint(manifest, readSliceText));
  const coveredIds = [...(input.coveredList ?? []), ...late.covered];
  const plan = planRetry({
    manifest,
    result: input.result,
    reviewer,
    ...(input.sliceList === undefined ? {} : { sliceIds: input.sliceList }),
    ...(coveredIds.length === 0 ? {} : { covered: coveredIds }),
    ...(input.nextWave ? { nextWave: true } : {}),
    state,
    readSliceText,
  });
  return { plan, late, manifest, manifestSource, manifestDir, statePath, packageSource };
}

/** Writes what an evaluation decided: the re-cut slices, the escalated manifest and the retry state (with the result it processed). */
export async function commitRetryPlan(evaluation: RetryEvaluation, processedResult?: string): Promise<void> {
  const { plan, manifest, manifestSource, manifestDir, statePath } = evaluation;
  if (plan.newSlices.length > 0 || plan.escalations.length > 0) {
    await writeSliceFiles(manifestDir, plan.newSlices);
    const added = plan.newSlices.map(({ text: _text, ...entry }) => entry);
    const escalated = applyEscalations(manifest, plan.escalations);
    await writeFileAtomic(manifestSource, `${JSON.stringify({ ...escalated, slices: [...escalated.slices, ...added] }, null, 2)}\n`);
  }
  const state = withProcessed(plan.state, plan.reviewer, processedResult);
  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** The retry state with the hash of a result this reviewer's plan has now consumed; a result already in it is never counted twice. */
export function withProcessed(state: RetryState, reviewer: string, hash: string | undefined): RetryState {
  if (hash === undefined) return state;
  const known = state.reviewers[reviewer] ?? { attempt: 0, status: "", notRun: false };
  const processed = [...new Set([...(known.processed ?? []), hash])];
  return { ...state, reviewers: { ...state.reviewers, [reviewer]: { ...known, processed } } };
}

