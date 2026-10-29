// Flow 474 (review-engine-speedup R2): `keryx review next` appends its events to tool-calls/wave-events.jsonl.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { memoryCalls } from "./layers-usage";
import { readReviewParity } from "./parity";
import { reviewNext } from "./review-next";
import { buildNextEvent, findIdleGaps, idleLine, MAX_EVENT_BYTES, readIdleThresholds, readWaveEvents, readWaveGaps, recordWaveEvents, waveEventsPath, type IdleEvent, type NextEvent } from "./wave-events";

const ORIGINAL_CWD = process.cwd();
const realError = console.error;
const realLog = console.log;
let root = "";
let pkg = "";
let logs: string[] = [];
let errors: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-wave-events-"));
  pkg = path.join(root, ".metaproject", "reviews", "r1");
  await mkdir(path.join(pkg, "raw"), { recursive: true });
  process.chdir(root);
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  process.exitCode = 0;
  await writeFile(path.join(root, "change.diff"), `diff --git a/src/m/a.ts b/src/m/a.ts\n--- a/src/m/a.ts\n+++ b/src/m/a.ts\n@@ -1,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;\n`, "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "30000", "--package", pkg]);
  expect(process.exitCode).toBe(0);
  logs = [];
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  process.chdir(ORIGINAL_CWD);
  await rm(root, { recursive: true, force: true });
});

const lines = async (): Promise<string[]> => (await readFile(waveEventsPath(pkg), "utf8")).split("\n").filter((line) => line !== "");
const reply = (body: unknown) => `Done.\n\nREVIEW_RESULT: ${JSON.stringify(body)}\n`;
const MIN = 60_000;

/** The wave-event.schema.json of the requirements package, field by field. */
function schemaProblems(row: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const isDate = (value: unknown): boolean => typeof value === "string" && !Number.isNaN(Date.parse(value));
  const int = (value: unknown, nullable = false): boolean => (nullable && value === null) || (Number.isInteger(value) && (value as number) >= 0);
  const only = (keys: string[]): void => {
    for (const key of Object.keys(row)) if (!keys.includes(key)) problems.push(`extra ${key}`);
    for (const key of keys) if (!(key in row)) problems.push(`missing ${key}`);
  };
  if (row.event === "next") {
    only(["time", "event", "package", "planAuthorized", "dispatches", "wave", "wavesLeft", "reasons", "notRun", "blocked", "done", "sincePrevMs", "sinceConfirmMs"]);
    if (!isDate(row.time)) problems.push("time");
    if (typeof row.package !== "string") problems.push("package");
    if (row.planAuthorized !== null && typeof row.planAuthorized !== "boolean") problems.push("planAuthorized");
    for (const key of ["dispatches", "wave", "wavesLeft"]) if (!int(row[key])) problems.push(key);
    const reasons = row.reasons as Record<string, unknown>;
    if (Object.keys(reasons).sort().join() !== "escalated,missing,retry,stalled" || !Object.values(reasons).every((value) => int(value))) problems.push("reasons");
    for (const key of ["notRun", "blocked"]) if (!int(row[key]) && !Array.isArray(row[key])) problems.push(key);
    if (typeof row.done !== "boolean") problems.push("done");
    for (const key of ["sincePrevMs", "sinceConfirmMs"]) if (!int(row[key], true)) problems.push(key);
  } else if (row.event === "idle") {
    only(["time", "event", "kind", "gapMs", "since"]);
    if (!isDate(row.time) || !isDate(row.since)) problems.push("time/since");
    if (row.kind !== "A" && row.kind !== "B") problems.push("kind");
    if (!int(row.gapMs)) problems.push("gapMs");
  } else problems.push("event");
  return problems;
}

test("next event: each call appends exactly one schema-valid line, the second one knows the first", async () => {
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic,review-style"]);
  expect(await lines()).toHaveLength(1);
  const first = JSON.parse((await lines())[0]!) as NextEvent;
  expect(schemaProblems(first as unknown as Record<string, unknown>)).toEqual([]);
  expect(first).toMatchObject({ event: "next", package: pkg, planAuthorized: true, dispatches: 2, wave: 1, wavesLeft: 1, reasons: { missing: 2, retry: 0, stalled: 0, escalated: 0 }, notRun: 0, blocked: 0, done: false, sincePrevMs: null, sinceConfirmMs: null });

  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic,review-style"]);
  const rows = (await lines()).map((line) => JSON.parse(line) as NextEvent);
  expect(rows).toHaveLength(2);
  expect(schemaProblems(rows[1] as unknown as Record<string, unknown>)).toEqual([]);
  expect(typeof rows[1]!.sincePrevMs).toBe("number");
});

