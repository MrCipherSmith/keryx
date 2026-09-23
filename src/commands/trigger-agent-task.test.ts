// Flow 295 (AC2, AC3, AC5, AC14): an `agent-task` schedule end to end through
// `runTriggerOnce`. The model is scripted, and the sandbox is the real one where
// the test is about containment. The granted tool is a real `execFile` of a fake
// `gh` script.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pinGrantedBinary, type BinaryPin } from "../trigger/granted-binary";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runTriggerOnce } from "./trigger";
import { scrubGrantedOutput } from "./trigger-agent-task";
import { planUnattendedSandbox, type UnattendedSandboxPlan } from "../harness/process/sandbox/unattended";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { scheduleStorePath } from "../trigger/config";
import { appendTriggerRunRecord, openReservations, readTriggerRuns, type TriggerRunRecord } from "../trigger/record";
import { addConfirmedSchedule, readScheduleStore } from "../trigger/store";
import { buildGrantedArgv, grantedToolSpec } from "../trigger/granted-tools";
import { writeFileAtomic } from "../lib/fs";

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

/** A scripted provider that records every request it is sent. */
function scripted(rounds: Round[]): ProviderPort & { calls: () => number; requests: NormalizedRequest[] } {
  let call = 0;
  const requests: NormalizedRequest[] = [];
  return {
    calls: () => call,
    requests,
    describe: () => DESCRIPTION,
    stream: (request: NormalizedRequest, opts: StreamOptions) => {
      requests.push(request);
      const round = rounds[call] ?? [USAGE, { kind: "text_delta", text: "nothing more" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of round) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

function toolCall(tool: string, input: Record<string, unknown>, id: string): Round {
  return [USAGE, { kind: "tool_call_start", toolCallId: id, toolName: tool }, { kind: "tool_call_end", toolCallId: id, input: JSON.stringify(input) }, { kind: "model_end" }];
}
function finalText(text: string): Round {
  return [USAGE, { kind: "text_delta", text }, { kind: "model_end" }];
}

const RATES = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
const ROUND_USD = (1000 * 3 + 200 * 15) / 1_000_000;

/** A sandbox whose "wrap" runs nothing — for tests whose subject is the floor, not containment. */
const INERT_SANDBOX: UnattendedSandboxPlan = { ok: true, launcher: "none", args: [], env: { PATH: "/usr/bin:/bin" }, wrap: () => ["/bin/true"] };

let root = "";
let aside = "";
let logged: string[] = [];
const realLog = console.log;
const realError = console.error;

function entry(overrides: { mode?: "ask" | "trust"; network?: "off" | "full"; tools?: string[]; bins?: Record<string, string>; ceilingUsd?: number } = {}, name = "check-github"): Record<string, unknown> {
  return {
    name,
    on: { kind: "schedule", cron: "0 */4 * * *" },
    action: {
      kind: "agent-task",
      prompt: "Check open PRs on MrCipherSmith/keryx and summarise what needs my attention.",
      dispatch: { provider: "scripted", model: "m", permissionMode: overrides.mode ?? "ask", rates: RATES, ceilingUsd: overrides.ceilingUsd ?? 1, maxSeconds: 120 },
      grants: {
        network: overrides.network ?? "off",
        tools: overrides.tools ?? [],
        repos: ["MrCipherSmith/keryx"],
        bins: overrides.bins ?? {},
        binDigests: digestsFor(overrides.bins ?? {}),
      },
    },
  };
}

/** A harmless `gh` outside the project, for tests whose subject is not the granted tool. */
async function stubGh(): Promise<string> {
  const bin = path.join(aside, "gh");
  await writeFile(bin, "#!/bin/sh\necho '[]'\n", "utf8");
  await chmod(bin, 0o755);
  return bin;
}

/** What `draftSchedule` records per granted program: its realpath and sha256. */
function digestsFor(bins: Record<string, string>): Record<string, BinaryPin> {
  // Exactly what `draftSchedule` records: realpath, sha256, inode, mtime, and a `#!` wrapper's interpreter.
  return Object.fromEntries(
    Object.entries(bins).map(([p, b]) => {
      const pinned = pinGrantedBinary(p, b, "/nonexistent-project-root");
      if (!pinned.ok) throw new Error(pinned.reason);
      return [p, pinned.pin];
    }),
  );
}

async function lastRecord(): Promise<TriggerRunRecord> {
  const read = await readTriggerRuns(root);
  if (read.state !== "present") throw new Error(`no run record: ${read.state}`);
  return read.records[read.records.length - 1]!;
}

async function run(provider: ProviderPort, name = "check-github", extra: Record<string, unknown> = {}): Promise<void> {
  await runTriggerOnce(root, name, {
    agentTask: { makeProvider: () => provider, planSandbox: () => INERT_SANDBOX, ...extra },
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-agent-task-"));
  aside = await mkdtemp(path.join(tmpdir(), "keryx-agent-task-aside-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  logged = [];
  console.log = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
  await rm(aside, { recursive: true, force: true });
});

describe("AC2: one unattended turn, and a report the dispatcher writes", () => {
  test("the final message lands in reports/<name>/<runId>.md with outcome, cost, granted calls and denials; the directory is gitignored", async () => {
    await addConfirmedSchedule(root, entry({ mode: "ask" }));
    const provider = scripted([
      // Under "ask", a shell command is an approval request, and unattended that means denied.
      toolCall("shell_exec", { command: "ls" }, "c1"),
      finalText("Two PRs need your review: #12 and #15."),
    ]);
    await run(provider);

    const record = await lastRecord();
    expect(record.outcome).toBe("ok");
    expect(record.agentTask?.permissionMode).toBe("ask");
    const reportPath = record.agentTask?.reportPath;
    expect(reportPath).toMatch(/^\.metaproject\/data\/trigger\/reports\/check-github\/.+\.md$/);
    const report = await readFile(path.join(root, reportPath!), "utf8");
    expect(report).toContain("- outcome: ok");
    expect(report).toContain(`- cost: $${(ROUND_USD * 2).toFixed(4)}`);
    expect(report).toContain("- granted calls: none");
    expect(report).toContain("shell_exec: approval required under permission mode \"ask\"");
    expect(report).toContain("Two PRs need your review: #12 and #15.");
    // The prompt the model got is the operator's, inside the unattended preamble.
    expect(JSON.stringify(provider.requests[0])).toContain("Check open PRs on MrCipherSmith/keryx");
    // Gitignored: git itself says so (the store too).
    expect(execFileSync("git", ["check-ignore", reportPath!], { cwd: root }).toString().trim()).toBe(reportPath!);
    expect(execFileSync("git", ["check-ignore", path.relative(root, scheduleStorePath(root))], { cwd: root }).toString().trim()).not.toBe("");
  });

  test("the agent cannot write the reports directory: the floor refuses it, even under trust", async () => {
    await addConfirmedSchedule(root, entry({ mode: "trust" }));
    const provider = scripted([
      toolCall("shell_exec", { command: "echo forged > .metaproject/data/trigger/reports/check-github/forged.md" }, "c1"),
      finalText("done"),
    ]);
    await run(provider);
    const record = await lastRecord();
    expect(record.agentTask?.denials?.some((d) => d.tool === "shell_exec" && d.reason.includes("data/trigger"))).toBe(true);
    // No apply_patch is offered at all.
    const tools = (provider.requests[0] as { tools?: { name: string }[] }).tools?.map((t) => t.name) ?? [];
    expect(tools).not.toContain("apply_patch");
    expect(tools).toContain("shell_exec");
  });
});

describe("AC3: granted tools keep credentials out of the model's reach", () => {
  const SENTINEL = "ghp_SENTINELsentinel0123456789abcdefABCD";
  let savedToken: string | undefined;
  beforeEach(() => {
    savedToken = process.env["GH_TOKEN"];
    process.env["GH_TOKEN"] = SENTINEL;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env["GH_TOKEN"];
    else process.env["GH_TOKEN"] = savedToken;
  });

  async function fakeGh(): Promise<string> {
    // Stands in for `gh`: prints a PR list AND (a hostile or buggy tool) the token it was given.
    const bin = path.join(aside, "gh");
    await writeFile(bin, `#!/bin/sh\necho '[{"number":12,"title":"fix"}]'\necho "argv: $*"\necho "token=$GH_TOKEN"\n`, "utf8");
    await chmod(bin, 0o755);
    return bin;
  }

  test("a granted tool runs through execFile with the operator's token, and its output reaches the model redacted", async () => {
    const bin = await fakeGh();
    await addConfirmedSchedule(root, entry({ tools: ["gh.pr.list"], bins: { gh: bin } }));
    const provider = scripted([
      toolCall("gh_pr_list", { repo: "MrCipherSmith/keryx" }, "c1"),
      // A flag through a parameter, and a repository outside the grant — both refused before anything runs.
      toolCall("gh_pr_list", { repo: "MrCipherSmith/keryx", state: "--web" }, "c2"),
      toolCall("gh_pr_list", { repo: "someone/else" }, "c3"),
      finalText("One PR (#12)."),
    ]);
    await run(provider);
    const record = await lastRecord();
    expect(record.agentTask?.grantedCalls).toEqual([
      {
        tool: "gh_pr_list",
        argv: [bin, "pr", "list", "--repo", "MrCipherSmith/keryx", "--state", "open", "--limit", "30", "--json", "number,title,author,isDraft,reviewDecision,updatedAt,url,headRefName"],
        exitCode: 0,
        ok: true,
      },
    ]);
    const wire = JSON.stringify(provider.requests);
    expect(wire).toContain('\\"number\\":12');
    expect(wire).toContain("[redacted:GH_TOKEN]");
    expect(wire).toContain('may not start with \\"-\\"');
    // The schema offered to the model enumerates only the granted repositories.
    expect(wire).toContain("invalid input for gh_pr_list");
    expect(wire).not.toContain(SENTINEL);
    const report = await readFile(path.join(root, record.agentTask!.reportPath!), "utf8");
    expect(report).not.toContain(SENTINEL);
    expect(await readFile(path.join(root, ".metaproject", "data", "trigger", "runs.jsonl"), "utf8")).not.toContain(SENTINEL);
  });

  const realSandbox = planUnattendedSandbox({
    worktree: tmpdir(),
    scratchHome: tmpdir(),
    network: false,
    readOnly: [],
    env: process.env,
    home: homedir(),
  });

  test.skipIf(!realSandbox.ok)(
    "in the same run, shell_exec of env, echo $GH_TOKEN and cat of a gh config returns neither token nor config (real sandbox)",
    async () => {
      const bin = await fakeGh();
      const ghConfig = path.join(aside, "hosts.yml");
      await writeFile(ghConfig, `github.com:\n  oauth_token: ${SENTINEL}\n`, "utf8");
      await addConfirmedSchedule(root, entry({ mode: "trust", tools: ["gh.pr.list"], bins: { gh: bin } }));
      const provider = scripted([
        toolCall("gh_pr_list", { repo: "MrCipherSmith/keryx" }, "c1"),
        toolCall("shell_exec", { command: `env; echo "tok=$GH_TOKEN"; cat ${ghConfig}; cat ~/.config/gh/hosts.yml` }, "c2"),
        finalText("One PR (#12)."),
      ]);
      await runTriggerOnce(root, "check-github", { agentTask: { makeProvider: () => provider } });
      const record = await lastRecord();
      expect(record.outcome).toBe("ok");
      const wire = JSON.stringify(provider.requests);
      // The shell really ran (inside the sandbox) and answered.
      expect(wire).toContain("tok=");
      expect(wire).not.toContain(SENTINEL);
      expect(wire).not.toContain("oauth_token");
      const report = await readFile(path.join(root, record.agentTask!.reportPath!), "utf8");
      expect(report).not.toContain(SENTINEL);
    },
    60_000,
  );

  test("buildGrantedArgv refuses a repository outside the grant even when the schema is bypassed", () => {
    const spec = grantedToolSpec("gh.pr.list")!;
    const built = buildGrantedArgv(spec, { repo: "someone/else" }, ["MrCipherSmith/keryx"]);
    expect(built).toEqual({ ok: false, reason: 'gh_pr_list: repository "someone/else" is not granted to this schedule (granted: MrCipherSmith/keryx)' });
  });

  test("scrubGrantedOutput removes the exact value of credential-looking variables", () => {
    expect(scrubGrantedOutput(`x ${SENTINEL} y`, { GH_TOKEN: SENTINEL, HOME: "/home/someone-long" })).toBe("x [redacted:GH_TOKEN] y");
  });
});

describe("AC5: the posture and the floor hold under every grant, and a changed schedule does not run", () => {
  const FORBIDDEN = [
    "git push origin main",
    "git merge feature",
    "git tag v1",
    "npm publish",
    "gh api -X POST repos/o/r/issues",
    "keryx flow complete 1",
    "keryx trigger run other",
    "keryx schedule add other",
    "keryx schedule remove check-github",
    "systemctl --user enable --now keryx-x.timer",
    "crontab -r",
    "echo x > .metaproject/triggers.json",
    "echo x > .metaproject/flows/1-x/flow.json",
    "echo x >> .metaproject/flows/1-x/acceptance-criteria.md",
    "echo x > .metaproject/data/trigger/schedules.json",
    "echo x > .metaproject/data/trigger/reports/check-github/forged.md",
  ];

  for (const mode of ["ask", "trust"] as const) {
    for (const network of ["off", "full"] as const) {
      test(`mode ${mode}, network ${network}: every forbidden command is refused by the floor`, async () => {
        await addConfirmedSchedule(root, entry({ mode, network, tools: ["gh.pr.list"], bins: { gh: await stubGh() } }));
        const rounds = FORBIDDEN.map((command, i) => toolCall("shell_exec", { command }, `f${i}`));
        const provider = scripted([...rounds, finalText("done")]);
        await run(provider);
        // One floor denial per forbidden command, never a permission-mode prompt.
        const denials = (await lastRecord()).agentTask?.denials ?? [];
        expect(denials.length).toBe(FORBIDDEN.length);
        expect(denials.every((d) => d.tool === "shell_exec" && !d.reason.startsWith("approval required"))).toBe(true);
        // What the model was told for each call is the floor's refusal.
        const wire = JSON.stringify(provider.requests[provider.requests.length - 1]);
        expect(wire.split("refused in an unattended run").length - 1).toBe(FORBIDDEN.length);
      });
    }
  }

  test("trust without a working sandbox refuses with sandbox-unavailable, before any model call", async () => {
    await addConfirmedSchedule(root, entry({ mode: "trust" }));
    const provider = scripted([finalText("never")]);
    await run(provider, "check-github", { planSandbox: () => ({ ok: false, reason: "no bwrap here" }) });
    const record = await lastRecord();
    expect(record.outcome).toBe("dispatch-refused");
    expect(record.agentTask?.refusal).toBe("sandbox-unavailable");
    expect(provider.calls()).toBe(0);
  });

  test("a schedule edited after confirmation is refused with grants-changed and calls no model", async () => {
    await addConfirmedSchedule(root, entry({ tools: ["gh.pr.list"], bins: { gh: await stubGh() } }));
    // Widen the grant behind the confirmed hash, the way a hand edit would.
    const stored = await readScheduleStore(root);
    const widened = { ...stored[0]!, action: { ...(stored[0]!["action"] as Record<string, unknown>), grants: { network: "full", tools: ["gh.pr.list"], repos: ["MrCipherSmith/keryx"], bins: { gh: await stubGh() } } } };
    await writeFileAtomic(scheduleStorePath(root), JSON.stringify({ schemaVersion: 1, triggers: [widened] }));
    const provider = scripted([finalText("never")]);
    await run(provider);
    const record = await lastRecord();
    expect(record.outcome).toBe("dispatch-refused");
    expect(record.agentTask?.refusal).toBe("grants-changed");
    expect(record.detail).toContain("changed after the operator confirmed it");
    expect(provider.calls()).toBe(0);
  });
});

describe("AC14: spend is reserved before the first call and closed by the run's own record", () => {
  test("the closing record carries the runId, tokens and USD, and no reservation stays open", async () => {
    await addConfirmedSchedule(root, entry());
    await run(scripted([finalText("ok")]));
    const read = await readTriggerRuns(root);
    if (read.state !== "present") throw new Error("no ledger");
    const reserved = read.records.find((r) => r.outcome === "reserved")!;
    const closing = read.records[read.records.length - 1]!;
    expect(reserved.detail).toContain("reserved $1");
    expect(closing.agentTask?.runId).toBe(reserved.reservation!.runId);
    expect(closing.cost).toEqual({ recorded: true, usd: ROUND_USD, tokens: { input: 1000, output: 200 } });
    expect(openReservations(read.records)).toEqual([]);
  });

  test("over the schedule's own ceiling: budget-refused, no model call", async () => {
    await addConfirmedSchedule(root, entry({ ceilingUsd: 0.01 }));
    await mkdir(path.join(root, ".metaproject", "data", "trigger"), { recursive: true });
    await appendTriggerRunRecord(root, {
      at: new Date().toISOString(),
      trigger: "check-github",
      firedBy: { kind: "schedule", cron: "0 */4 * * *" },
      action: { kind: "reconcile" },
      outcome: "ok",
      detail: "earlier spend",
      cost: { recorded: true, usd: 0.02 },
    });
    const provider = scripted([finalText("never")]);
    await run(provider);
    const record = await lastRecord();
    expect(record.outcome).toBe("budget-refused");
    expect(provider.calls()).toBe(0);
  });
});
