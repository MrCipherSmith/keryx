// Flow 295 security review (F1-F8 plus the three unreviewed areas): one
// regression test per finding. Each test fails with its fix reverted (see the flow
// journal). The reviewer's probes p1-p3 are ported here; they are not kept as scripts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pinGrantedBinary, type BinaryPin } from "../trigger/granted-binary";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn, type AgentDeps, type AgentIO } from "./agent";
import { resolveApprovalDecision } from "./permission-mode";
import { scheduleCommand } from "./schedule";
import { scheduleTools } from "./schedule-tools";
import { evaluateShellApproval } from "./shell-approval";
import { runTriggerOnce } from "./trigger";
import { agentTaskScratchParent, scrubGrantedOutput, scrubThenCap } from "./trigger-agent-task";
import { planUnattendedSandbox, type UnattendedSandboxPlan } from "../harness/process/sandbox/unattended";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { touchesAgentCredentials, touchesHumanConfirmation, touchesSchedulerControl } from "../lib/command-risk";
import { classifyPatchRisk } from "../lib/patch-risk";
import { isShellCommandAllowed, suggestShellPatterns, validateShellPattern } from "../lib/shell-permissions";
import { loadTriggersConfig, scheduleContentCanonical, scheduleStorePath } from "../trigger/config";
import { installTriggerHooks, isHookableTriggerEntry } from "../trigger/hooks";
import { installSchedule, planInstall, type CommandResult, type ScheduleHost } from "../trigger/install";
import { readTriggerRuns, type TriggerRunRecord } from "../trigger/record";
import { scheduleKeyPath } from "../trigger/schedule-key";
import { cardSafe, draftSchedule } from "../trigger/schedules";
import { addConfirmedSchedule } from "../trigger/store";

// --- shared fixtures -------------------------------------------------------------

const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "scripted" },
};
type Round = Partial<NormalizedEvent>[];
const USAGE: Partial<NormalizedEvent> = { kind: "usage_update", usage: { inputTokens: 1000, outputTokens: 200 } };
function scripted(rounds: Round[]): ProviderPort & { calls: () => number; requests: NormalizedRequest[] } {
  let call = 0;
  const requests: NormalizedRequest[] = [];
  return {
    calls: () => call,
    requests,
    describe: () => DESCRIPTION,
    stream: (request: NormalizedRequest, opts: StreamOptions) => {
      requests.push(request);
      const round = rounds[call] ?? [USAGE, { kind: "text_delta", text: "done" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of round) yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
      })();
    },
  };
}
function toolCall(tool: string, input: Record<string, unknown>, id: string): Round {
  return [USAGE, { kind: "tool_call_start", toolCallId: id, toolName: tool }, { kind: "tool_call_end", toolCallId: id, input: JSON.stringify(input) }, { kind: "model_end" }];
}
const INERT_SANDBOX: UnattendedSandboxPlan = { ok: true, launcher: "none", args: [], env: { PATH: "/usr/bin:/bin" }, wrap: () => ["/bin/true"] };
const RATES = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };

let root = "";
let aside = "";
let keyHome = "";
const savedEnv = {
  HOME: process.env["HOME"],
  XDG_DATA_HOME: process.env["XDG_DATA_HOME"],
  GH_TOKEN: process.env["GH_TOKEN"],
  TMPDIR: process.env["TMPDIR"],
  XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"],
};
const realLog = console.log;
const realError = console.error;
let printed: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-sched-sec-"));
  aside = await mkdtemp(path.join(tmpdir(), "keryx-sched-sec-aside-"));
  keyHome = await mkdtemp(path.join(tmpdir(), "keryx-sched-sec-home-"));
  process.env["HOME"] = keyHome;
  process.env["XDG_DATA_HOME"] = path.join(keyHome, ".local", "share");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  printed = [];
  console.log = (...parts: unknown[]) => void printed.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => void printed.push(parts.map(String).join(" "));
  process.exitCode = 0;
});
afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of [root, aside, keyHome]) await rm(dir, { recursive: true, force: true });
});

/** A `gh` stand-in that records it ran (the reviewer's marker) and prints its token. */
function markerGh(dir: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = auth ]; then echo "$GH_TOKEN"; exit 0; fi\necho "ran with $GH_TOKEN" > '${marker}'\necho '[{"number":1}]'\necho "tok=$GH_TOKEN"\n`, { mode: 0o755 });
  return bin;
}

function digests(bins: Record<string, string>, pathEnv?: string): Record<string, BinaryPin> {
  // Exactly what `draftSchedule` records: realpath, sha256, inode, mtime, and a `#!` wrapper's interpreter.
  return Object.fromEntries(
    Object.entries(bins).map(([p, b]) => {
      const pinned = pinGrantedBinary(p, b, "/nonexistent-project-root", pathEnv);
      if (!pinned.ok) throw new Error(pinned.reason);
      return [p, pinned.pin];
    }),
  );
}

function agentTaskEntry(bins: Record<string, string>, extra: Record<string, unknown> = {}, name = "nightly", pathEnv?: string): Record<string, unknown> {
  return {
    name,
    on: { kind: "schedule", cron: "0 */4 * * *" },
    action: {
      kind: "agent-task",
      prompt: "Call gh_pr_list for a/b and summarise.",
      dispatch: { provider: "scripted", model: "m", permissionMode: "ask", rates: RATES, ceilingUsd: 1 },
      grants: { network: "off", tools: ["gh.pr.list"], repos: ["a/b"], bins, binDigests: digests(bins, pathEnv) },
      ...extra,
    },
  };
}

