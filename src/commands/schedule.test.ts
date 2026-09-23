import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
// Flow 295 (AC9, and AC6's "declining writes nothing"): `keryx schedule` end to end,
// using a temporary unit directory and a fake systemctl. Nothing is installed on this
// machine and no model is called: the provider is "fake", which the dispatcher refuses
// (`provider-usage-unknown`) before any call.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scheduleCommand, type ScheduleCommandDeps } from "./schedule";
import { loadTriggersConfig, scheduleStorePath } from "../trigger/config";
import { readTriggerRuns } from "../trigger/record";
import type { CommandResult, ScheduleHost } from "../trigger/install";
import { projectScheduleHash } from "../trigger/schedule";

// Flow 295 (F1): confirming a schedule creates the per-machine signing key in keryx's
// user-global directory. Point HOME and XDG_DATA_HOME at a throwaway directory so no
// test ever writes the developer's real key.
let keyHome = "";
const savedKeyEnv = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };
beforeEach(async () => {
  keyHome = await mkdtemp(path.join(tmpdir(), "keryx-schedule-key-home-"));
  process.env["HOME"] = keyHome;
  process.env["XDG_DATA_HOME"] = path.join(keyHome, ".local", "share");
});
afterEach(async () => {
  for (const [name, value] of Object.entries(savedKeyEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(keyHome, { recursive: true, force: true });
});

/** A real, executable stand-in for a granted program, outside every project root. */
function fakeProgram(program: string): string {
  const dir = path.join(keyHome, "bin");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, program);
  // A real binary, not a `#!` script: drafting refuses scripts and shims (flow 295 N2).
  copyFileSync("/bin/true", file);
  chmodSync(file, 0o755);
  return file;
}


let root = "";
let unitDir = "";
let out: string[] = [];
let calls: string[] = [];
const realLog = console.log;
const realError = console.error;

function deps(extra: Partial<ScheduleCommandDeps> = {}): ScheduleCommandDeps {
  const host: ScheduleHost = {
    backend: "systemd",
    unitDir,
    user: "someone",
    invocation: { execPath: "/bin/true", scriptPath: "/bin/true" },
    run: async (command, args): Promise<CommandResult> => {
      calls.push([command, ...args].join(" "));
      return command === "loginctl" ? { code: 0, stdout: "Linger=no\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    },
  };
  return {
    cwd: root,
    isTerminal: true,
    host,
    now: () => new Date(2026, 8, 23, 5, 7, 0),
    resolveProgram: (p) => fakeProgram(p),
    accountOf: async () => "MrCipherSmith",
    ...extra,
  };
}

const ADD = [
  "add",
  "--name",
  "check-github",
  "--every",
  "every 4 hours",
  "--prompt",
  "Check open PRs and summarise what needs my attention.",
  "--provider",
  "fake",
  "--model",
  "m",
  "--rates",
  "3,15",
  "--ceiling",
  "0.5",
  "--tool",
  "gh.pr.list,gh.issue.list",
  "--repo",
  "MrCipherSmith/keryx",
];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-cli-"));
  unitDir = await mkdtemp(path.join(tmpdir(), "keryx-schedule-units-"));
  out = [];
  calls = [];
  console.log = (...parts: unknown[]) => void out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => void out.push(parts.map(String).join(" "));
  process.exitCode = 0;
});
afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
  await rm(unitDir, { recursive: true, force: true });
});

