// Flow 295, review of T9 and the merge (122b25be): one regression test per confirmed
// finding. M1 (resume rewrote the unit with the caller's invocation), L1 (resume did not
// verify), M2 (a planted report path), M3 (a nested keryx driven through a pseudo-terminal),
// and the installer items of L4. Each fails with its fix reverted (see the flow journal).
// Every host here is fake: a temporary unit directory, a fake systemctl/crontab/loginctl.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { touchesHumanConfirmation, touchesSchedulerControl } from "../lib/command-risk";
import { scheduleStorePath } from "../trigger/config";
import { detectBackend, planInstall, resetDetectedBackendCache, type CommandResult, type ScheduleHost } from "../trigger/install";
import { readTriggerRuns } from "../trigger/record";
import { projectScheduleHash } from "../trigger/schedule";
import { confirmSchedule, draftSchedule, pauseStoredSchedule, resumeStoredSchedule, scheduleVerification, type ScheduleRequest } from "../trigger/schedules";
import { readScheduleReport, REPORT_READ_CAP_BYTES } from "../trigger/store";
import { runScheduleSlashCommand } from "../tui/schedule-command";
import { scheduleTools } from "./schedule-tools";

const TRUE_BIN = Bun.which("true") ?? "/usr/bin/true";
const RATES = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
const saved = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };

let root = "";
let aside = "";
let home = "";
let unitDir = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-sched-review-"));
  aside = await mkdtemp(path.join(tmpdir(), "keryx-sched-review-aside-"));
  home = await mkdtemp(path.join(tmpdir(), "keryx-sched-review-home-"));
  unitDir = path.join(aside, "units");
  process.env["HOME"] = home;
  process.env["XDG_DATA_HOME"] = path.join(home, ".local", "share");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
});
afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of [root, aside, home]) await rm(dir, { recursive: true, force: true });
});

/** A real executable named `gh`, outside the project. */
function fakeGh(): string {
  const dir = path.join(aside, "bin");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "gh");
  copyFileSync(TRUE_BIN, file);
  chmodSync(file, 0o755);
  return file;
}

