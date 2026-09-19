import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { debugEvent, isDebugEnabled, startDebugRun, stopDebugRun, summarizeInputChunk } from "./debug-log";

const dirs: string[] = [];
afterEach(() => {
  stopDebugRun();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("no run → debugEvent is a no-op", () => {
  expect(isDebugEnabled()).toBe(false);
  debugEvent("anything", { x: 1 }); // must not throw
});

test("a run writes owner-only NDJSON and points latest.txt at itself", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "keryx-debug-"));
  dirs.push(configDir);
  const run = startDebugRun({ configDir, now: new Date("2026-09-19T12:00:00.000Z") });
  debugEvent("one", { a: 1 });
  debugEvent("two");
  const lines = readFileSync(run.shellLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(lines.map((l) => l.kind)).toEqual(["one", "two"]);
  expect(lines[0]).toMatchObject({ seq: 1, pid: process.pid, a: 1 });
  expect(readFileSync(path.join(configDir, "debug", "latest.txt"), "utf8").trim()).toBe(run.dir);
  if (process.platform !== "win32") {
    expect(statSync(run.shellLog).mode & 0o777).toBe(0o600);
  }
});

test("input summaries count printable text and keep only control sequences", () => {
  const summary = summarizeInputChunk(Buffer.from("пароль\x1b[I\r"));
  expect(summary).toMatchObject({ printable: 6, control: 2 });
  expect(summary.sequences).toEqual([Buffer.from("\x1b[I").toString("hex"), "0d"]);
});