describe("keryx schedule add", () => {
  test("prints the full confirmation card; declining writes no config and installs nothing", async () => {
    await scheduleCommand(ADD, deps({ confirm: async () => false }));
    const text = out.join("\n");
    expect(text).toContain("cadence: 0 */4 * * * (every 4 hours)");
    expect(text).toContain("next runs: ");
    expect(text).toContain("prompt: Check open PRs and summarise what needs my attention.");
    expect(text).toContain("runner: fake/m, mode ask");
    expect(text).toContain("budget: ceiling $0.5");
    expect(text).toContain("network: off");
    expect(text).toContain(`  - gh.pr.list: ${path.join(keyHome, "bin", "gh")}`);
    expect(text).toContain("  account: gh: MrCipherSmith");
    expect(text).toContain(`install: systemd — ${path.join(unitDir, `keryx-${projectScheduleHash(root)}-check-github.service`)} + .timer`);
    expect(text).toContain("runs: /bin/true /bin/true trigger run --schedule check-github");
    expect(text).toContain("linger: off");
    expect(text).toContain("not confirmed — nothing was written or installed");
    expect(existsSync(scheduleStorePath(root))).toBe(false);
    expect(await readdir(unitDir)).toEqual([]);
    expect(calls.filter((c) => c.startsWith("systemctl"))).toEqual([]);
  });

  test("confirming stores the entry with its hash and installs the timer", async () => {
    await scheduleCommand(ADD, deps({ confirm: async () => true }));
    const entry = loadTriggersConfig(root).triggers.find((t) => t.name === "check-github");
    expect(entry?.source).toBe("store");
    expect(entry?.confirmedHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await readdir(unitDir)).length).toBe(2);
    expect(calls).toContain(`systemctl --user enable --now keryx-${projectScheduleHash(root)}-check-github.timer`);
  });

  test("missing required flags are reported together and nothing is written", async () => {
    await scheduleCommand(["add", "--name", "x"], deps());
    expect(process.exitCode).toBe(1);
    expect(out.join("\n")).toContain("missing --prompt, --provider, --model, --rates, --ceiling, --every (or --cron)");
    expect(existsSync(scheduleStorePath(root))).toBe(false);
  });
});

describe("list / pause / resume / run / remove", () => {
  test("the full lifecycle, and a fire while paused records no-op", async () => {
    await scheduleCommand([...ADD, "--yes"], deps());
    out = [];
    await scheduleCommand(["list"], deps());
    expect(out.join("\n")).toContain('check-github  [enabled]  cron "0 */4 * * *"  installed  next: ');
    expect(out.join("\n")).toContain("last: never ran  report: none yet");

    calls = [];
    await scheduleCommand(["pause", "check-github"], deps());
    expect(calls).toContain(`systemctl --user disable --now keryx-${projectScheduleHash(root)}-check-github.timer`);
    expect(loadTriggersConfig(root).triggers.find((t) => t.name === "check-github")?.enabled).toBe(false);

    // The timer is off, but a stray fire (a manual run) while paused is a no-op.
    await scheduleCommand(["run", "check-github"], deps());
    let read = await readTriggerRuns(root);
    if (read.state !== "present") throw new Error("no ledger");
    expect(read.records.at(-1)?.outcome).toBe("no-op");

    await scheduleCommand(["resume", "check-github"], deps());
    expect(loadTriggersConfig(root).triggers.find((t) => t.name === "check-github")?.enabled).toBe(true);

    // run: one pass now. The "fake" provider is refused before any model call.
    await scheduleCommand(["run", "check-github"], deps());
    read = await readTriggerRuns(root);
    if (read.state !== "present") throw new Error("no ledger");
    expect(read.records.at(-1)?.agentTask?.refusal).toBe("provider-usage-unknown");

    out = [];
    await scheduleCommand(["list"], deps());
    expect(out.join("\n")).toContain("last: dispatch-refused (provider-usage-unknown)");

    // remove: declined changes nothing; confirmed uninstalls and deletes.
    await scheduleCommand(["remove", "check-github"], deps({ confirm: async () => false }));
    expect((await readdir(unitDir)).length).toBe(2);
    await scheduleCommand(["remove", "check-github", "--yes"], deps());
    expect(await readdir(unitDir)).toEqual([]);
    expect(loadTriggersConfig(root).triggers.find((t) => t.name === "check-github")).toBeUndefined();
  });
});