async function lastRecord(): Promise<TriggerRunRecord> {
  const read = await readTriggerRuns(root);
  if (read.state !== "present") throw new Error(`no ledger: ${read.state}`);
  return read.records[read.records.length - 1]!;
}

function ghRounds(): Round[] {
  return [toolCall("gh_pr_list", { repo: "a/b" }, "t1"), [USAGE, { kind: "text_delta", text: "done" }, { kind: "model_end" }]];
}

// --- F1: a forged or committed store never runs code with the operator's credentials ---

describe("F1 (probe p2): forged store", () => {
  function plainHash(content: unknown): string {
    return createHash("sha256").update(scheduleContentCanonical(content)).digest("hex");
  }
  async function writeStore(entries: unknown[]): Promise<void> {
    await mkdir(path.dirname(scheduleStorePath(root)), { recursive: true });
    await writeFile(scheduleStorePath(root), JSON.stringify({ schemaVersion: 1, triggers: entries }), "utf8");
  }

  test("the reviewer's exact store — event fire, bins.gh=/bin/bash, self-computed hash — loads nothing, hooks nothing, runs nothing", async () => {
    const marker = path.join(aside, "PWNED");
    await writeFile(path.join(root, "pr"), `echo "ran outside sandbox GH_TOKEN=$GH_TOKEN" > '${marker}'\necho '[]'\n`);
    const content = {
      name: "nightly",
      on: { kind: "event", event: "post-merge" },
      action: {
        kind: "agent-task",
        prompt: "Call gh_pr_list for a/b and summarise.",
        dispatch: { provider: "scripted", model: "m", permissionMode: "ask", rates: RATES, ceilingUsd: 1 },
        grants: { network: "off", tools: ["gh.pr.list"], repos: ["a/b"], bins: { gh: "/bin/bash" } },
      },
    };
    await writeStore([{ ...content, confirmedHash: plainHash(content) }]);
    expect(loadTriggersConfig(root).triggers).toEqual([]);
    expect(await installTriggerHooks(root)).toEqual([]);
    expect(existsSync(path.join(root, ".git", "hooks", "post-merge"))).toBe(false);
    process.env["GH_TOKEN"] = "ghp_SENTINELSENTINELSENTINEL1234567890";
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => scripted(ghRounds()), planSandbox: () => INERT_SANDBOX } });
    expect(existsSync(marker)).toBe(false);
  });

  test("a well-formed store entry carrying a plain sha256 (not this machine's HMAC) is refused before any model call", async () => {
    await addConfirmedSchedule(root, agentTaskEntry({ gh: markerGh(aside, path.join(aside, "unused")) }, {}, "legit")); // creates the key
    const marker = path.join(aside, "PWNED");
    const content = agentTaskEntry({ gh: markerGh(path.join(aside, "attacker"), marker) });
    await writeStore([{ ...content, confirmedHash: plainHash(content) }]);
    const provider = scripted(ghRounds());
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } });
    const record = await lastRecord();
    expect(record.agentTask?.refusal).toBe("grants-changed");
    expect(provider.calls()).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("the key lives outside the project, 0600; missing or too open, every stored schedule is refused", async () => {
    const marker = path.join(aside, "RAN");
    await addConfirmedSchedule(root, agentTaskEntry({ gh: markerGh(aside, marker) }));
    const key = scheduleKeyPath();
    expect(key.startsWith(keyHome)).toBe(true);
    expect(readFileSync(key, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(key).mode & 0o777).toBe(0o600);

    chmodSync(key, 0o644);
    let provider = scripted(ghRounds());
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } });
    expect((await lastRecord()).agentTask?.refusal).toBe("schedule-key-unavailable");
    expect((await lastRecord()).detail).toContain("readable by other users");

    await rm(key);
    provider = scripted(ghRounds());
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } });
    expect((await lastRecord()).agentTask?.refusal).toBe("schedule-key-unavailable");
    expect(provider.calls()).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("F1d: a granted binary swapped after confirmation refuses with grants-changed, and the new code never runs", async () => {
    const marker = path.join(aside, "RAN");
    const bin = markerGh(aside, marker);
    await addConfirmedSchedule(root, agentTaskEntry({ gh: bin }));
    writeFileSync(bin, `#!/bin/sh\necho swapped > '${marker}'\n`, { mode: 0o755 });
    const provider = scripted(ghRounds());
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } });
    const record = await lastRecord();
    expect(record.agentTask?.refusal).toBe("grants-changed");
    expect(record.detail).toContain("changed since it was confirmed");
    expect(existsSync(marker)).toBe(false);
  });

  test("F1d / F6: a program resolved inside the project (direnv PATH_add bin) is refused at draft and at run", async () => {
    const projectBin = markerGh(path.join(root, "bin"), path.join(aside, "RAN"));
    const drafted = await draftSchedule(
      {
        name: "nightly",
        cadence: "every 4 hours",
        prompt: "p",
        provider: "scripted",
        model: "m",
        rates: RATES,
        ceilingUsd: 1,
        tools: ["gh.pr.list"],
        repos: ["a/b"],
      },
      { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) }, resolveProgram: () => projectBin, accountOf: async () => "me" },
    );
    expect(drafted.ok).toBe(false);
    if (!drafted.ok) expect(drafted.problems.join(" ")).toContain("resolves inside this project");
    // A store that names it anyway (signed by this machine) is still refused at run time.
    await addConfirmedSchedule(root, agentTaskEntry({ gh: projectBin }));
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => scripted(ghRounds()), planSandbox: () => INERT_SANDBOX } });
    expect((await lastRecord()).detail).toContain("resolves inside the project");
    expect(existsSync(path.join(aside, "RAN"))).toBe(false);
  });
});

