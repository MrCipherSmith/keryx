import { mkdirSync, writeFileSync } from "node:fs";
// Flow 295 (AC6): the `/schedule` handler. It collects the cadence, prompt and
// grants, shows ONE card listing every required element, and declining writes nothing
// and installs nothing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScheduleSlashCommand, tokenizeArgs, type ScheduleSlashDeps } from "./schedule-command";
import { loadTriggersConfig, scheduleStorePath } from "../trigger/config";
import type { CommandResult } from "../trigger/install";
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
  writeFileSync(file, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  return file;
}


let root = "";
let unitDir = "";
let printed: string[] = [];
let cards: (readonly string[])[] = [];
let hostCalls: string[] = [];

function deps(answer: boolean): ScheduleSlashDeps {
  return {
    cwd: root,
    defaults: () => ({ provider: "anthropic", model: "claude-x" }),
    print: (line) => void printed.push(line),
    confirm: async (card) => {
      cards.push(card);
      return answer;
    },
    host: {
      backend: "systemd",
      unitDir,
      user: "someone",
      invocation: { execPath: "/opt/node/bin/node", scriptPath: "/opt/keryx/cli.js" },
      run: async (command, args): Promise<CommandResult> => {
        hostCalls.push([command, ...args].join(" "));
        return command === "loginctl" ? { code: 0, stdout: "Linger=yes\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      },
    },
    now: () => new Date(2026, 8, 23, 5, 7, 0),
    resolveProgram: (p) => fakeProgram(p),
    accountOf: async () => "MrCipherSmith",
  };
}

const LINE =
  '--name check-github --every "every 4 hours" --rates 3,15 --ceiling 0.5 --max-seconds 300 --network full ' +
  "--tool gh.pr.list --tool gh.issue.list --repo MrCipherSmith/keryx -- Check my open PRs and issues and summarise what needs my attention";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-slash-schedule-"));
  unitDir = await mkdtemp(path.join(tmpdir(), "keryx-slash-units-"));
  printed = [];
  cards = [];
  hostCalls = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(unitDir, { recursive: true, force: true });
});

describe("AC6: /schedule", () => {
  test("shows ONE card with every required element; declining writes no config and installs nothing", async () => {
    const created = await runScheduleSlashCommand(LINE, deps(false));
    expect(created).toBe(false);
    expect(cards).toHaveLength(1);
    const card = cards[0]!.join("\n");
    const unit = path.join(unitDir, `keryx-${projectScheduleHash(root)}-check-github.service`);
    for (const expected of [
      "cadence: 0 */4 * * * (every 4 hours)",
      "next runs: ", // three ISO times follow
      "prompt: Check my open PRs and issues and summarise what needs my attention",
      "runner: anthropic/claude-x, mode ask",
      "budget: ceiling $0.5 for this schedule",
      "max 300s per run",
      "network: NETWORK ON",
      `  - gh.pr.list: ${path.join(keyHome, "bin", "gh")}`,
      `  - gh.issue.list: ${path.join(keyHome, "bin", "gh")}`,
      "  account: gh: MrCipherSmith",
      `install: systemd — ${unit} + .timer`,
      "runs: /opt/node/bin/node /opt/keryx/cli.js trigger run --schedule check-github",
      "linger: on",
    ]) {
      expect(card).toContain(expected);
    }
    expect((/next runs: (.*)$/m.exec(card)?.[1] ?? "").split(", ")).toHaveLength(3);
    expect(printed.join("\n")).toContain("not confirmed — nothing was written or installed");
    expect(existsSync(scheduleStorePath(root))).toBe(false);
    expect(await readdir(unitDir)).toEqual([]);
    expect(hostCalls.filter((c) => c.startsWith("systemctl"))).toEqual([]);
  });

  test("confirming stores the entry and installs the timer", async () => {
    expect(await runScheduleSlashCommand(LINE, deps(true))).toBe(true);
    expect(loadTriggersConfig(root).triggers.map((t) => t.name)).toEqual(["check-github"]);
    expect((await readdir(unitDir)).length).toBe(2);
  });

  test("no arguments prints usage; a bad cadence is refused before any card", async () => {
    await runScheduleSlashCommand("", deps(true));
    expect(printed[0]).toContain("usage: /schedule");
    printed = [];
    await runScheduleSlashCommand('--name x --every "whenever" --rates 3,15 --ceiling 1 -- do it', deps(true));
    expect(cards).toEqual([]);
    expect(printed.join("\n")).toContain("is not a cadence keryx understands");
  });

  test("tokenizeArgs honours quotes", () => {
    expect(tokenizeArgs(`--every "every 4 hours" --x 'a b' c`)).toEqual(["--every", "every 4 hours", "--x", "a b", "c"]);
  });
});
