// `/schedules runs` and `/schedules run-log`: the run list, one run's report and log tail.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendTriggerRunRecord } from "../trigger/record";
import { RUN_LOG_TAIL_BYTES, listScheduleRuns, plainText, readScheduleRun } from "./schedule-runs";
import { scheduleRunLog, scheduleRuns } from "./shell-subcommands";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-schedule-runs-"));
  dirs.push(root);
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  writeFileSync(
    path.join(root, ".metaproject", "triggers.json"),
    JSON.stringify({ schemaVersion: 1, triggers: [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }] }),
  );
  return root;
}

const fire = { kind: "schedule", cron: "0 2 * * *" } as never;
const action = { kind: "rebuild" } as never;
const cost = { recorded: false, reason: "no model" } as never;

async function record(root: string, at: string, extra: Record<string, unknown> = {}): Promise<void> {
  const r = await appendTriggerRunRecord(root, { at, trigger: "nightly", firedBy: fire, action, outcome: "ok", detail: "rebuilt the index", cost, ...extra } as never);
  expect(r.status).toBe("appended");
}

function report(root: string, runId: string, text: string): void {
  const dir = path.join(root, ".metaproject", "data", "trigger", "reports", "nightly");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${runId}.md`), text);
}

function runLog(root: string, stamp: string, text: string): string {
  const dir = path.join(root, ".metaproject", "data", "trigger", "run-now");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `nightly-${stamp}.log`);
  writeFileSync(file, text);
  return file;
}

describe("listScheduleRuns", () => {
  test("lists runs newest first, one line each, for one schedule or all", async () => {
    const root = project();
    await record(root, "2026-11-18T02:00:05.000Z", { detail: "first\nline two\u001b[31m" });
    await record(root, "2026-11-19T02:00:05.000Z", { outcome: "failed", detail: "broke" });
    const one = await listScheduleRuns(root, "nightly");
    if (!one.ok) throw new Error(one.reason);
    expect(one.runs.map((run) => run.outcome)).toEqual(["failed", "ok"]);
    expect(one.runs[1]?.detail).toBe("first ⏎ line two");
    expect(one.runs[0]?.runId).toBe("2026-11-19T02:00:05.000Z");
    const all = await listScheduleRuns(root, "");
    expect(all.ok && all.runs.length).toBe(2);
    expect(await listScheduleRuns(root, "nosuch")).toEqual({ ok: false, reason: "No schedule named 'nosuch'." });
  });

  test("the text subcommand names the run id to open", async () => {
    const root = project();
    await record(root, "2026-11-18T02:00:05.000Z");
    const text = await scheduleRuns(root, "nightly");
    expect(text.ok).toBe(true);
    expect(text.text).toContain("id 2026-11-18T02:00:05.000Z");
    expect((await scheduleRuns(root, "nosuch")).ok).toBe(false);
    expect((await scheduleRuns(project(), "")).text).toContain("No schedule has run yet");
  });
});

describe("readScheduleRun", () => {
  test("returns the run's report and the log that started inside its window", async () => {
    const root = project();
    await record(root, "2026-11-18T02:00:05.000Z", { agentTask: { runId: "r1", reportPath: ".metaproject/data/trigger/reports/nightly/r1.md" } });
    await record(root, "2026-11-19T02:00:05.000Z", { agentTask: { runId: "r2", reportPath: ".metaproject/data/trigger/reports/nightly/r2.md" } });
    report(root, "r1", "old report");
    report(root, "r2", "# Done\nall green");
    runLog(root, "2026-11-18T02-00-00-000Z", "old log");
    runLog(root, "2026-11-19T02-00-00-000Z", "new log\n\u001b[31mred\u001b[0m");
    const read = await readScheduleRun(root, "nightly", "r2");
    if (!read.ok) throw new Error(read.reason);
    expect(read.detail.report).toEqual({ text: "# Done\nall green", truncated: false });
    expect(read.detail.log.text).toBe("new log\nred");
    expect(read.detail.logFile).toBe("nightly-2026-11-19T02-00-00-000Z.log");
    const older = await readScheduleRun(root, "nightly", "r1");
    expect(older.ok && older.detail.log.text).toBe("old log");
  });

  test("a long log is cut to its tail and says so", async () => {
    const root = project();
    await record(root, "2026-11-18T02:00:05.000Z");
    runLog(root, "2026-11-18T02-00-00-000Z", `${"a".repeat(RUN_LOG_TAIL_BYTES)}TAIL`);
    const read = await readScheduleRun(root, "nightly", "2026-11-18T02:00:05.000Z");
    if (!read.ok) throw new Error(read.reason);
    expect(read.detail.log.truncated).toBe(true);
    expect(read.detail.log.text.length).toBe(RUN_LOG_TAIL_BYTES);
    expect(read.detail.log.text.endsWith("TAIL")).toBe(true);
    const text = await scheduleRunLog(root, "nightly 2026-11-18T02:00:05.000Z");
    expect(text.text).toContain("Run log (nightly-2026-11-18T02-00-00-000Z.log) (truncated)");
  });

  test("a run with no log or report says why, and an unknown run is refused", async () => {
    const root = project();
    await record(root, "2026-11-18T02:00:05.000Z");
    const read = await readScheduleRun(root, "nightly", "2026-11-18T02:00:05.000Z");
    if (!read.ok) throw new Error(read.reason);
    expect(read.detail.log.missing).toContain("no log for this run");
    expect(read.detail.report.missing).toBe("this run wrote no report");
    const unknown = await readScheduleRun(root, "nightly", "nope");
    expect(unknown.ok).toBe(false);
    expect((await scheduleRunLog(root, "nightly nope")).ok).toBe(false);
    expect((await scheduleRunLog(root, "nightly")).text).toContain("Usage");
    expect((await readScheduleRun(root, "ghost", "x")).ok).toBe(false);
  });

  test("a log that is a symlink is not followed", async () => {
    const root = project();
    await record(root, "2026-11-18T02:00:05.000Z");
    const secret = path.join(root, "secret.txt");
    writeFileSync(secret, "do not read");
    const file = runLog(root, "2026-11-18T02-00-00-000Z", "x");
    rmSync(file);
    symlinkSync(secret, file);
    const read = await readScheduleRun(root, "nightly", "2026-11-18T02:00:05.000Z");
    if (!read.ok) throw new Error(read.reason);
    expect(read.detail.log.text).toBe("");
    expect(read.detail.log.missing).toContain("not a regular file");
  });
});

test("plainText drops escapes and controls but keeps newlines", () => {
  expect(plainText("a\u001b[1mb\u0007c\r\nd‮e")).toBe("abc\nde");
});