function systemdHost(invocation: ScheduleHost["invocation"], linger = "no"): ScheduleHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    backend: "systemd",
    unitDir,
    user: "someone",
    ...(invocation !== undefined ? { invocation } : {}),
    run: async (command: string, args: readonly string[]): Promise<CommandResult> => {
      calls.push([command, ...args].join(" "));
      if (command === "loginctl") return { code: 0, stdout: `Linger=${linger}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function request(name = "check-github"): ScheduleRequest {
  return {
    name,
    cadence: "every 4 hours",
    prompt: "Check my open PRs.",
    provider: "anthropic",
    model: "claude-x",
    rates: RATES,
    ceilingUsd: 0.5,
    tools: ["gh.pr.list"],
    repos: ["o/r"],
  };
}

/** The operator's global keryx, confirmed on the card. */
const GLOBAL_KERYX = { execPath: TRUE_BIN };

async function confirmed(host: ScheduleHost, gh = fakeGh()): Promise<void> {
  const drafted = await draftSchedule(request(), { projectRoot: root, host, resolveProgram: () => gh, accountOf: async () => "me" });
  if (!drafted.ok) throw new Error(drafted.problems.join("; "));
  await confirmSchedule(root, drafted.draft, host);
}

function serviceFile(): string {
  return readFileSync(path.join(unitDir, `keryx-${projectScheduleHash(root)}-check-github.service`), "utf8");
}

function storeEntries(): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(scheduleStorePath(root), "utf8")) as { triggers: Array<Record<string, unknown>> }).triggers;
}

function rewriteStore(edit: (entry: Record<string, unknown>) => void): void {
  const entries = storeEntries();
  edit(entries[0]!);
  writeFileSync(scheduleStorePath(root), JSON.stringify({ schemaVersion: 1, triggers: entries }), "utf8");
}

describe("M1: resume reinstalls the CONFIRMED invocation, never the caller's", () => {
  test("the draft records the invocation and pinned env in the signed entry", async () => {
    const host = systemdHost(GLOBAL_KERYX);
    await confirmed(host);
    expect(storeEntries()[0]!["install"]).toEqual({ argv: [TRUE_BIN], env: { XDG_DATA_HOME: path.join(home, ".local", "share") } });
    expect(serviceFile()).toContain(`ExecStart=${TRUE_BIN} trigger run --schedule check-github`);
  });

  test("pause, then resume from `bun <project>/src/cli.ts`: ExecStart still runs the confirmed keryx", async () => {
    await confirmed(systemdHost(GLOBAL_KERYX));
    await pauseStoredSchedule(root, "check-github", systemdHost(GLOBAL_KERYX));
    const projectKeryx = { execPath: TRUE_BIN, scriptPath: path.join(root, "src", "cli.ts") };
    await resumeStoredSchedule(root, "check-github", systemdHost(projectKeryx));
    const service = serviceFile();
    expect(service).toContain(`ExecStart=${TRUE_BIN} trigger run --schedule check-github`);
    expect(service).not.toContain(root + "/src/cli.ts");
    expect(service).toContain(`Environment=XDG_DATA_HOME=${path.join(home, ".local", "share")}`);
  });

  test("a keryx running from inside the project is refused when the schedule is drafted", async () => {
    const inside = { execPath: TRUE_BIN, scriptPath: path.join(root, "src", "cli.ts") };
    const gh = fakeGh();
    const drafted = await draftSchedule(request(), { projectRoot: root, host: systemdHost(inside), resolveProgram: () => gh, accountOf: async () => "me" });
    expect(drafted.ok).toBe(false);
    if (!drafted.ok) expect(drafted.problems.join("\n")).toMatch(/runner: keryx is running from .*inside this project.*Install keryx globally/);
  });

  test("the confirmed invocation is signed: pointing it elsewhere fails verification and resume", async () => {
    await confirmed(systemdHost(GLOBAL_KERYX));
    await pauseStoredSchedule(root, "check-github", systemdHost(GLOBAL_KERYX));
    rewriteStore((entry) => {
      entry["install"] = { argv: ["/tmp/evil"], env: {} };
    });
    expect((await scheduleVerification(root, "check-github")).ok).toBe(false);
    await expect(resumeStoredSchedule(root, "check-github", systemdHost(GLOBAL_KERYX))).rejects.toThrow(/resume refused: .*changed after the operator confirmed it/);
  });
});

describe("L1: resume verifies the MAC and the pins before it re-enables", () => {
  test("a forged hash is refused, and the entry stays paused", async () => {
    await confirmed(systemdHost(GLOBAL_KERYX));
    await pauseStoredSchedule(root, "check-github", systemdHost(GLOBAL_KERYX));
    rewriteStore((entry) => {
      entry["confirmedHash"] = "0".repeat(64);
    });
    const host = systemdHost(GLOBAL_KERYX);
    await expect(resumeStoredSchedule(root, "check-github", host)).rejects.toThrow(/resume refused/);
    expect(host.calls.filter((c) => c.includes("enable --now"))).toEqual([]);
    expect(storeEntries()[0]!["enabled"]).toBe(false);
  });

  test("a granted binary swapped while paused is refused", async () => {
    const gh = fakeGh();
    await confirmed(systemdHost(GLOBAL_KERYX), gh);
    await pauseStoredSchedule(root, "check-github", systemdHost(GLOBAL_KERYX));
    writeFileSync(gh, "#!/bin/sh\necho swapped\n", { mode: 0o755 });
    await expect(resumeStoredSchedule(root, "check-github", systemdHost(GLOBAL_KERYX))).rejects.toThrow(/resume refused: .*gh/);
    const verification = await scheduleVerification(root, "check-github");
    expect(verification.ok).toBe(false);
  });

  test("an untouched entry verifies and resumes", async () => {
    await confirmed(systemdHost(GLOBAL_KERYX));
    await pauseStoredSchedule(root, "check-github", systemdHost(GLOBAL_KERYX));
    expect(await scheduleVerification(root, "check-github")).toEqual({ ok: true });
    await resumeStoredSchedule(root, "check-github", systemdHost(GLOBAL_KERYX));
    expect(storeEntries()[0]!["enabled"]).toBe(true);
  });
});

describe("M2: a report is read only from where keryx writes it", () => {
  const reportsDir = (): string => path.join(root, ".metaproject", "data", "trigger", "reports", "check-github");
  const runs = (): string => path.join(root, ".metaproject", "data", "trigger", "runs.jsonl");

  async function plant(reportPath: string, runId = "sch-1"): Promise<void> {
    await mkdir(path.dirname(runs()), { recursive: true });
    const record = {
      v: 1,
      at: "2026-09-23T09:00:00.000Z",
      trigger: "check-github",
      firedBy: { kind: "schedule", cron: "0 */4 * * *" },
      action: { kind: "agent-task" },
      outcome: "ok",
      detail: "report written",
      cost: { recorded: true, usd: 0.001 },
      agentTask: { runId, permissionMode: "ask", network: "off", reportPath },
    };
    await appendFile(runs(), `${JSON.stringify(record)}\n`, "utf8");
  }

  test("a planted `../../etc/hostname` is dropped when runs.jsonl is read; the real path is kept", async () => {
    await plant("../../etc/hostname");
    await plant(".metaproject/data/trigger/reports/check-github/sch-2.md", "sch-2");
    await plant(".metaproject/data/trigger/reports/check-github/sch-9.md", "sch-3"); // run id mismatch
    const read = await readTriggerRuns(root);
    expect(read.state).toBe("present");
    const paths = read.state === "present" ? read.records.map((r) => r.agentTask?.reportPath) : [];
    expect(paths).toEqual([undefined, ".metaproject/data/trigger/reports/check-github/sch-2.md", undefined]);
  });

  test("traversal, a symlink, a FIFO and an oversized file are refused without hanging", async () => {
    await mkdir(reportsDir(), { recursive: true });
    expect((await readScheduleReport(root, "check-github", "../../etc/hostname")).ok).toBe(false);
    symlinkSync("/etc/hostname", path.join(reportsDir(), "sch-link.md"));
    expect(await readScheduleReport(root, "check-github", ".metaproject/data/trigger/reports/check-github/sch-link.md")).toMatchObject({ ok: false });
    execFileSync("mkfifo", [path.join(reportsDir(), "sch-fifo.md")]);
    const fifo = await readScheduleReport(root, "check-github", ".metaproject/data/trigger/reports/check-github/sch-fifo.md");
    expect(fifo).toMatchObject({ ok: false });
    await writeFile(path.join(reportsDir(), "sch-big.md"), "x".repeat(REPORT_READ_CAP_BYTES + 1), "utf8");
    expect(await readScheduleReport(root, "check-github", ".metaproject/data/trigger/reports/check-github/sch-big.md")).toMatchObject({ ok: false });
    await writeFile(path.join(reportsDir(), "sch-ok.md"), "# fine\n", "utf8");
    expect(await readScheduleReport(root, "check-github", ".metaproject/data/trigger/reports/check-github/sch-ok.md")).toEqual({ ok: true, text: "# fine\n", truncated: false });
  });

  test("a symlinked reports directory is refused", async () => {
    const elsewhere = path.join(aside, "planted");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "sch-1.md"), "secret\n", "utf8");
    await mkdir(path.dirname(reportsDir()), { recursive: true });
    symlinkSync(elsewhere, reportsDir());
    expect(await readScheduleReport(root, "check-github", ".metaproject/data/trigger/reports/check-github/sch-1.md")).toMatchObject({ ok: false });
  });
});

describe("M3a: a keryx started from an agent's shell refuses every schedule surface", () => {
  const NESTED = { KERYX_TOOL_CALL: "1" };

  test("/schedule refuses before drafting, and writes nothing", async () => {
    const printed: string[] = [];
    let asked = false;
    const created = await runScheduleSlashCommand('--name x --every "every 4 hours" --rates 3,15 --ceiling 0.5 -- do it', {
      cwd: root,
      env: NESTED,
      defaults: () => ({ provider: "anthropic", model: "claude-x" }),
      print: (line) => printed.push(line),
      confirm: async () => {
        asked = true;
        return true;
      },
    });
    expect(created).toBe(false);
    expect(asked).toBe(false);
    expect(printed.join("\n")).toContain("KERYX_TOOL_CALL=1");
    expect(await readdir(root)).not.toContain(".metaproject");
  });

  test("schedule_create's card is never drafted", async () => {
    const [create] = scheduleTools({ projectRoot: root, env: NESTED, host: systemdHost(GLOBAL_KERYX), resolveProgram: () => fakeGh(), accountOf: async () => "me" });
    const result = await create!.confirmation!({ name: "x", cadence: "every 4 hours", prompt: "p", provider: "a", model: "m", rates: RATES, ceilingUsd: 0.5 });
    expect(result).toMatchObject({ error: expect.stringContaining("KERYX_TOOL_CALL=1") });
  });
});

describe("M3b: starting an interactive keryx or driving a terminal around one always asks", () => {
  const ASK = [
    "keryx",
    "keryx shell",
    "keryx shell -c",
    "keryx shell --no-tui",
    "bun src/cli.ts shell",
    "npx keryx shell",
    "printf '/schedules\\r' | script -qfc keryx /dev/null",
    "script -qfc 'keryx shell' /dev/null",
    "script -q /dev/null keryx shell",
    "tmux new-session -d 'keryx shell'",
    "tmux send-keys -t main /schedules Enter",
    "screen -S main -X stuff 'y'",
    "unbuffer keryx shell",
    "env -u KERYX_TOOL_CALL keryx shell",
    "bash -c 'keryx shell'",
  ];
  test.each(ASK)("%s", (command) => {
    expect(touchesSchedulerControl(command)).toBe(true);
    expect(touchesHumanConfirmation(command)).toBe(true);
  });

  test("headless and read-only runs are not caught: they cannot reach the TUI", () => {
    for (const command of ["keryx shell -p 'summarise'", "keryx shell --print hi", "keryx --help", "keryx schedule list", "keryx status", "echo keryx shell", "script -q log.txt ls"]) {
      expect(touchesSchedulerControl(command)).toBe(false);
    }
  });
});

describe("L4: installer details", () => {
  test("the card's `runs:` line quotes the command the way the unit does", async () => {
    const spaced = path.join(aside, "my keryx", "keryx");
    const plan = await planInstall(root, "check-github", "0 */4 * * *", systemdHost(undefined), { argv: [spaced], env: {} });
    expect(plan.execStart).toBe(`"${spaced}" trigger run --schedule check-github`);
    const cron = await planInstall(root, "check-github", "0 */4 * * *", { backend: "launchd", launchAgentsDir: aside }, { argv: [spaced], env: {} });
    expect(cron.execStart).toBe(`'${spaced}' trigger run --schedule 'check-github'`);
  });

  test("the backend probe runs once per host, so a reload does not spawn systemctl again", async () => {
    resetDetectedBackendCache();
    let probes = 0;
    const host: ScheduleHost = {
      platform: "linux",
      run: async (command) => {
        if (command === "systemctl") probes += 1;
        return { code: 0, stdout: "running\n", stderr: "" };
      },
    };
    expect(await detectBackend(host)).toBe("systemd");
    expect(await detectBackend(host)).toBe("systemd");
    await planInstall(root, "x", "0 */4 * * *", host, { argv: [TRUE_BIN], env: {} });
    expect(probes).toBe(1);
  });
});
