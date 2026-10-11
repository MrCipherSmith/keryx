// `keryx review run --autonomous`: the command line, the exit code and the notes sent around a run.

import { describe, expect, test } from "bun:test";
import { endLine, createTelegramNotifier, startLine, type RunNotifier } from "./review-notify";
import { parseAutonomousTarget } from "../review/autonomous-profile";
import { AutonomousRunLockedError, type AutonomousRunOptions, type AutonomousRunResult } from "../review/autonomous-run";
import type { AutonomousSummary } from "../review/autonomous-summary";
import { parseRunArgs, runReviewRunCommand } from "./review-run";

const REF = "https://github.com/o/r/pull/7";
const BASE = ["--autonomous", "--target", "pr", "--ref", REF];

function summary(status: AutonomousSummary["status"], exitCode: number): AutonomousSummary {
  return {
    schemaVersion: 1,
    profile: "review-autonomous",
    target: { kind: "pr", ref: REF, repository: "o/r", number: 7, head: "abc" },
    status,
    exitCode,
    reason: "because",
    phase: "review ingest",
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:01:00.000Z",
    durationSeconds: 60,
    attempts: 1,
    rounds: 1,
    tokens: 99,
    package: null,
    findings: { blocker: 1, major: 2, minor: 3, info: 0 },
    floorRefusals: 0,
    autoAnswers: { count: 0 },
  };
}

function result(status: AutonomousSummary["status"], exitCode: number): AutonomousRunResult {
  return { exitCode, status, summary: summary(status, exitCode), runDir: "/tmp/run", reused: false };
}

function recordingNotifier(): RunNotifier & { lines: string[]; closed: boolean } {
  const lines: string[] = [];
  const notifier = {
    lines,
    closed: false,
    started: async (line: string) => void lines.push(`start: ${line}`),
    finished: async (line: string) => void lines.push(`end: ${line}`),
    close: async () => {
      notifier.closed = true;
    },
  };
  return notifier;
}

async function drive(args: string[], run: (o: AutonomousRunOptions) => Promise<AutonomousRunResult>, notifier = recordingNotifier()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReviewRunCommand(args, { cwd: "/tmp/p", run, notifier, log: (l) => out.push(l), error: (l) => err.push(l) });
  return { code, out, err, notifier };
}

describe("parseRunArgs", () => {
  test("reads every option", () => {
    const parsed = parseRunArgs([...BASE, "--budget-minutes", "90", "--budget-tokens=500000", "--out", "o", "--stall-minutes", "3", "--json"]);
    expect(parsed).toMatchObject({ ref: REF, budgetMinutes: 90, budgetTokens: 500000, out: "o", stallMinutes: 3, json: true, notify: true });
  });

  test("the stall limit defaults to ten minutes", () => {
    expect(parseRunArgs(BASE).stallMinutes).toBe(10);
  });

  test("--autonomous is required", () => {
    expect(() => parseRunArgs(["--target", "pr", "--ref", REF])).toThrow("--autonomous");
  });

  test("only a pr target and a pull request URL are accepted", () => {
    expect(() => parseRunArgs(["--autonomous", "--target", "branch", "--ref", REF])).toThrow("--target");
    expect(() => parseRunArgs(["--autonomous", "--target", "pr", "--ref", "123"])).toThrow("pull request URL");
    expect(() => parseRunArgs(["--autonomous", "--target", "pr"])).toThrow("--ref");
  });

  test("a bad budget is refused, not ignored", () => {
    expect(() => parseRunArgs([...BASE, "--budget-minutes", "soon"])).toThrow("--budget-minutes");
    expect(() => parseRunArgs([...BASE, "--budget-tokens", "1.5"])).toThrow("--budget-tokens");
    expect(() => parseRunArgs([...BASE, "--budget-minutes", "-1"])).toThrow("--budget-minutes");
    expect(() => parseRunArgs([...BASE, "--budget-minutes"])).toThrow("needs a value");
  });

  test("an unknown option is refused", () => {
    expect(() => parseRunArgs([...BASE, "--budgit-minutes", "5"])).toThrow("Unknown option");
  });
});