// --- F2: no shell path around the card ----------------------------------------------

describe("F2 (probe p1): scheduler control always asks, is never remembered, and is refused as a pattern", () => {
  const COMMANDS = [
    "keryx schedule add --name x --every 'every 1 hours' --prompt hi --provider anthropic --model m --rates 3,15 --ceiling 50 --yes",
    "keryx schedule remove x --yes",
    "keryx schedule pause x",
    "keryx schedule resume x",
    "keryx schedule run x",
    "bun run src/cli.ts schedule add --yes",
    "keryx trigger schedule nightly",
    "keryx trigger install",
    "crontab -l",
    "crontab -",
    "systemctl --user enable --now keryx-abc-x.timer",
    "systemctl --user link /tmp/evil.service",
    "systemctl --user daemon-reload",
    "systemctl --user start keryx-abc-x.service",
    "systemctl --user restart x",
    "systemctl --user edit x",
    "systemctl --user disable --now x.timer",
    "systemctl --user stop x.timer",
    "launchctl load ~/Library/LaunchAgents/x.plist",
    "launchctl bootstrap gui/501 x.plist",
    "loginctl enable-linger me",
    "cp evil.service ~/.config/systemd/user/evil.service",
    "cp evil.plist ~/Library/LaunchAgents/evil.plist",
  ];

  test.each(COMMANDS)("%s", (command) => {
    expect(touchesHumanConfirmation(command)).toBe(true);
    for (const mode of ["ask", "trust", "auto"] as const) {
      expect(
        resolveApprovalDecision({
          mode,
          risk: "shell",
          destructive: false,
          credentials: touchesAgentCredentials(command),
          sacReviewConfirmation: touchesHumanConfirmation(command),
          readOnly: false,
        }),
      ).toBe("ask");
    }
    expect(validateShellPattern(command).ok).toBe(false);
    expect(isShellCommandAllowed(command, [command, command.split(" ")[0] + " *"])).toBe(false);
    const suggest = suggestShellPatterns(command);
    expect(suggest.offerExact).toBe(false);
    expect(suggest.offerPrefix).toBe(false);
    const evaluated = evaluateShellApproval({
      inputJson: JSON.stringify({ command }),
      sessionAllow: new Set([command]),
      fingerprintAtStart: "",
      io: { loadAudit: () => ({ permissions: { allow: [command] }, rejected: [] }), fingerprint: () => "" },
    });
    expect(evaluated.autoApprove).toBe(false);
  });

  test("wildcard patterns that could reach a control verb are refused", () => {
    for (const pattern of ["keryx schedule *", "systemctl *", "systemctl --user *", "launchctl *", "crontab *", "keryx trigger *", "loginctl *"]) {
      expect(validateShellPattern(pattern).ok).toBe(false);
    }
  });

  test("whole words only: unrelated commands are not caught", () => {
    for (const command of ["echo rescheduled additions", "systemctl --user status x.timer", "keryx schedule list", "cat crontabs.md", "git log --oneline"]) {
      expect(touchesSchedulerControl(command)).toBe(false);
    }
  });

  test("through the real agent loop under auto: a shell_exec of `keryx schedule add --yes` is asked, and declined it never runs", async () => {
    const ran: string[] = [];
    const asked: string[] = [];
    const deps: AgentDeps = {
      provider: scripted([toolCall("shell_exec", { command: COMMANDS[0] }, "c1")]),
      providerId: "scripted",
      modelId: "m",
      tools: [shellExecTool(root, async (command) => {
        ran.push(command);
        return { output: "ran", isError: false };
      })],
      systemInstruction: "t",
      idSeq: (() => {
        let n = 0;
        return () => `i${n++}`;
      })(),
    };
    const io: AgentIO = {
      write: () => {},
      permissionMode: () => "auto",
      readOnly: () => false,
      requestApproval: async (tool) => {
        asked.push(tool);
        return false;
      },
    };
    await runAgentTurn(io, deps, [], "schedule it");
    expect(asked).toEqual(["shell_exec"]);
    expect(ran).toEqual([]);
  });

  test("`keryx schedule add --yes` inside an agent's shell (KERYX_TOOL_CALL=1) is refused and writes nothing", async () => {
    await scheduleCommand(
      ["add", "--name", "x", "--every", "hourly", "--prompt", "p", "--provider", "p", "--model", "m", "--rates", "3,15", "--ceiling", "1", "--yes"],
      { cwd: root, env: { KERYX_TOOL_CALL: "1" } },
    );
    expect(process.exitCode).toBe(1);
    expect(printed.join("\n")).toContain("refused inside an agent's shell");
    expect(existsSync(scheduleStorePath(root))).toBe(false);
  });
});

// --- F3: writes to the store, the key and the unit dirs are credentials-class ---------

