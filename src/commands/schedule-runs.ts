// Recent runs of the project's schedules, with each run's report and log (Keryx Desktop Client
// M2, specification §4.2.1). One reader for `/schedules runs [<name>]` and
// `/schedules run-log <name> <run id>`, so the desktop's Runs view and the terminal shells show
// the same facts.
//
// Where the pieces live:
//   - the run records: `.metaproject/data/trigger/runs.jsonl` (via the trigger ledger view);
//   - a run's report: `.metaproject/data/trigger/reports/<name>/<runId>.md` (read by
//     `readScheduleReport`, which only reads a real file at that exact place);
//   - a run's log: only a run-now (desktop/shell "Run now", `keryx trigger run`) writes one,
//     `.metaproject/data/trigger/run-now/<name>-<start>.log`. A timer-fired run has a report
//     and a ledger record but no log, and the reader says so.
//
// Everything here is untrusted text: a report and a log are what a model wrote, `runs.jsonl`
// is trackable. Text is stripped of control and escape characters and the log is read bounded,
// from a regular file inside the run-now directory only.

import { constants as fsConstants, realpathSync } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { cardSafe } from "../lib/card-safe";
import { describeCost } from "../trigger/describe";
import { expectedReportRelPath, type TriggerRunRecord } from "../trigger/record";
import { latestReportPath } from "../trigger/schedules";
import { readScheduleReport } from "../trigger/store";
import { formatLocalDateTime } from "../tui/schedules-panel";
import { loadTriggerLedgerView, scheduledEntries, type TriggerEntryView } from "../tui/trigger-ledger";
import { runNowLogDir } from "../tui/trigger-run-now";

/** The most of a run's log a reader returns: its tail. */
export const RUN_LOG_TAIL_BYTES = 64 * 1024;
/** Runs one list answers, newest first. */
export const RUNS_LISTED = 30;
const OUTCOME_CHARS = 140;

export interface ScheduleRunSummary {
  readonly schedule: string;
  /** Stable id within the schedule: the agent run id, else the record's finish time. */
  readonly runId: string;
  readonly at: string;
  readonly atLabel: string;
  readonly outcome: string;
  readonly mode: string | undefined;
  readonly cost: string;
  /** One line of the record's detail, control characters removed. */
  readonly detail: string;
}

export type RunsRead = { readonly ok: true; readonly runs: readonly ScheduleRunSummary[] } | { readonly ok: false; readonly reason: string };

const lineOf = (text: string, max: number): string => {
  const one = cardSafe(text).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The id a record is addressed by in `run-log`. */
export function runIdOf(record: TriggerRunRecord): string {
  const id = record.agentTask?.runId ?? record.dispatch?.runId;
  return id !== undefined && id.length > 0 ? id : record.at;
}

function modeOf(item: TriggerEntryView, record: TriggerRunRecord): string | undefined {
  if (record.agentTask?.permissionMode !== undefined) return record.agentTask.permissionMode;
  const action = item.entry.action;
  return action.kind === "agent-task" ? action.dispatch.permissionMode : undefined;
}

function summarize(item: TriggerEntryView, record: TriggerRunRecord): ScheduleRunSummary {
  const refusal = record.agentTask?.refusal ?? record.dispatch?.refusal;
  return {
    schedule: item.entry.name,
    runId: runIdOf(record),
    at: record.at,
    atLabel: formatLocalDateTime(new Date(record.at)),
    outcome: refusal !== undefined ? `${record.outcome} (${refusal})` : record.outcome,
    mode: modeOf(item, record),
    cost: describeCost(record.cost),
    detail: lineOf(record.detail, OUTCOME_CHARS),
  };
}

const finished = (item: TriggerEntryView): TriggerRunRecord[] => item.records.filter((record) => record.outcome !== "reserved");

/** Recent runs of schedule `name`, or of every schedule when `name` is empty; newest first. */
export async function listScheduleRuns(cwd: string, name: string): Promise<RunsRead> {
  let items: readonly TriggerEntryView[];
  try {
    items = scheduledEntries(await loadTriggerLedgerView(cwd));
  } catch (error) {
    return { ok: false, reason: `could not read the schedules: ${error instanceof Error ? error.message : String(error)}` };
  }
  const chosen = name.length === 0 ? items : items.filter((item) => item.entry.name === name);
  if (name.length > 0 && chosen.length === 0) return { ok: false, reason: `No schedule named '${name}'.` };
  const runs = chosen
    .flatMap((item) => finished(item).map((record) => summarize(item, record)))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, RUNS_LISTED);
  return { ok: true, runs };
}

