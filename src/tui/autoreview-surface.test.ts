// Flow 424 (AC10): the autonomous review's TUI surface — what the sidebar shows, and /autoreview.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  autoReviewListText,
  createAutoReviewController,
  parseAutoReviewArgs,
  projectAutoReviewPanel,
  readAutoReviewRuns,
  routeAutoReviewCommand,
  type AutoReviewRun,
  type AutoReviewStartSpec,
} from "./autoreview-surface";

const REF = "https://github.com/o/r/pull/7435";
const NOW = new Date("2026-10-11T12:00:00.000Z");
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "autoreview-surface-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function runDir(slug = "o-r-pr7435"): string {
  const dir = path.join(cwd, ".metaproject", "data", "review-autonomous", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function progress(dir: string, extra: object = {}): void {
  writeFileSync(
    path.join(dir, "progress.json"),
    JSON.stringify({
      state: "running",
      ref: REF,
      phase: "review ingest",
      rounds: 2,
      tokens: 12_345,
      startedAt: "2026-10-11T11:00:00.000Z",
      pid: process.pid,
      updatedAt: "2026-10-11T11:30:00.000Z",
      lastAnswer: { question: "Continue with the next round?", answer: "yes, continue", basis: "safe default" },
      ...extra,
    }),
  );
}

const lock = (dir: string, pid: number): void => writeFileSync(path.join(dir, "lock.json"), JSON.stringify({ pid, startedAt: "2026-10-11T11:00:00.000Z" }));

function run(extra: Partial<AutoReviewRun> = {}): AutoReviewRun {
  return {
    slug: "o-r-pr7435",
    ref: REF,
    label: "o/r#7435",
    state: "running",
    live: true,
    pid: 4242,
    phase: "review ingest",
    rounds: 2,
    tokens: 12_345,
    startedAt: "2026-10-11T11:00:00.000Z",
    updatedAt: "2026-10-11T11:30:00.000Z",
    lastAnswer: { question: "q", answer: "yes, continue", basis: "safe default" },
    reason: undefined,
    ...extra,
  };
}

describe("parseAutoReviewArgs", () => {
  test("no subcommand and `list` list", () => {
    expect(parseAutoReviewArgs("/autoreview")).toEqual({ kind: "list" });
    expect(parseAutoReviewArgs("/autoreview list")).toEqual({ kind: "list" });
  });

  test("start takes a pull request URL and budgets", () => {
    expect(parseAutoReviewArgs(`/autoreview start ${REF}`)).toEqual({ kind: "start", ref: REF });
    expect(parseAutoReviewArgs(`/autoreview start ${REF} --budget-minutes 90 --budget-tokens 400000`)).toEqual({
      kind: "start",
      ref: REF,
      budgetMinutes: 90,
      budgetTokens: 400000,
    });
  });

  test("start refuses a missing or bad URL, a bad budget and an unknown option", () => {
    for (const line of [
      "/autoreview start",
      "/autoreview start https://example.com/x",
      `/autoreview start ${REF} --budget-minutes soon`,
      `/autoreview start ${REF} --budget-tokens 1.5`,
      `/autoreview start ${REF} --wat`,
      `/autoreview start ${REF} extra`,
      "/autoreview frobnicate",
    ]) {
      expect(parseAutoReviewArgs(line).kind).toBe("error");
    }
  });

  test("stop takes an optional selector", () => {
    expect(parseAutoReviewArgs("/autoreview stop")).toEqual({ kind: "stop" });
    expect(parseAutoReviewArgs("/autoreview stop 7435")).toEqual({ kind: "stop", selector: "7435" });
  });
});

describe("readAutoReviewRuns", () => {
  test("nothing on disk is no runs", () => {
    expect(readAutoReviewRuns(cwd)).toEqual([]);
  });

  test("a live lock makes a running review; its progress is read", () => {
    const dir = runDir();
    progress(dir);
    lock(dir, process.pid);
    const [found] = readAutoReviewRuns(cwd);
    expect(found).toMatchObject({ label: "o/r#7435", state: "running", live: true, pid: process.pid, phase: "review ingest", rounds: 2, tokens: 12_345 });
    expect(found!.lastAnswer?.answer).toBe("yes, continue");
  });

  test("a run that says running but whose process is gone is died, not running", () => {
    const dir = runDir();
    progress(dir);
    lock(dir, 2 ** 22 + 12345);
    expect(readAutoReviewRuns(cwd)[0]).toMatchObject({ state: "died", live: false, pid: undefined });
  });

  test("a finished run keeps its verdict; a lock-only directory is a starting run", () => {
    progress(runDir(), { state: "budget", reason: "token budget 1000 reached" });
    const starting = runDir("a-b-pr1");
    lock(starting, process.pid);
    const runs = readAutoReviewRuns(cwd);
    expect(runs.map((r) => [r.slug, r.state, r.live])).toEqual([
      ["a-b-pr1", "running", true],
      ["o-r-pr7435", "budget", false],
    ]);
    expect(runs[0]!.phase).toBe("starting");
  });
});

describe("projectAutoReviewPanel", () => {
  test("nothing to show is hidden", () => {
    expect(projectAutoReviewPanel([], { width: 30, now: NOW })).toEqual({ visible: false, rows: [] });
  });

  test("a running review shows phase, rounds, tokens and the last automatic answer, each within the width", () => {
    const projection = projectAutoReviewPanel([run()], { width: 30, now: NOW });
    expect(projection.visible).toBe(true);
    const text = projection.rows.map((row) => row.chunks.map((c) => c.text).join(""));
    expect(text).toEqual(["o/r#7435 review ingest", "  round 2 · 12.3k tok", "  auto: yes, continue"]);
    for (const line of text) expect(line.length).toBeLessThanOrEqual(30);
  });

  test("long text is cut to the width", () => {
    const projection = projectAutoReviewPanel([run({ phase: "a very long phase name that cannot fit", lastAnswer: { question: "q", answer: "x".repeat(80), basis: "b" } })], { width: 30, now: NOW });
    for (const row of projection.rows) expect(row.chunks.map((c) => c.text).join("").length).toBeLessThanOrEqual(30);
  });

  test("a finished run shows for a day, then goes", () => {
    const done = run({ live: false, pid: undefined, state: "complete", updatedAt: "2026-10-11T11:30:00.000Z" });
    expect(projectAutoReviewPanel([done], { width: 30, now: NOW }).rows[0]!.chunks[0]).toMatchObject({ role: "ok", text: "o/r#7435 complete" });
    expect(projectAutoReviewPanel([done], { width: 30, now: new Date("2026-10-13T12:00:00.000Z") }).visible).toBe(false);
  });

  test("running reviews hide the finished ones", () => {
    const projection = projectAutoReviewPanel([run(), run({ slug: "x", live: false, state: "complete", label: "x/y#1" })], { width: 30, now: NOW });
    expect(JSON.stringify(projection)).not.toContain("x/y#1");
  });
});

describe("/autoreview", () => {
  function harness(runs: AutoReviewRun[] = []) {
    const said: string[] = [];
    const started: AutoReviewStartSpec[] = [];
    const stopped: number[] = [];
    const controller = createAutoReviewController({
      cwd,
      notice: (text) => said.push(text),
      read: () => runs,
      start: (spec) => {
        started.push(spec);
        return 9001;
      },
      stop: (pid) => void stopped.push(pid),
    });
    return { controller, said, started, stopped };
  }

  test("another command is not handled", () => {
    expect(harness().controller.handleCommand("/schedules")).toBe(false);
  });

  test("start runs the CLI command with the budgets and says the pid", () => {
    const h = harness();
    expect(h.controller.handleCommand(`/autoreview start ${REF} --budget-minutes 30`)).toBe(true);
    expect(h.started).toEqual([
      { cwd, args: ["review", "run", "--autonomous", "--target", "pr", "--ref", REF, "--budget-minutes", "30"] },
    ]);
    expect(h.said.join("")).toContain("started (pid 9001)");
  });

  test("a second start of the same pull request while one is running is refused", () => {
    const h = harness([run()]);
    h.controller.handleCommand(`/autoreview start ${REF}`);
    expect(h.started).toEqual([]);
    expect(h.said.join("")).toContain("already being reviewed (pid 4242)");
  });

  test("a bad start says why and starts nothing", () => {
    const h = harness();
    h.controller.handleCommand("/autoreview start nonsense");
    expect(h.started).toEqual([]);
    expect(h.said.join("")).toContain("/autoreview:");
  });

  test("stop signals the only running review, or the one named", () => {
    const only = harness([run()]);
    only.controller.handleCommand("/autoreview stop");
    expect(only.stopped).toEqual([4242]);
    expect(only.said.join("")).toContain("keeps the package");

    const two = harness([run(), run({ slug: "a-b-pr1", ref: "https://github.com/a/b/pull/1", label: "a/b#1", pid: 77 })]);
    two.controller.handleCommand("/autoreview stop");
    expect(two.stopped).toEqual([]);
    expect(two.said.join("")).toContain("say which one");
    two.controller.handleCommand("/autoreview stop 1");
    expect(two.stopped).toEqual([77]);
  });

  test("stop with nothing running says so", () => {
    const h = harness([run({ live: false, pid: undefined, state: "complete" })]);
    h.controller.handleCommand("/autoreview stop");
    expect(h.stopped).toEqual([]);
    expect(h.said.join("")).toContain("no autonomous review is running");
  });

  test("list prints every run with its state", () => {
    const h = harness([run(), run({ slug: "z", live: false, pid: undefined, state: "budget", label: "z/y#2", reason: "token budget 1000 reached" })]);
    h.controller.handleCommand("/autoreview");
    const out = h.said.join("");
    expect(out).toContain("o/r#7435");
    expect(out).toContain("pid 4242");
    expect(out).toContain("token budget 1000 reached");
    expect(autoReviewListText([])).toContain("No autonomous reviews yet");
  });
});

describe("routeAutoReviewCommand", () => {
  test("it is handled idle and busy, and only its own line", () => {
    const calls: string[] = [];
    const controller = { handleCommand: (line: string) => (calls.push(line), true) };
    expect(routeAutoReviewCommand("/autoreview list", false, controller)).toBe(true);
    expect(routeAutoReviewCommand("/autoreview list", true, controller)).toBe(true);
    expect(routeAutoReviewCommand("/schedules", false, controller)).toBe(false);
    expect(calls).toEqual(["/autoreview list", "/autoreview list"]);
  });
});