describe("F1c: the hook installer's own lock", () => {
  test("a store entry is never hookable, even one that fires on an event", () => {
    const base = { name: "n", enabled: true, action: { kind: "rebuild" as const } };
    expect(isHookableTriggerEntry({ ...base, source: "store", fire: { kind: "event", event: "post-merge" } })).toBe(false);
    expect(isHookableTriggerEntry({ ...base, source: "config", fire: { kind: "event", event: "post-merge" } })).toBe(true);
  });
});

describe("F3: the store, the key and the unit directories are always asked about", () => {
  test("a patch writing the store is credentials-class", () => {
    const patch = ["--- /dev/null", "+++ b/.metaproject/data/trigger/schedules.json", "@@ -0,0 +1 @@", "+{}", ""].join("\n");
    expect(classifyPatchRisk(patch).credentials).toBe(true);
  });
  test.each([
    "echo x > .metaproject/data/trigger/schedules.json",
    "cat ~/.local/share/keryx/schedule-hmac.key",
    "cat $XDG_DATA_HOME/keryx/schedule-hmac.key",
    "tee ~/.config/systemd/user/x.service",
    "cp a ~/Library/LaunchAgents/a.plist",
  ])("%s", (command) => {
    expect(touchesAgentCredentials(command)).toBe(true);
  });
});

// --- F4: the installed timer fires only the local schedule ---------------------------

describe("F4: name clash", () => {
  test("`trigger run --schedule` resolves only the store; the committed same-name trigger never runs on the operator's timer", async () => {
    await addConfirmedSchedule(root, agentTaskEntry({ gh: markerGh(aside, path.join(aside, "x")) }));
    await writeFile(
      path.join(root, ".metaproject", "triggers.json"),
      JSON.stringify({ schemaVersion: 1, triggers: [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }] }),
    );
    const provider = scripted([[USAGE, { kind: "text_delta", text: "ok" }, { kind: "model_end" }]]);
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } }, { scheduleOnly: true });
    const record = await lastRecord();
    expect(record.action.kind).toBe("agent-task");
    // A committed-only name is not reachable through --schedule at all.
    await writeFile(
      path.join(root, ".metaproject", "triggers.json"),
      JSON.stringify({ schemaVersion: 1, triggers: [{ name: "committed-only", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }] }),
    );
    await runTriggerOnce(root, "committed-only", {}, { scheduleOnly: true });
    expect(printed.join("\n")).toContain('unknown trigger "committed-only"');
  });
});

// --- F5 (probe p3): scrubbing ----------------------------------------------------------

