// Flow 424 (AC9): a scheduled autonomous review — created, listed, fired by the OS timer's
// `keryx trigger run`, and refused when the stored schedule was edited after the operator confirmed it.
// Every host here is fake: a temporary unit directory, a fake systemctl, a fake review runner.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunNotifier } from "../review/autonomous-notify";
import { AutonomousRunLockedError, type AutonomousRunOptions, type AutonomousRunResult } from "../review/autonomous-run";
import type { AutonomousSummary } from "../review/autonomous-summary";
import { scheduleStorePath } from "../trigger/config";
import type { CommandResult, ScheduleHost } from "../trigger/install";
import { projectScheduleHash } from "../trigger/schedule";
import { confirmSchedule, draftSchedule, listSchedules, type ScheduleRequest } from "../trigger/schedules";
import { readTriggerRuns, type TriggerRunRecord } from "../trigger/record";
import { requestFromArgs } from "./schedule";
import { runTriggerOnce } from "./trigger";

const TRUE_BIN = Bun.which("true") ?? "/usr/bin/true";
const REF = "https://github.com/o/r/pull/7435";
const saved = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };

let root = "";
let aside = "";
let home = "";
let unitDir = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-trig-review-"));
  aside = await mkdtemp(path.join(tmpdir(), "keryx-trig-review-aside-"));
  home = await mkdtemp(path.join(tmpdir(), "keryx-trig-review-home-"));
  unitDir = path.join(aside, "units");
  process.env["HOME"] = home;
  process.env["XDG_DATA_HOME"] = path.join(home, ".local", "share");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  process.exitCode = 0;
});
afterEach(async () => {
  process.exitCode = 0;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of [root, aside, home]) await rm(dir, { recursive: true, force: true });
});

function host(): ScheduleHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    backend: "systemd",
    unitDir,
    user: "someone",
    invocation: { execPath: TRUE_BIN },
    run: async (command: string, args: readonly string[]): Promise<CommandResult> => {
      calls.push([command, ...args].join(" "));
      if (command === "loginctl") return { code: 0, stdout: "Linger=yes\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function request(extra: Partial<ScheduleRequest> = {}): ScheduleRequest {
  return {
    name: "pr-7435",
    cadence: "every day at 03:00",
    prompt: "",
    provider: "anthropic",
    model: "claude-x",
    rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    ceilingUsd: 2,
    review: { ref: REF, budgetMinutes: 90, budgetTokens: 400_000 },
    ...extra,
  };
}

async function create(scheduleHost: ScheduleHost = host(), extra: Partial<ScheduleRequest> = {}) {
  const drafted = await draftSchedule(request(extra), { projectRoot: root, host: scheduleHost, accountOf: async () => "me" });
  if (!drafted.ok) throw new Error(drafted.problems.join("; "));
  await confirmSchedule(root, drafted.draft, scheduleHost);
  return drafted.draft;
}

function summary(status: AutonomousSummary["status"], exitCode: number, reason = "because"): AutonomousSummary {
  return {
    schemaVersion: 1,
    profile: "review-autonomous",
    target: { kind: "pr", ref: REF, repository: "o/r", number: 7435, head: "abc" },
    status,
    exitCode,
    reason,
    phase: "review ingest",
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:01:00.000Z",
    durationSeconds: 60,
    attempts: 1,
    rounds: 2,
    tokens: 1234,
    package: null,
    findings: { blocker: 0, major: 1, minor: 2, info: 0 },
    floorRefusals: 0,
    autoAnswers: { count: 3 },
  };
}

function runner(status: AutonomousSummary["status"], exitCode: number) {
  const seen: AutonomousRunOptions[] = [];
  const run = async (options: AutonomousRunOptions): Promise<AutonomousRunResult> => {
    seen.push(options);
    const runDir = path.join(root, ".metaproject", "data", "review-autonomous", "o-r-pr7435");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "report.md"), "# the report\n", "utf8");
    return { exitCode, status, summary: summary(status, exitCode), runDir, reused: false };
  };
  return { run, seen };
}

function notifier(): RunNotifier & { lines: string[]; closed: boolean } {
  const lines: string[] = [];
  const n = {
    lines,
    closed: false,
    started: async (line: string) => void lines.push(`start: ${line}`),
    finished: async (line: string) => void lines.push(`end: ${line}`),
    close: async () => {
      n.closed = true;
    },
  };
  return n;
}

async function lastRecord(): Promise<TriggerRunRecord> {
  const read = await readTriggerRuns(root);
  if (read.state !== "present") throw new Error(`no ledger: ${read.state}`);
  return read.records[read.records.length - 1]!;
}

describe("keryx schedule add --review-pr", () => {
  const flags = ["--name", "pr-7435", "--every", "1 day", "--provider", "anthropic", "--model", "claude-x", "--rates", "3,15", "--ceiling", "2"];

  test("a review needs no --prompt and carries its budgets", () => {
    const parsed = requestFromArgs([...flags, "--review-pr", REF, "--budget-minutes", "90", "--budget-tokens", "400000", "--stall-minutes", "5"]);
    expect(parsed.review).toEqual({ ref: REF, budgetMinutes: 90, budgetTokens: 400000, stallMinutes: 5 });
    expect(parsed.digest).toBeUndefined();
  });

  test("the budgets belong to a review", () => {
    expect(() => requestFromArgs([...flags, "--prompt", "x", "--budget-minutes", "90"])).toThrow("belong to a review");
  });

  test("--review-pr needs a value and cannot be combined with --digest", () => {
    expect(() => requestFromArgs([...flags, "--review-pr"])).toThrow("needs a pull request URL");
    expect(() => requestFromArgs([...flags, "--review-pr", REF, "--digest"])).toThrow("cannot be combined");
  });
});