test("next event: wave and wavesLeft are the maxima over the dispatches, a finished package is done with zeros, and sinceConfirmMs counts from the confirmation", async () => {
  const result = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-style"] });
  const now = new Date("2026-10-25T12:00:00.000Z");
  const crowded = { ...result, dispatches: [{ ...result.dispatches[0]!, wave: 2, wavesLeft: 3, reason: "retry" as const }, { ...result.dispatches[1]!, wave: 4, wavesLeft: 1, reason: "stalled" as const }] };
  expect(buildNextEvent(crowded, { now, confirmedAt: "2026-10-25T11:50:00.000Z" })).toMatchObject({ dispatches: 2, wave: 4, wavesLeft: 3, reasons: { missing: 0, retry: 1, stalled: 1, escalated: 0 }, sinceConfirmMs: 10 * MIN });
  expect(buildNextEvent({ ...result, dispatches: [], done: true }, { now })).toMatchObject({ dispatches: 0, wave: 0, wavesLeft: 0, done: true });
});

test("idle gap: A and B are reported past their thresholds, only with open slices and an authorized plan", async () => {
  const now = new Date("2026-10-25T12:00:00.000Z");
  const reply1 = path.join(pkg, "raw", "review-logic-w1.txt");
  await writeFile(reply1, reply({ reviewer: "review-logic", status: "DONE", slices: [] }));
  const thresholds = { afterWaveMinutes: 10, waveReplyMinutes: 15 };
  const at = async (minutesAgo: number): Promise<void> => {
    const time = new Date(now.getTime() - minutesAgo * MIN);
    await utimes(reply1, time, time);
  };
  const previous = (minutesAgo: number): NextEvent => ({
    time: new Date(now.getTime() - minutesAgo * MIN).toISOString(), event: "next", package: pkg, planAuthorized: true, dispatches: 1, wave: 1, wavesLeft: 1,
    reasons: { missing: 1, retry: 0, stalled: 0, escalated: 0 }, notRun: 0, blocked: 0, done: false, sincePrevMs: null, sinceConfirmMs: null,
  });

  await at(9);
  expect(await findIdleGaps({ packageDir: pkg, now, thresholds })).toEqual([]);
  await at(58);
  const [gap] = await findIdleGaps({ packageDir: pkg, now, thresholds });
  expect(gap).toMatchObject({ event: "idle", kind: "A", gapMs: 58 * MIN, since: new Date(now.getTime() - 58 * MIN).toISOString() });
  expect(idleLine(gap!)).toBe("gap 58 min without a launch after the plan was authorized (A); a wait for an operator card looks the same");

  // B: the previous event was 90 min ago and the first reply after it landed 60 min ago, 30 min later.
  await at(60);
  const b = (await findIdleGaps({ packageDir: pkg, now, previous: previous(90), thresholds })).filter((event) => event.kind === "B");
  expect(b).toHaveLength(1);
  expect(b[0]).toMatchObject({ gapMs: 30 * MIN, since: new Date(now.getTime() - 90 * MIN).toISOString() });
  // A reply that came 10 min after the previous event is no gap B; one that predates it is not "after" it.
  await at(80);
  expect((await findIdleGaps({ packageDir: pkg, now, previous: previous(90), thresholds })).filter((event) => event.kind === "B")).toEqual([]);
  await at(95);
  expect((await findIdleGaps({ packageDir: pkg, now, previous: previous(90), thresholds })).filter((event) => event.kind === "B")).toEqual([]);

  // recordWaveEvents writes the idle event only while slices are open and the plan is authorized.
  await at(58);
  const open = await reviewNext({ packageDir: pkg, reviewers: ["review-style"] });
  expect(open.dispatches.length).toBeGreaterThan(0);
  const recorded = await recordWaveEvents(open, { now, thresholds });
  expect(recorded.idle.map((event) => event.kind)).toEqual(["A"]);
  expect((await lines()).map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(["next", "idle"]);
  await rm(waveEventsPath(pkg));
  expect((await recordWaveEvents({ ...open, planAuthorized: false }, { now, thresholds })).idle).toEqual([]);
  await rm(waveEventsPath(pkg));
  expect((await recordWaveEvents({ ...open, planAuthorized: null }, { now, thresholds })).idle).toEqual([]);
  await rm(waveEventsPath(pkg));
  expect((await recordWaveEvents({ ...open, dispatches: [], done: true }, { now, thresholds })).idle).toEqual([]);
});

test("idle gap: the command prints the warning and writes the idle event; thresholds come from routing.config.json", async () => {
  const file = path.join(pkg, "raw", "review-logic-w1.txt");
  await writeFile(file, reply({ reviewer: "review-logic", status: "DONE", slices: [] }));
  const old = new Date(Date.now() - 25 * MIN);
  await utimes(file, old, old);
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-style"]);
  expect(logs.join("\n")).toMatch(/gap 25 min without a launch after the plan was authorized \(A\)/);
  const rows = (await lines()).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.map((row) => row.event)).toEqual(["next", "idle"]);
  expect(schemaProblems(rows[1]!)).toEqual([]);

  await writeFile(path.join(root, "routing.config.json"), JSON.stringify({ reviewWaves: { idleAfterWaveMinutes: 40, idleWaveReplyMinutes: 0 } }), "utf8");
  expect(await readIdleThresholds(root)).toEqual({ afterWaveMinutes: 40, waveReplyMinutes: 15 });
  logs = [];
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-style"]);
  expect(logs.join("\n")).not.toContain("without a launch");
  expect(await readWaveGaps(pkg)).toEqual({ count: 1, maxMinutes: 25 });
});