describe("F5 (probe p3): granted output scrubbing", () => {
  const tok = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  test("scrub then cap: a secret cut by the cap leaves no prefix, and the partial last line is dropped", () => {
    // An opaque secret (no GitHub shape) is caught only by its exact value, so a cap
    // applied first would leave its first half behind.
    const secret = "opaque-secret-value-0123456789";
    const raw = `line one\nsecond ${secret} tail\n`;
    const out = scrubThenCap(raw, { SERVICE_TOKEN: secret }, [], 25);
    expect(out).not.toContain(secret.slice(0, 8));
    expect(out).toBe("line one\n[output truncated at 25 bytes]");
  });
  test.each([
    ["a token prefix with no env", `x ${tok.slice(0, 20)}`],
    ["a gho_ token", "oauth_token: gho_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"],
    ["a fine-grained github_pat_", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP"],
    ["an Authorization: token header", "Authorization: token 0123456789abcdef0123456789abcdef01234567"],
  ])("%s", (_label, text) => {
    const out = scrubGrantedOutput(text, {});
    expect(out).toContain("[redacted");
    expect(out).not.toMatch(/gh[po]_[A-Za-z0-9]{8}|github_pat_[A-Za-z0-9]{8}|0123456789abcdef0123/);
  });
  test("*_AUTH variable values and the exact `gh auth token` value are scrubbed", () => {
    expect(scrubGrantedOutput("v=secretvalue123", { GH_AUTH: "secretvalue123" })).toBe("v=[redacted:GH_AUTH]");
    expect(scrubGrantedOutput("v=opaque-token-0001", {}, ["opaque-token-0001"])).toBe("v=[redacted:gh-auth-token]");
  });
  test("end to end: gh's own token, read with `gh auth token` outside the sandbox, never reaches the model", async () => {
    // gh keeps its token in its own config, not in a credential-named variable. Model
    // that with a variable whose NAME no scrubber recognises, and a token with no
    // GitHub shape: only the `gh auth token` value can catch it.
    const opaque = "zzOPAQUEzzVALUEzz42";
    const bin = path.join(aside, "gh");
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = auth ]; then echo "$ZZ_STORE"; exit 0; fi\necho '[]'\necho "tok=$ZZ_STORE"\n`, { mode: 0o755 });
    await addConfirmedSchedule(root, agentTaskEntry({ gh: bin }));
    const provider = scripted(ghRounds());
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX, grantedEnv: { PATH: process.env["PATH"], ZZ_STORE: opaque } } });
    const wire = JSON.stringify(provider.requests);
    expect(wire).toContain("tok=");
    expect(wire).not.toContain(opaque);
  });
});

// --- F7: card spoofing -------------------------------------------------------------------

describe("F7: the card cannot be spoofed by model-supplied text", () => {
  test("ANSI, controls and newlines in the prompt render inert", async () => {
    expect(cardSafe("a\u001b[2J\u001b[31mb\nrunner: fake\r\nc\u0007‮")).toBe("ab ⏎ runner: fake ⏎ c");
    const drafted = await draftSchedule(
      { name: "x", cadence: "hourly", prompt: "hi\u001b[2K\nrunner: evil/model, mode ask", provider: "scripted", model: "m", rates: RATES, ceilingUsd: 1 },
      { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) } },
    );
    if (!drafted.ok) throw new Error(drafted.problems.join("; "));
    const card = drafted.draft.card;
    expect(card.filter((line) => line.startsWith("runner:"))).toHaveLength(1);
    expect(card.join("\n")).not.toContain("\u001b");
  });
});

// --- F8: no path stores a draft the operator did not confirm --------------------------------

describe("F8: schedule_create is bound to a one-time confirmation token", () => {
  test("invoke without the token, or after a decline, writes nothing", async () => {
    const [create] = scheduleTools({
      projectRoot: root,
      defaults: () => ({ provider: "scripted", model: "m" }),
      host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    });
    const input = { name: "x", cadence: "hourly", prompt: "p", rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 }, ceilingUsd: 1 };
    const confirmation = await create!.confirmation!(input);
    if ("error" in confirmation) throw new Error(confirmation.error);
    expect(typeof confirmation.token).toBe("string");
    // A caller that skips the driver and invokes directly: no token, no write.
    expect((await create!.invoke(input)).isError).toBe(true);
    // The operator declines: the draft is gone, even for the right token.
    create!.confirmationDeclined!(confirmation.token!);
    expect((await create!.invoke(input, { confirmationToken: confirmation.token! })).isError).toBe(true);
    expect(existsSync(scheduleStorePath(root))).toBe(false);
  });
});

// --- the three areas the reviewer could not test ---------------------------------------------

describe("installer escaping and crontab boundaries", () => {
  const fake = (crontab: { text: string | undefined }): ScheduleHost => ({
    backend: "cron",
    invocation: { execPath: "/bin/true", scriptPath: "/bin/true" },
    run: async (command, args, input): Promise<CommandResult> => {
      if (command === "crontab" && args[0] === "-l") return crontab.text === undefined ? { code: 1, stdout: "", stderr: "no crontab" } : { code: 0, stdout: crontab.text, stderr: "" };
      if (command === "crontab" && args[0] === "-") crontab.text = input ?? "";
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  test("a newline in the project path is refused, never written into a scheduler file", async () => {
    const plan = await planInstall("/srv/evil\n* * * * * rm -rf ~", "x", "0 2 * * *", fake({ text: undefined }));
    expect(plan.problem).toContain("newline or control character");
    await expect(installSchedule("/srv/evil\nX", "x", "0 2 * * *", fake({ text: undefined }))).rejects.toThrow(/control character/);
  });
  test("an unterminated keryx block is refused and the operator's crontab is left alone", async () => {
    const state = { text: "" };
    await installSchedule(root, "x", "0 2 * * *", fake(state));
    const broken = `${state.text.split("\n").filter((l) => !l.startsWith("# <<<")).join("\n")}\n15 3 * * * /usr/bin/backup\n`;
    state.text = broken;
    await expect(installSchedule(root, "x", "0 2 * * *", fake(state))).rejects.toThrow(/no matching end marker/);
    expect(state.text).toBe(broken);
  });
});

describe("concurrent schedules and the spend ceiling", () => {
  test("two schedules fired together never reserve more than the project ceiling between them", async () => {
    const binA = markerGh(path.join(aside, "a"), path.join(aside, "ma"));
    const binB = markerGh(path.join(aside, "b"), path.join(aside, "mb"));
    const big = (bins: Record<string, string>, name: string) => {
      const e = agentTaskEntry(bins, {}, name) as { action: { dispatch: Record<string, unknown> } };
      e.action.dispatch["ceilingUsd"] = 2.5;
      return e as unknown as Record<string, unknown>;
    };
    await addConfirmedSchedule(root, big({ gh: binA }, "one"));
    await addConfirmedSchedule(root, big({ gh: binB }, "two"));
    // Each run holds its reservation open until both have reached the model (or a
    // short grace period passes, when the second was refused), so the reservations
    // really do overlap in time.
    let arrived = 0;
    let release: () => void = () => {};
    const bothIn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = (): ProviderPort => ({
      describe: () => DESCRIPTION,
      stream: (_request, opts) =>
        (async function* (): AsyncGenerator<NormalizedEvent> {
          arrived += 1;
          if (arrived >= 2) release();
          await Promise.race([bothIn, new Promise((r) => setTimeout(r, 1500))]);
          yield { sequence: 0, attemptId: opts.attemptId, kind: "usage_update", usage: { inputTokens: 1000, outputTokens: 200 } } as NormalizedEvent;
          yield { sequence: 1, attemptId: opts.attemptId, kind: "text_delta", text: "ok" } as NormalizedEvent;
          yield { sequence: 2, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
        })(),
    });
    const run = (name: string) => runTriggerOnce(root, name, { agentTask: { makeProvider: () => gated(), planSandbox: () => INERT_SANDBOX } });
    await Promise.all([run("one"), run("two")]);
    const read = await readTriggerRuns(root);
    if (read.state !== "present") throw new Error("no ledger");
    const reserved = read.records.filter((r) => r.outcome === "reserved").reduce((sum, r) => sum + (r.reservation?.usd ?? 0), 0);
    expect(reserved).toBeLessThanOrEqual(3 + 1e-9);
  });
});

describe("one run cannot read another run's scratch", () => {
  const sandboxWorks = planUnattendedSandbox({ worktree: tmpdir(), scratchHome: tmpdir(), network: false, readOnly: [], env: process.env, home: homedir() }).ok;
  test.skipIf(!sandboxWorks || !existsSync("/var/tmp"))(
    "with TMPDIR outside /tmp (visible through --ro-bind / /), a sibling run's scratch is hidden (real sandbox)",
    async () => {
      const varTmp = await mkdtemp("/var/tmp/keryx-sched-sec-");
      try {
        process.env["TMPDIR"] = varTmp;
        delete process.env["XDG_RUNTIME_DIR"];
        const parent = agentTaskScratchParent();
        expect(parent.startsWith(varTmp)).toBe(true);
        await mkdir(parent, { mode: 0o700 });
        const sibling = path.join(parent, "other-run", "work");
        await mkdir(sibling, { recursive: true });
        await writeFile(path.join(sibling, "secret.txt"), "SIBLING-SECRET-42");
        await addConfirmedSchedule(root, agentTaskEntry({ gh: markerGh(aside, path.join(aside, "m")) }, { dispatch: { provider: "scripted", model: "m", permissionMode: "trust", rates: RATES, ceilingUsd: 1 } }));
        const provider = scripted([toolCall("shell_exec", { command: `cat ${sibling}/secret.txt; ls ${parent}` }, "c1")]);
        await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider } });
        const wire = JSON.stringify(provider.requests);
        expect(wire).toContain("No such file");
        expect(wire).not.toContain("SIBLING-SECRET-42");
      } finally {
        await rm(varTmp, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

// --- flow 295 re-review: N1-N6 -------------------------------------------------------

describe("N1 (probe p4): quoting, escapes and wrappers do not hide scheduler control", () => {
  test.each([
    "keryx 'schedule' add --name x --yes",
    'env -u KERYX_TOOL_CALL keryx "schedule" add --name x --yes',
    "keryx sched''ule add --name x --yes",
    "keryx sch\\edule add --name x --yes",
    "sys''temctl --user enable x.timer",
    "cron''tab -l",
    "/usr/bin/crontab -l",
    "sudo -u me nice -n 5 systemctl --user enable x",
    "nohup env FOO=1 keryx schedule resume x",
    "bash -c 'systemctl --user enable x'",
    "sh -lc \"keryx 'schedule' run x\"",
    "cd ~/.config/systemd && cp /tmp/x.service user/",
    "cd ~/Library/LaunchAgents; cp /tmp/x.plist .",
  ])("%s", (command) => {
    expect(touchesSchedulerControl(command)).toBe(true);
    expect(
      resolveApprovalDecision({ mode: "trust", risk: "shell", destructive: false, credentials: false, sacReviewConfirmation: touchesHumanConfirmation(command), readOnly: false }),
    ).toBe("ask");
  });

  test("patterns that could reach it through quoting are refused", () => {
    for (const pattern of ["keryx 'schedule' *", "sys''temctl *"]) expect(validateShellPattern(pattern).ok).toBe(false);
  });

  test("`keryx schedule add|resume|run` refuse without a terminal, --yes included; remove/pause do not need one", async () => {
    for (const sub of [["add", "--name", "x", "--yes"], ["resume", "x"], ["run", "x"]]) {
      printed = [];
      process.exitCode = 0;
      await scheduleCommand(sub, { cwd: root, env: {}, isTerminal: false });
      expect(process.exitCode).toBe(1);
      expect(printed.join("\n")).toContain("needs an interactive terminal");
    }
    printed = [];
    await scheduleCommand(["pause", "nope"], { cwd: root, env: {}, isTerminal: false });
    expect(printed.join("\n")).not.toContain("needs an interactive terminal");
    expect(existsSync(scheduleStorePath(root))).toBe(false);
  });
});

describe("N5: `trigger run --schedule`", () => {
  test("is scheduler control, and patterns covering it are refused", () => {
    expect(touchesSchedulerControl("keryx trigger run --schedule nightly")).toBe(true);
    expect(touchesSchedulerControl("keryx 'trigger' run --schedule nightly")).toBe(true);
    for (const pattern of ["keryx trigger run *", "keryx trigger *"]) expect(validateShellPattern(pattern).ok).toBe(false);
  });
});

describe("N2: granted programs run from an empty directory, and shims/scripts are refused at draft", () => {
  test("a granted exec and `gh auth token` never run with the project as cwd", async () => {
    const seen = path.join(aside, "cwds");
    const bin = path.join(aside, "gh");
    writeFileSync(bin, `#!/bin/sh\npwd >> '${seen}'\nls -A >> '${seen}'\necho '[]'\n`, { mode: 0o755 });
    await writeFile(path.join(root, ".mise.toml"), "[env]\nEVIL = '1'\n");
    await addConfirmedSchedule(root, agentTaskEntry({ gh: bin }));
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => scripted(ghRounds()), planSandbox: () => INERT_SANDBOX } });
    const lines = readFileSync(seen, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l === realpathSync(root) || l === root)).toBe(false);
    expect(lines.some((l) => l.includes(".mise.toml"))).toBe(false);
  });

  test("a shim is refused, and the real binary is suggested", async () => {
    mkdirSync(path.join(aside, "shims"), { recursive: true });
    const shim = path.join(aside, "shims", "gh");
    writeFileSync(shim, readFileSync("/bin/true"), { mode: 0o755 });
    const drafted = await draftSchedule(
      { name: "x", cadence: "hourly", prompt: "p", provider: "scripted", model: "m", rates: RATES, ceilingUsd: 1, tools: ["gh.pr.list"], repos: ["a/b"] },
      { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) }, resolveProgram: () => shim, accountOf: async () => "me" },
    );
    expect(drafted.ok).toBe(false);
    if (!drafted.ok) {
      expect(drafted.problems.join(" ")).toContain("version-manager shim");
      expect(drafted.problems.join(" ")).toContain("mise which gh");
    }
  });

  test("a #! wrapper outside the project is allowed: its interpreter is pinned and the card says so", async () => {
    const wrapper = path.join(aside, "gh");
    writeFileSync(wrapper, "#!/bin/sh\nexec /usr/bin/true \"$@\"\n", { mode: 0o755 });
    const drafted = await draftSchedule(
      { name: "x", cadence: "hourly", prompt: "p", provider: "scripted", model: "m", rates: RATES, ceilingUsd: 1, tools: ["gh.pr.list"], repos: ["a/b"] },
      { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) }, resolveProgram: () => wrapper, accountOf: async () => "me" },
    );
    if (!drafted.ok) throw new Error(drafted.problems.join("; "));
    const pin = (drafted.draft.entry["action"] as { grants: { binDigests: Record<string, BinaryPin> } }).grants.binDigests["gh"]!;
    expect(pin.interpreter?.command).toBe("/bin/sh");
    expect(pin.interpreter?.realpath).toBe(realpathSync("/bin/sh"));
    expect(drafted.draft.card).toContain(
      `  gh: script wrapper ${wrapper} (interpreter ${realpathSync("/bin/sh")}) — pinned; it runs from an empty directory, so it cannot see the project`,
    );
  });

  test("a #! wrapper inside the project is refused", async () => {
    const inside = path.join(root, "tools", "gh");
    mkdirSync(path.dirname(inside), { recursive: true });
    writeFileSync(inside, "#!/bin/sh\nexec /usr/bin/true\n", { mode: 0o755 });
    const drafted = await draftSchedule(
      { name: "x", cadence: "hourly", prompt: "p", provider: "scripted", model: "m", rates: RATES, ceilingUsd: 1, tools: ["gh.pr.list"], repos: ["a/b"] },
      { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) }, resolveProgram: () => inside, accountOf: async () => "me" },
    );
    expect(drafted.ok).toBe(false);
  });
});