describe("creating and listing a scheduled review", () => {
  test("the card says what runs, with nobody at the keyboard, and the timer is installed", async () => {
    const scheduleHost = host();
    const draft = await create(scheduleHost);
    const card = draft.card.join("\n");
    expect(card).toContain("autonomous review (profile review-autonomous)");
    expect(card).toContain(REF);
    expect(card).toContain("90 min");
    expect(card).toContain("400000 tokens");
    expect(card).toContain("10 min without progress");
    expect(scheduleHost.calls.some((c) => c.includes("enable --now"))).toBe(true);
  });

  test("the list shows it, installed, with the review block in the stored entry", async () => {
    await create();
    const rows = await listSchedules(root, { host: host() });
    expect(rows.map((r) => r.name)).toEqual(["pr-7435"]);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[0]!.installed).toBe(true);
    expect(rows[0]!.entry.action.review).toEqual({ ref: REF, budgetMinutes: 90, budgetTokens: 400000, stallMinutes: 10 });
    expect(rows[0]!.entry.action.dispatch.permissionMode).toBe("trust");
  });

  test("the OS timer runs `trigger run` for that schedule", async () => {
    await create();
    const service = readFileSync(path.join(unitDir, `keryx-${projectScheduleHash(root)}-pr-7435.service`), "utf8");
    expect(service).toContain(`ExecStart=${TRUE_BIN} trigger run --schedule pr-7435`);
  });

  test("a bad pull request URL is refused at the draft, before anything is stored", async () => {
    const drafted = await draftSchedule(request({ review: { ref: "https://example.com/x" } }), { projectRoot: root, host: host(), accountOf: async () => "me" });
    expect(drafted.ok).toBe(false);
    if (!drafted.ok) expect(drafted.problems.join("\n")).toContain("review.ref");
  });
});

describe("a fired scheduled review", () => {
  test("complete: outcome ok, the options reach the runner, the report is named, two notes are sent", async () => {
    await create();
    const fake = runner("complete", 0);
    const note = notifier();
    await runTriggerOnce(root, "pr-7435", { review: { run: fake.run, notifier: note } });
    const record = await lastRecord();
    expect(record.outcome).toBe("ok");
    const reportPath = record.agentTask?.reportPath;
    expect(reportPath).toMatch(/^\.metaproject\/data\/trigger\/reports\/pr-7435\/.+\.md$/);
    expect(readFileSync(path.join(root, reportPath!), "utf8")).toBe("# the report\n");
    expect(existsSync(path.join(root, ".metaproject", "data", "review-autonomous", "o-r-pr7435", "report.md"))).toBe(true);
    expect((await listSchedules(root, { host: host() }))[0]!.reportPath).toBe(reportPath);
    expect(fake.seen[0]).toMatchObject({ cwd: root, ref: REF, budgetMinutes: 90, budgetTokens: 400000, stallMs: 600_000, provider: "anthropic", model: "claude-x" });
    expect(note.lines).toHaveLength(2);
    expect(note.closed).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });

  for (const [status, code] of [
    ["incomplete", 2],
    ["floor", 3],
    ["budget", 4],
    ["stalled", 5],
  ] as const) {
    test(`${status} (review exit ${code}) is recorded as failed with the reason`, async () => {
      await create();
      await runTriggerOnce(root, "pr-7435", { review: { run: runner(status, code).run, notifier: notifier() } });
      const record = await lastRecord();
      expect(record.outcome).toBe("failed");
      expect(record.detail).toContain(`exit ${code}`);
      expect(record.detail).toContain("because");
    });
  }

  test("a second run of the same pull request is refused with a named lock", async () => {
    await create();
    await runTriggerOnce(root, "pr-7435", {
      review: {
        notifier: notifier(),
        run: async () => {
          throw new AutonomousRunLockedError(4242, "2026-10-11T10:00:00.000Z", "/tmp/run");
        },
      },
    });
    const record = await lastRecord();
    expect(record.outcome).toBe("lock-refused");
    expect(record.agentTask?.refusal).toBe("dispatch-locked");
    expect(record.detail).toContain("pid 4242");
  });

  test("a crash is a failed run, and the notifier is still closed", async () => {
    await create();
    const note = notifier();
    await runTriggerOnce(root, "pr-7435", {
      review: {
        notifier: note,
        run: async () => {
          throw new Error("boom");
        },
      },
    });
    expect((await lastRecord()).outcome).toBe("failed");
    expect(note.closed).toBe(true);
  });

  test("a stored schedule edited after confirmation (another pull request) never starts a review", async () => {
    await create();
    const entries = (JSON.parse(readFileSync(scheduleStorePath(root), "utf8")) as { triggers: Array<{ action: { review: { ref: string } } }> }).triggers;
    entries[0]!.action.review.ref = "https://github.com/evil/repo/pull/1";
    writeFileSync(scheduleStorePath(root), JSON.stringify({ schemaVersion: 1, triggers: entries }), "utf8");
    const fake = runner("complete", 0);
    const note = notifier();
    await runTriggerOnce(root, "pr-7435", { review: { run: fake.run, notifier: note } });
    expect(fake.seen).toEqual([]);
    expect(note.lines).toEqual([]);
    const record = await lastRecord();
    expect(record.outcome).toBe("dispatch-refused");
    expect(record.agentTask?.refusal).toBe("grants-changed");
  });
});