// ---------------------------------------------------------------------------
// One run: its report and its log
// ---------------------------------------------------------------------------

export interface RunSection {
  /** Plain text, control characters removed (newlines kept). */
  readonly text: string;
  readonly truncated: boolean;
  /** Why there is no text: the reason shown in its place. */
  readonly missing?: string;
}

export interface RunDetail {
  readonly summary: ScheduleRunSummary;
  readonly report: RunSection;
  readonly log: RunSection;
  /** The log file's name inside run-now/, when one was matched. */
  readonly logFile?: string;
}

export type RunDetailRead = { readonly ok: true; readonly detail: RunDetail } | { readonly ok: false; readonly reason: string };

/** Escape sequences, controls (a newline and a tab stay) and bidi overrides are removed. */
export function plainText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- matching control characters is the point: run output is untrusted
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex -- matching control characters is the point: run output is untrusted
      .replace(/\u001b[\]P^_][\s\S]*?(?:\u0007|\u001b\\)/g, "")
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- matching control characters is the point: run output is untrusted
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "")
  );
}

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/** `<name>-2026-11-18T09-35-14-170Z.log` -> the start time in ms, when the file is `name`'s. */
function logStartMs(file: string, name: string): number | undefined {
  if (!file.startsWith(`${name}-`) || !file.endsWith(".log")) return undefined;
  const m = STAMP.exec(file.slice(name.length + 1, -4));
  if (m === null) return undefined;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The newest log that started after the previous record and not after this one finished. */
async function matchLog(cwd: string, name: string, at: string, previousAt: string | undefined): Promise<string | undefined> {
  const end = Date.parse(at);
  if (Number.isNaN(end)) return undefined;
  const parsedFrom = previousAt === undefined ? Number.NaN : Date.parse(previousAt);
  const from = Number.isNaN(parsedFrom) ? Number.NEGATIVE_INFINITY : parsedFrom;
  let files: string[];
  try {
    files = await readdir(runNowLogDir(cwd));
  } catch {
    return undefined;
  }
  let best: { file: string; ms: number } | undefined;
  for (const file of files) {
    const ms = logStartMs(file, name);
    if (ms === undefined || ms > end + 1000 || ms <= from) continue;
    if (best === undefined || ms > best.ms) best = { file, ms };
  }
  return best?.file;
}

async function readLogTail(cwd: string, file: string): Promise<RunSection> {
  const dir = runNowLogDir(cwd);
  const abs = path.join(dir, file);
  const none = (missing: string): RunSection => ({ text: "", truncated: false, missing });
  try {
    if (realpathSync(dir) !== path.join(realpathSync(cwd), ".metaproject", "data", "trigger", "run-now")) {
      return none("the run-now directory is a link to somewhere else — not read");
    }
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return none("the log is not a regular file — not read");
    const nofollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const nonblock = (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
    const handle = await open(abs, fsConstants.O_RDONLY | nofollow | nonblock);
    try {
      const fst = await handle.stat();
      if (!fst.isFile()) return none("the log is not a regular file — not read");
      const length = Math.min(fst.size, RUN_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, fst.size - length);
      return { text: plainText(buffer.subarray(0, bytesRead).toString("utf8")), truncated: fst.size > RUN_LOG_TAIL_BYTES };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return none(`could not read the log (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function readReport(cwd: string, name: string, record: TriggerRunRecord, newest: boolean): Promise<RunSection> {
  const runId = record.agentTask?.runId;
  let rel = record.agentTask?.reportPath ?? (runId !== undefined ? expectedReportRelPath(name, runId) : undefined);
  // The newest run of a schedule without a recorded report path may still have written the newest file on disk.
  if (rel === undefined && newest) rel = latestReportPath(cwd, name);
  if (rel === undefined) return { text: "", truncated: false, missing: "this run wrote no report" };
  const read = await readScheduleReport(cwd, name, rel);
  if (!read.ok) return { text: "", truncated: false, missing: plainText(read.reason) };
  return { text: plainText(read.text), truncated: read.truncated };
}

/** The report and the log of one run of schedule `name`. `runId` is what `listScheduleRuns` answered. */
export async function readScheduleRun(cwd: string, name: string, runId: string): Promise<RunDetailRead> {
  let items: readonly TriggerEntryView[];
  try {
    items = scheduledEntries(await loadTriggerLedgerView(cwd));
  } catch (error) {
    return { ok: false, reason: `could not read the schedules: ${error instanceof Error ? error.message : String(error)}` };
  }
  const item = items.find((candidate) => candidate.entry.name === name);
  if (item === undefined) return { ok: false, reason: `No schedule named '${name}'.` };
  const records = finished(item);
  const index = records.findIndex((candidate) => runIdOf(candidate) === runId);
  const record = records[index];
  if (record === undefined) return { ok: false, reason: `No run '${runId}' of schedule ${name}. List its runs with /schedules runs ${name}.` };
  const report = await readReport(cwd, name, record, index === 0);
  const file = await matchLog(cwd, name, record.at, records[index + 1]?.at);
  const log: RunSection =
    file === undefined
      ? { text: "", truncated: false, missing: "no log for this run — only a Run now keeps one; a timer-fired run has its record and report" }
      : await readLogTail(cwd, file);
  return { ok: true, detail: { summary: summarize(item, record), report, log, ...(file !== undefined ? { logFile: file } : {}) } };
}

/** The plain-text form of the list, for the terminal shells. */
export function formatRunsText(runs: readonly ScheduleRunSummary[], name: string): string {
  if (runs.length === 0) return name.length > 0 ? `${name} has not run yet.\n` : "No schedule has run yet.\n";
  const lines = [name.length > 0 ? `Runs of ${name} (newest first)` : "Runs of every schedule (newest first)", ""];
  for (const run of runs) {
    lines.push(`${run.atLabel}  ${name.length > 0 ? "" : `${run.schedule}  `}${run.outcome}${run.mode !== undefined ? `  mode ${run.mode}` : ""}  [${run.cost}]  id ${run.runId}`);
    if (run.detail.length > 0) lines.push(`    ${run.detail}`);
  }
  lines.push("", "Open one: /schedules run-log <name> <id>");
  return `${lines.join("\n")}\n`;
}

/** The plain-text form of one run, for the terminal shells. */
export function formatRunDetailText(detail: RunDetail): string {
  const { summary } = detail;
  const section = (title: string, s: RunSection): string[] => [
    "",
    s.missing !== undefined ? `${title}: ${s.missing}` : `${title}${s.truncated ? " (truncated)" : ""}`,
    ...(s.missing === undefined ? [s.text.replace(/\n+$/, "")] : []),
  ];
  return `${[
    `${summary.schedule} · ${summary.atLabel} · ${summary.outcome}${summary.mode !== undefined ? ` · mode ${summary.mode}` : ""} · ${summary.cost}`,
    summary.detail,
    ...section("Report", detail.report),
    ...section(detail.logFile !== undefined ? `Run log (${detail.logFile})` : "Run log", detail.log),
  ].join("\n")}\n`;
}