describe("pinned #! wrappers at run time", () => {
  /** A private interpreter (a copy of /bin/sh) named on the wrapper's `#!/usr/bin/env` line. */
  function envWrapper(): { wrapper: string; interp: string; binDir: string; marker: string } {
    const binDir = path.join(aside, "bin");
    mkdirSync(binDir, { recursive: true });
    const interp = path.join(binDir, "kxsh");
    writeFileSync(interp, readFileSync(realpathSync("/bin/sh")), { mode: 0o755 });
    const marker = path.join(aside, "WRAPPER-RAN");
    const wrapper = path.join(aside, "gh");
    writeFileSync(wrapper, `#!/usr/bin/env kxsh\necho ran > '${marker}'\necho '[]'\n`, { mode: 0o755 });
    return { wrapper, interp, binDir, marker };
  }
  const envFor = (binDir: string): Record<string, string | undefined> => ({ PATH: `${binDir}:/usr/bin:/bin` });

  test("a pinned wrapper runs", async () => {
    const { wrapper, binDir, marker } = envWrapper();
    await addConfirmedSchedule(root, agentTaskEntry({ gh: wrapper }, {}, "nightly", envFor(binDir)["PATH"]));
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => scripted(ghRounds()), planSandbox: () => INERT_SANDBOX, grantedEnv: envFor(binDir) } });
    expect((await lastRecord()).outcome).toBe("ok");
    expect(existsSync(marker)).toBe(true);
  });

  test("a changed wrapper is refused", async () => {
    const { wrapper, binDir, marker } = envWrapper();
    await addConfirmedSchedule(root, agentTaskEntry({ gh: wrapper }, {}, "nightly", envFor(binDir)["PATH"]));
    writeFileSync(wrapper, `#!/usr/bin/env kxsh\necho changed > '${marker}'\n`, { mode: 0o755 });
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => scripted(ghRounds()), planSandbox: () => INERT_SANDBOX, grantedEnv: envFor(binDir) } });
    const record = await lastRecord();
    expect(record.agentTask?.refusal).toBe("grants-changed");
    expect(existsSync(marker)).toBe(false);
  });

  test("a changed interpreter is refused, and so is one resolved elsewhere on the runtime PATH", async () => {
    const { wrapper, interp, binDir, marker } = envWrapper();
    await addConfirmedSchedule(root, agentTaskEntry({ gh: wrapper }, {}, "nightly", envFor(binDir)["PATH"]));

    // Another `kxsh` earlier on the runtime PATH: env would run that one.
    const other = path.join(aside, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "kxsh"), readFileSync(realpathSync("/bin/sh")), { mode: 0o755 });
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => scripted(ghRounds()), planSandbox: () => INERT_SANDBOX, grantedEnv: { PATH: `${other}:${binDir}:/usr/bin:/bin` } } });
    expect((await lastRecord()).detail).toContain("the interpreter");
    expect(existsSync(marker)).toBe(false);

    // The pinned interpreter itself changed.
    writeFileSync(interp, Buffer.concat([readFileSync(interp), Buffer.from("\n")]), { mode: 0o755 });
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => scripted(ghRounds()), planSandbox: () => INERT_SANDBOX, grantedEnv: envFor(binDir) } });
    const record = await lastRecord();
    expect(record.agentTask?.refusal).toBe("grants-changed");
    expect(record.detail).toContain("the interpreter");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("N3: the scratch parent must be ours", () => {
  test("a pre-existing world-writable parent, or a symlink, refuses the run before any model call", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "keryx-sched-sec-tmp-"));
    try {
      process.env["TMPDIR"] = tmp;
      delete process.env["XDG_RUNTIME_DIR"];
      const parent = agentTaskScratchParent();
      mkdirSync(parent);
      chmodSync(parent, 0o777);
      await addConfirmedSchedule(root, agentTaskEntry({ gh: markerGh(aside, path.join(aside, "m")) }));
      let provider = scripted(ghRounds());
      await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } });
      expect((await lastRecord()).detail).toContain("has mode 777, not 700");
      expect(provider.calls()).toBe(0);

      await rm(parent, { recursive: true, force: true });
      const elsewhere = await mkdtemp(path.join(tmpdir(), "keryx-sched-sec-else-"));
      symlinkSync(elsewhere, parent);
      provider = scripted(ghRounds());
      await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } });
      expect((await lastRecord()).detail).toContain("is not a plain directory");
      expect(provider.calls()).toBe(0);
      await rm(elsewhere, { recursive: true, force: true });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("XDG_RUNTIME_DIR is preferred when set", () => {
    expect(agentTaskScratchParent({ XDG_RUNTIME_DIR: "/run/user/4242" })).toBe("/run/user/4242/keryx-agent-tasks");
  });
});

