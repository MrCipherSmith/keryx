import { constants, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJsonObjectFile } from "../lib/json";
import { pathExists } from "../lib/fs";
import { projectRootOfPackage } from "./coverage";
import { readPlanConfirmation } from "./estimate";
import { TOOL_LOG_DIR } from "./layers-usage";
import type { NextResult } from "./review-next";
import { RAW_DIR } from "./wave-drivers";

// The wave journal: `keryx review next` appends one line per call to `<package>/tool-calls/wave-events.jsonl`, and one more
// `idle` line when the package sat longer than a threshold with open slices under an authorized plan. It is evidence for
// the round summary and never an input to what `next` decides. Nothing else reads or needs it.

export const WAVE_EVENTS_FILE = "wave-events.jsonl";
/** A row never exceeds this; the only free-length field is the package path, which is cut to its last segment. */
export const MAX_EVENT_BYTES = 1024;
export const DEFAULT_IDLE_AFTER_WAVE_MINUTES = 10;
export const DEFAULT_IDLE_WAVE_REPLY_MINUTES = 15;

export type NextEvent = {
  time: string;
  event: "next";
  package: string;
  planAuthorized: boolean | null;
  dispatches: number;
  wave: number;
  wavesLeft: number;
  reasons: { missing: number; retry: number; stalled: number; escalated: number };
  notRun: number;
  blocked: number;
  done: boolean;
  sincePrevMs: number | null;
  sinceConfirmMs: number | null;
};

export type IdleEvent = { time: string; event: "idle"; kind: "A" | "B"; gapMs: number; since: string };
export type WaveEvent = NextEvent | IdleEvent;

export type IdleThresholds = { afterWaveMinutes: number; waveReplyMinutes: number };

export function waveEventsPath(packageDir: string): string {
  return path.join(packageDir, TOOL_LOG_DIR, WAVE_EVENTS_FILE);
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** `reviewWaves.idleAfterWaveMinutes` / `idleWaveReplyMinutes` in the project's `routing.config.json`; anything else keeps the default. */
export async function readIdleThresholds(projectRoot: string): Promise<IdleThresholds> {
  const defaults: IdleThresholds = { afterWaveMinutes: DEFAULT_IDLE_AFTER_WAVE_MINUTES, waveReplyMinutes: DEFAULT_IDLE_WAVE_REPLY_MINUTES };
  const file = path.join(projectRoot, "routing.config.json");
  if (!(await pathExists(file))) return defaults;
  const read = await readJsonObjectFile(file);
  if (read.state !== "object") return defaults;
  const own = read.value.reviewWaves;
  if (own === null || typeof own !== "object" || Array.isArray(own)) return defaults;
  const fields = own as Record<string, unknown>;
  return {
    afterWaveMinutes: positive(fields.idleAfterWaveMinutes) ? fields.idleAfterWaveMinutes : defaults.afterWaveMinutes,
    waveReplyMinutes: positive(fields.idleWaveReplyMinutes) ? fields.idleWaveReplyMinutes : defaults.waveReplyMinutes,
  };
}

/** The events on file, oldest first. A line that is not a known event is skipped; no file is no events. */
export async function readWaveEvents(packageDir: string): Promise<WaveEvent[]> {
  let text: string;
  try {
    text = await readFile(waveEventsPath(packageDir), "utf8");
  } catch {
    return [];
  }
  const events: WaveEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.time !== "string" || Number.isNaN(Date.parse(value.time))) continue;
      if (value.event === "next") events.push(value as unknown as NextEvent);
      else if (value.event === "idle" && (value.kind === "A" || value.kind === "B") && typeof value.gapMs === "number" && typeof value.since === "string") events.push(value as unknown as IdleEvent);
    } catch {
      continue;
    }
  }
  return events;
}

/** How many idle gaps the journal holds and the longest, in whole minutes. Undefined when there is none. */
export async function readWaveGaps(packageDir: string): Promise<{ count: number; maxMinutes: number } | undefined> {
  const idle = (await readWaveEvents(packageDir)).filter((event): event is IdleEvent => event.event === "idle");
  if (idle.length === 0) return undefined;
  return { count: idle.length, maxMinutes: Math.round(Math.max(...idle.map((event) => event.gapMs)) / 60000) };
}

const msBetween = (later: number, earlier: number): number => Math.max(0, Math.round(later - earlier));