test("write failure: one warning, the same output and exit code, and no event", async () => {
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic"]);
  const expected = logs.join("\n");
  await rm(path.join(pkg, "tool-calls"), { recursive: true, force: true });
  logs = [];
  // A file where the directory should be: mkdir fails.
  await writeFile(path.join(pkg, "tool-calls"), "in the way", "utf8");

  const warnings: string[] = [];
  const result = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(await recordWaveEvents(result, { warn: (line) => warnings.push(line) })).toMatchObject({ written: false, idle: [] });
  expect(await recordWaveEvents(result, { warn: (line) => warnings.push(line) })).toMatchObject({ written: false });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("wave journal not written");

  const stderr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic"]);
  } finally {
    process.stderr.write = realWrite;
  }
  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toBe(expected);
  expect(errors).toEqual([]);
  expect(stderr.join("")).not.toContain("wave journal not written");
});

test("write failure: reviewNext itself writes nothing without --apply", async () => {
  const before = await readdirTree(pkg);
  await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-style"] });
  expect(await readdirTree(pkg)).toEqual(before);
  expect(existsSync(waveEventsPath(pkg))).toBe(false);
});

async function readdirTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const { readdir } = await import("node:fs/promises");
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(`${path.relative(dir, full)}:${(await readFile(full)).length}`);
    }
  };
  await walk(dir);
  return out.sort();
}

test("event size: only counts, flags, names and times; a long package path is cut to its last segment so the row stays under the cap", async () => {
  const result = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  const longDir = `/${"deep/".repeat(400)}r1`;
  const event = buildNextEvent({ ...result, package: longDir }, { now: new Date() });
  expect(event.package).toBe("r1");
  expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  expect(schemaProblems(event as unknown as Record<string, unknown>)).toEqual([]);

  // A finding, a diff line and a comment in the replies never reach the row.
  await writeFile(path.join(pkg, "raw", "review-logic-w1.txt"), reply({ reviewer: "review-logic", status: "DONE", slices: [], findings: [{ id: "F-1", severity: "minor", file: "src/m/a.ts", problem: "SECRET-FINDING-TEXT" }] }));
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic"]);
  const text = (await lines()).join("\n");
  expect(text).not.toContain("SECRET-FINDING-TEXT");
  expect(text).not.toContain("export const");
  for (const line of await lines()) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
});

test("orchestrator log untouched: next leaves orchestrator.jsonl and memoryCalls as they were", async () => {
  const log = path.join(pkg, "tool-calls", "orchestrator.jsonl");
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic"]);
  expect(existsSync(log)).toBe(false);

  const entry = `${JSON.stringify({ time: "2026-10-25T10:00:00.000Z", source: "cli", caller: "orchestrator", command: "keryx memory search \"x\"" })}\n`;
  await writeFile(log, entry, "utf8");
  const before = memoryCalls(entry);
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic"]);
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic"]);
  expect(await readFile(log, "utf8")).toBe(entry);
  expect(memoryCalls(await readFile(log, "utf8"))).toEqual(before);
});

test("file optional: the journal decides nothing, deleting it breaks nothing, and the next call recreates it", async () => {
  const withoutFile = await reviewNext({ packageDir: pkg });
  await reviewCommand(["next", "--package", pkg]);
  await reviewCommand(["next", "--package", pkg]);
  expect(await lines()).toHaveLength(2);
  // Same decision with two events on file as with none.
  expect(await reviewNext({ packageDir: pkg })).toEqual(withoutFile);

  await rm(waveEventsPath(pkg));
  expect(await readWaveEvents(pkg)).toEqual([]);
  expect(await readReviewParity(pkg)).toMatchObject({ notRun: 0 });
  expect((await readReviewParity(pkg)).gaps).toBeUndefined();
  expect(await reviewNext({ packageDir: pkg })).toEqual(withoutFile);
  await reviewCommand(["next", "--package", pkg]);
  expect(await lines()).toHaveLength(1);

  // Lines that are not events are skipped, the rest still count.
  await writeFile(waveEventsPath(pkg), `not json\n${JSON.stringify({ time: "2026-10-25T10:00:00.000Z", event: "idle", kind: "A", gapMs: 11 * MIN, since: "2026-10-25T09:49:00.000Z" } satisfies IdleEvent)}\n{"event":"other"}\n`, "utf8");
  expect(await readWaveGaps(pkg)).toEqual({ count: 1, maxMinutes: 11 });
});