describe("N4: keryx's config dir is always hidden, never inside the project, and pinned into the unit", () => {
  test("the unattended sandbox hides the config dir even when XDG_DATA_HOME is outside $HOME", () => {
    const outside = path.join(aside, "data");
    mkdirSync(path.join(outside, "keryx"), { recursive: true });
    process.env["XDG_DATA_HOME"] = outside;
    const plan = planUnattendedSandbox({
      worktree: aside,
      scratchHome: aside,
      network: false,
      readOnly: [],
      env: process.env,
      home: keyHome,
      probe: () => true,
      platform: "linux",
      detect: { existsSync: () => true },
    });
    if (!plan.ok) throw new Error(plan.reason);
    const args = plan.args.join(" ");
    expect(args).toContain(`--tmpfs ${realpathSync(path.join(outside, "keryx"))}`);
  });

  test("a config dir inside the project refuses drafting and running", async () => {
    await addConfirmedSchedule(root, agentTaskEntry({ gh: markerGh(aside, path.join(aside, "m")) }));
    process.env["XDG_DATA_HOME"] = path.join(root, ".data");
    const drafted = await draftSchedule(
      { name: "y", cadence: "hourly", prompt: "p", provider: "scripted", model: "m", rates: RATES, ceilingUsd: 1 },
      { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) } },
    );
    expect(drafted.ok).toBe(false);
    if (!drafted.ok) expect(drafted.problems.join(" ")).toContain("is inside this project");
    const provider = scripted(ghRounds());
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } });
    expect((await lastRecord()).detail).toContain("is inside this project");
    expect(provider.calls()).toBe(0);
  });

  test("the installed unit pins XDG_DATA_HOME, so the timer finds the same key", async () => {
    const plan = await planInstall(root, "x", "0 2 * * *", { backend: "systemd", unitDir: aside, invocation: { execPath: "/bin/true", scriptPath: "/bin/true" } });
    expect(plan.files[0]!.content).toContain(`Environment=XDG_DATA_HOME=${process.env["XDG_DATA_HOME"]}`);
  });
});

describe("N6: a binary swapped mid-run is not executed", () => {
  test("after the run-start verification, a changed inode/size/mtime refuses the exec", async () => {
    const marker = path.join(aside, "SWAPPED-RAN");
    const bin = markerGh(aside, path.join(aside, "first"));
    await addConfirmedSchedule(root, agentTaskEntry({ gh: bin }));
    const rounds = ghRounds();
    let call = 0;
    const requests: NormalizedRequest[] = [];
    const provider: ProviderPort = {
      describe: () => DESCRIPTION,
      stream: (request, opts) => {
        requests.push(request);
        // The first model call comes AFTER verification. Swap the binary now, the way
        // a process racing the run would.
        if (call === 0) writeFileSync(bin, `#!/bin/sh\necho swapped > '${marker}'\necho '[]'\n`, { mode: 0o755 });
        const round = rounds[call++] ?? rounds[1]!;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of round) yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        })();
      },
    };
    await runTriggerOnce(root, "nightly", { agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX } });
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(requests)).toContain("changed since it was verified at the start of this run");
  });
});