describe("exit codes", () => {
  const cases: Array<[AutonomousSummary["status"], number]> = [
    ["complete", 0],
    ["incomplete", 2],
    ["floor", 3],
    ["budget", 4],
    ["stalled", 5],
  ];
  for (const [status, code] of cases) {
    test(`${status} exits ${code}`, async () => {
      const driven = await drive(BASE, async () => result(status, code));
      expect(driven.code).toBe(code);
      expect(driven.out.join("\n")).toContain("because");
    });
  }

  test("bad arguments exit 1 with the reason and never start a run", async () => {
    let started = false;
    const driven = await drive(["--autonomous"], async () => {
      started = true;
      return result("complete", 0);
    });
    expect(driven.code).toBe(1);
    expect(started).toBe(false);
    expect(driven.err.join("\n")).toContain("--target");
  });

  test("a second run of the same pull request exits 1 and names the holder", async () => {
    const driven = await drive(BASE, async () => {
      throw new AutonomousRunLockedError(4242, "2026-10-11T10:00:00.000Z", "/tmp/run");
    });
    expect(driven.code).toBe(1);
    expect(driven.err.join("\n")).toContain("pid 4242");
  });

  test("the options reach the runner", async () => {
    let seen: AutonomousRunOptions | undefined;
    await drive([...BASE, "--budget-minutes", "30", "--budget-tokens", "1000", "--stall-minutes", "2"], async (o) => {
      seen = o;
      return result("complete", 0);
    });
    expect(seen).toMatchObject({ cwd: "/tmp/p", ref: REF, budgetMinutes: 30, budgetTokens: 1000, stallMs: 120_000 });
  });

  test("--json prints the summary", async () => {
    const driven = await drive([...BASE, "--json"], async () => result("budget", 4));
    expect(JSON.parse(driven.out.join("\n"))).toMatchObject({ status: "budget", exitCode: 4 });
  });
});

describe("notes to Telegram", () => {
  test("one line at the start and one at the end, then the client is closed", async () => {
    const driven = await drive(BASE, async () => result("budget", 4));
    expect(driven.notifier.lines).toHaveLength(2);
    expect(driven.notifier.lines[0]).toStartWith("start: ");
    expect(driven.notifier.lines[1]).toContain("budget");
    expect(driven.notifier.lines[1]).toContain("1 blocker, 2 major, 3 minor");
    expect(driven.notifier.closed).toBe(true);
  });

  test("a failed run still closes the notifier and sends no end line", async () => {
    const driven = await drive(BASE, async () => {
      throw new Error("boom");
    });
    expect(driven.code).toBe(1);
    expect(driven.notifier.lines).toHaveLength(1);
    expect(driven.notifier.closed).toBe(true);
  });

  test("the lines name the repository and the pull request", () => {
    const target = parseAutonomousTarget(REF);
    expect(startLine(target, 1)).toContain("o/r PR #7");
    expect(startLine(target, 2)).toContain("resuming");
    expect(endLine(summary("complete", 0))).toContain("o/r PR #7");
  });

  test("a notifier that cannot reach serve neither throws nor waits", async () => {
    const notifier = createTelegramNotifier({
      project: "p",
      target: parseAutonomousTarget(REF),
      timeoutMs: 50,
      makeClient: () => ({ start: () => new Promise(() => undefined), reply: async () => true, close: async () => undefined }),
    });
    const began = Date.now();
    await notifier.started("hello");
    await notifier.close();
    expect(Date.now() - began).toBeLessThan(2000);
  });

  test("a connected client receives the line", async () => {
    const sent: string[] = [];
    const notifier = createTelegramNotifier({
      project: "p",
      target: parseAutonomousTarget(REF),
      makeClient: () => ({ start: async () => ({ ok: true }), reply: async (t) => (sent.push(t), true), close: async () => undefined }),
    });
    await notifier.started("one");
    await notifier.finished("two");
    await notifier.close();
    expect(sent).toEqual(["one", "two"]);
  });
});
