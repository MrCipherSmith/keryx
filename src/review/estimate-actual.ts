import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJsonObjectFile } from "../lib/json";
import { PLAN_CONFIRMATION_FILE, readPlanConfirmation } from "./estimate";
import { RAW_DIR } from "./wave-drivers";

// The round's plan estimate set beside what the round took. The estimate is read as recorded (never recomputed) and the
// clock is the mtime of the raw reviewer replies, so a package older than the wave journal reads the same way.

export const ESTIMATE_LINE_LABEL = "Plan estimate vs actual:";
/** A gap between two neighbouring raw replies longer than this is counted as a pause. */
export const PAUSE_MINUTES = 10;
/** Replies that all landed within this window cannot be a round's work: the files were copied or restored together. */
const COPIED_WINDOW_SECONDS = 60;
const COPIED_MIN_REPLIES = 5;
const PLAN_FILE_NAME = "plan.json";

export type RecordedPlan = { min: number; max: number; dispatches: number | undefined; source: typeof PLAN_FILE_NAME | typeof PLAN_CONFIRMATION_FILE; mtimeMs: number | undefined };
export type ActualTime = { replies: number; calendarMinutes: number; pauseCount: number; pauseMinutes: number; activeMinutes: number };
export type EstimateVsActual = {
  plan?: RecordedPlan | undefined;
  replies: number;
  actual?: ActualTime | undefined;
  /** Why the raw file times cannot be this round's; set instead of `actual`. */
  unusable?: string | undefined;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

async function readPlan(packageDir: string): Promise<RecordedPlan | undefined> {
  const file = path.join(packageDir, PLAN_FILE_NAME);
  const read = await readJsonObjectFile(file).catch(() => undefined);
  if (read?.state === "object") {
    const minutes = read.value.minutes as { min?: unknown; max?: unknown } | null | undefined;
    if (minutes !== null && typeof minutes === "object" && finite(minutes.min) && finite(minutes.max)) {
      return { min: minutes.min, max: minutes.max, dispatches: finite(read.value.dispatches) ? read.value.dispatches : undefined, source: PLAN_FILE_NAME, mtimeMs: statSync(file).mtimeMs };
    }
  }
  const confirmation = readPlanConfirmation(packageDir);
  if (confirmation === undefined) return undefined;
  const confirmationFile = path.join(packageDir, PLAN_CONFIRMATION_FILE);
  return { min: confirmation.minutes[0], max: confirmation.minutes[1], dispatches: confirmation.dispatches, source: PLAN_CONFIRMATION_FILE, mtimeMs: existsSync(confirmationFile) ? statSync(confirmationFile).mtimeMs : undefined };
}

async function rawMtimes(packageDir: string): Promise<number[]> {
  const dir = path.join(packageDir, RAW_DIR);
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".txt")) continue;
    try {
      out.push((await stat(path.join(dir, name))).mtimeMs);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a - b);
}

/** The actual time of a set of reply times (ascending, at least two): first to last, with the pauses over the threshold taken out. */
export function actualOf(mtimes: readonly number[]): ActualTime {
  const first = mtimes[0] ?? 0;
  const last = mtimes[mtimes.length - 1] ?? first;
  let pausedMs = 0;
  let pauseCount = 0;
  for (let i = 1; i < mtimes.length; i += 1) {
    const gap = (mtimes[i] ?? 0) - (mtimes[i - 1] ?? 0);
    if (gap > PAUSE_MINUTES * 60000) {
      pausedMs += gap;
      pauseCount += 1;
    }
  }
  return {
    replies: mtimes.length,
    calendarMinutes: Math.round((last - first) / 60000),
    pauseCount,
    pauseMinutes: Math.round(pausedMs / 60000),
    activeMinutes: Math.round((last - first - pausedMs) / 60000),
  };
}

function unusableReason(mtimes: readonly number[], plan: RecordedPlan | undefined): string | undefined {
  const first = mtimes[0];
  const last = mtimes[mtimes.length - 1];
  if (first === undefined || last === undefined) return undefined;
  if (plan?.mtimeMs !== undefined && last < plan.mtimeMs - 1000) return `every raw reply is older than ${plan.source}, so the files were copied or restored`;
  if (mtimes.length >= COPIED_MIN_REPLIES && last - first < COPIED_WINDOW_SECONDS * 1000) return `${mtimes.length} raw replies all carry times within ${COPIED_WINDOW_SECONDS} s of each other, so the files were copied or restored`;
  return undefined;
}

/** The recorded plan and the time the raw replies show; undefined when the package holds neither. */
export async function readEstimateVsActual(packageDir: string): Promise<EstimateVsActual | undefined> {
  const plan = await readPlan(packageDir);
  const mtimes = await rawMtimes(packageDir);
  if (plan === undefined && mtimes.length === 0) return undefined;
  const unusable = unusableReason(mtimes, plan);
  return { plan, replies: mtimes.length, ...(mtimes.length >= 2 && unusable === undefined ? { actual: actualOf(mtimes) } : {}), ...(unusable === undefined ? {} : { unusable }) };
}

const planText = (plan: RecordedPlan | undefined): string =>
  plan === undefined ? "no recorded plan estimate" : `plan ${plan.min}-${plan.max} min${plan.dispatches === undefined ? "" : ` (${plan.dispatches} dispatches)`}`;

function actualText(view: EstimateVsActual, open: boolean): string {
  const now = open ? " so far" : "";
  if (view.unusable !== undefined) return `actual not shown: ${view.unusable} (${view.replies} raw replies)`;
  if (view.replies === 0) return open ? "no raw replies yet" : "no raw replies recorded";
  const actual = view.actual;
  if (actual === undefined) return `actual${now}: ${view.replies} raw reply, no span to measure`;
  const pauses = actual.pauseCount === 0
    ? `pauses over ${PAUSE_MINUTES} min: 0`
    : `pauses over ${PAUSE_MINUTES} min: ${actual.pauseCount} (${actual.pauseMinutes} min), ${actual.activeMinutes} min without them`;
  return `actual${now} ${actual.calendarMinutes} min from first to last raw reply (${actual.replies} replies); ${pauses}`;
}

/** The one line: plan range, actual time, pauses. `open` marks a round that is still running. */
export function estimateActualLine(view: EstimateVsActual, options: { open?: boolean } = {}): string {
  return `${ESTIMATE_LINE_LABEL} ${planText(view.plan)}; ${actualText(view, options.open === true)}`;
}

const LINE = /^Plan estimate vs actual:.*$/m;
const EVIDENCE_LINE = /^Evidence level:.*$/m;

/** Put the line into `report`, replacing the one already there; after the evidence level line when there is one, else at the end. */
export function upsertEstimateLine(report: string, line: string | undefined): string {
  if (line === undefined) return report;
  if (LINE.test(report)) return report.replace(LINE, () => line);
  if (EVIDENCE_LINE.test(report)) return report.replace(EVIDENCE_LINE, (found) => `${found}\n${line}`);
  return `${report.trimEnd()}\n\n${line}\n`;
}

/** The line for a package, or undefined when it holds no plan and no raw reply. */
export async function packageEstimateLine(packageDir: string, options: { open?: boolean } = {}): Promise<string | undefined> {
  const view = await readEstimateVsActual(packageDir).catch(() => undefined);
  return view === undefined ? undefined : estimateActualLine(view, options);
}