export function buildNextEvent(result: NextResult, context: { now: Date; previous?: NextEvent | undefined; confirmedAt?: string | undefined }): NextEvent {
  const count = (reason: string): number => result.dispatches.filter((entry) => entry.reason === reason).length;
  const previousTime = context.previous === undefined ? undefined : Date.parse(context.previous.time);
  const confirmedTime = context.confirmedAt === undefined ? undefined : Date.parse(context.confirmedAt);
  const event: NextEvent = {
    time: context.now.toISOString(),
    event: "next",
    package: result.package,
    planAuthorized: result.planAuthorized,
    dispatches: result.dispatches.length,
    wave: Math.max(0, ...result.dispatches.map((entry) => entry.wave)),
    wavesLeft: Math.max(0, ...result.dispatches.map((entry) => entry.wavesLeft)),
    reasons: { missing: count("missing"), retry: count("retry"), stalled: count("stalled"), escalated: count("escalated") },
    notRun: result.notRun.length,
    blocked: result.blocked.length,
    done: result.done,
    sincePrevMs: previousTime === undefined || Number.isNaN(previousTime) ? null : msBetween(context.now.getTime(), previousTime),
    sinceConfirmMs: confirmedTime === undefined || Number.isNaN(confirmedTime) ? null : msBetween(context.now.getTime(), confirmedTime),
  };
  return Buffer.byteLength(JSON.stringify(event)) <= MAX_EVENT_BYTES ? event : { ...event, package: path.basename(result.package) };
}

async function rawMtimes(packageDir: string): Promise<number[]> {
  const dir = path.join(packageDir, RAW_DIR);
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".txt")) continue;
    try { out.push((await stat(path.join(dir, name))).mtimeMs); } catch { continue; }
  }
  return out.sort((a, b) => a - b);
}

/**
 * A: the newest reply landed this long before now and nothing was launched since. B: the first reply after the previous
 * `next` took this long to arrive (it includes the reviewers' own work). Both are only gaps with open slices and an
 * authorized plan; why it waited is not claimed, because a wait for an operator card looks the same.
 */
export async function findIdleGaps(input: { packageDir: string; now: Date; previous?: NextEvent | undefined; thresholds: IdleThresholds }): Promise<IdleEvent[]> {
  const mtimes = await rawMtimes(input.packageDir);
  const now = input.now.getTime();
  const out: IdleEvent[] = [];
  const newest = mtimes[mtimes.length - 1];
  if (newest !== undefined && now - newest > input.thresholds.afterWaveMinutes * 60000) {
    out.push({ time: input.now.toISOString(), event: "idle", kind: "A", gapMs: msBetween(now, newest), since: new Date(newest).toISOString() });
  }
  const previousTime = input.previous === undefined ? undefined : Date.parse(input.previous.time);
  if (previousTime !== undefined && !Number.isNaN(previousTime)) {
    const first = mtimes.find((mtime) => mtime > previousTime);
    if (first !== undefined && first - previousTime > input.thresholds.waveReplyMinutes * 60000) {
      out.push({ time: input.now.toISOString(), event: "idle", kind: "B", gapMs: msBetween(first, previousTime), since: input.previous!.time });
    }
  }
  return out;
}

export const idleLine = (event: IdleEvent): string => `gap ${Math.round(event.gapMs / 60000)} min without a launch after the plan was authorized (${event.kind}); a wait for an operator card looks the same`;

const warned = new Set<string>();
const stderrWarn = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function appendLines(file: string, lines: readonly string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
  try {
    await handle.write(lines.map((line) => `${line}\n`).join(""));
  } finally {
    await handle.close();
  }
}

export type WaveRecord = { event?: NextEvent; idle: IdleEvent[]; written: boolean };

/**
 * Appends the `next` event for a finished call, and the idle events it found, in one `O_APPEND` write. Never throws and
 * never changes what `next` printed or decided: a failure prints one warning line and returns `written: false`.
 */
export async function recordWaveEvents(result: NextResult, options: { now?: Date; warn?: (line: string) => void; thresholds?: IdleThresholds } = {}): Promise<WaveRecord> {
  const file = waveEventsPath(result.package);
  try {
    const now = options.now ?? new Date();
    const previous = [...(await readWaveEvents(result.package))].reverse().find((event): event is NextEvent => event.event === "next");
    const event = buildNextEvent(result, { now, previous, confirmedAt: readPlanConfirmation(result.package)?.at });
    const open = result.dispatches.length > 0 && result.planAuthorized === true;
    const thresholds = options.thresholds ?? (await readIdleThresholds(projectRootOfPackage(result.package)));
    const idle = open ? await findIdleGaps({ packageDir: result.package, now, previous, thresholds }) : [];
    await appendLines(file, [JSON.stringify(event), ...idle.map((entry) => JSON.stringify(entry))]);
    return { event, idle, written: true };
  } catch (cause) {
    if (!warned.has(file)) {
      warned.add(file);
      (options.warn ?? stderrWarn)(`wave journal not written (${file}): ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return { idle: [], written: false };
  }
}
