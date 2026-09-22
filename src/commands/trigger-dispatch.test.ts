// Flow 290 T8/T9/T10 (AC1-AC8, AC10): a dispatching `flow-next` end to end —
// a real git repository, a real flow package driven through the real flow
// service, real worktrees and commits, and the real agent driver. Only the
// model (a scripted provider), the health gate and the wall-clock timer are
// replaced, and only through `runTriggerOnce`'s declared seams.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTriggerOnce, triggerCommand } from "./trigger";
import { dispatchLockPath, providerReportsUsage, sandboxedHealthGate, type HealthGateResult } from "./trigger-dispatch";
import { planUnattendedSandbox, type UnattendedSandboxPlan } from "../harness/process/sandbox/unattended";
import { evaluateTriggerBudget, reserveTriggerSpend } from "../trigger/run";
import { openReservations } from "../trigger/record";
import { homedir } from "node:os";
import { flowServiceDeps } from "./flow";
import { createFlowService } from "../flow/service";
import type { FlowService } from "../flow/types";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { triggersConfigPath } from "../trigger/config";
import { appendTriggerRunRecord, readTriggerRuns, type TriggerRunRecord } from "../trigger/record";
import { withFileLock } from "../lib/fs";
import { getProjectPermissionMode, setProjectPermissionMode } from "../lib/permission-mode-config";
import { loadShellPermissions, shellPermissionsPath } from "../lib/shell-permissions";
import { acquireCwd, releaseCwd } from "../lib/test-cwd";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

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

type Round = Partial<NormalizedEvent>[] | ((request: NormalizedRequest, opts: StreamOptions) => Promise<Partial<NormalizedEvent>[]>);

function scripted(rounds: Round[]): ProviderPort & { calls: () => number } {
  let call = 0;
  return {
    calls: () => call,
    describe: () => DESCRIPTION,
    stream: (request, opts) => {
      const round = rounds[call] ?? [USAGE_NONE, { kind: "text_delta", text: "done" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        const events = typeof round === "function" ? await round(request, opts) : round;
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

const NEW_FILE_PATCH = ["--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1 @@", "+export const made = 1;", ""].join("\n");

function toolCall(tool: string, input: Record<string, unknown>, id = "c1"): Partial<NormalizedEvent>[] {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName: tool },
    { kind: "tool_call_end", toolCallId: id, input: JSON.stringify(input) },
  ];
}

const USAGE_ROUND_1: Partial<NormalizedEvent> = { kind: "usage_update", usage: { inputTokens: 1000, outputTokens: 200 } };
/** A response that reports usage of zero — every scripted response reports usage (AC14's guard). */
const USAGE_NONE: Partial<NormalizedEvent> = { kind: "usage_update", usage: { inputTokens: 0, outputTokens: 0 } };

const RATES = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
/** 1000 in + 200 out at the rates above. */
const ROUND_1_USD = (1000 * 3 + 200 * 15) / 1_000_000;

/** A "sandbox" that wraps nothing — for tests whose subject is not containment. */
const UNWRAPPED_SANDBOX: UnattendedSandboxPlan = {
  ok: true,
  launcher: "none",
  args: [],
  env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  wrap: (argv) => [...argv],
};

let root = "";
let service: FlowService;
let flowId = "";
let flowDir = "";
let logged: string[] = [];
let errored: string[] = [];
const realLog = console.log;
const realError = console.error;
const savedXdg = process.env["XDG_DATA_HOME"];

async function writeTriggers(triggers: unknown[]): Promise<void> {
  await writeFile(triggersConfigPath(root), JSON.stringify({ schemaVersion: 1, triggers }), "utf8");
}

function dispatchEntry(overrides: Record<string, unknown> = {}, name = "overnight"): unknown {
  return {
    name,
    on: { kind: "schedule", cron: "0 2 * * *" },
    action: {
      kind: "flow-next",
      flow: flowId,
      dispatch: { provider: "scripted", model: "m", permissionMode: "trust", rates: RATES, ceilingUsd: 1, maxSeconds: 600, ...overrides },
    },
  };
}

async function flowJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, flowDir, "flow.json"), "utf8")) as Record<string, unknown>;
}

async function lastRecord(): Promise<TriggerRunRecord> {
  const read = await readTriggerRuns(root);
  if (read.state !== "present") throw new Error(`no run record: ${read.state}`);
  return read.records[read.records.length - 1]!;
}

function passGate(seen: string[] = []): (wt: string) => Promise<HealthGateResult> {
  return async (wt) => {
    seen.push(wt);
    return { pass: true, detail: "gate: pass" };
  };
}

async function run(provider: ProviderPort, extra: Record<string, unknown> = {}, name = "overnight"): Promise<void> {
  await runTriggerOnce(root, name, {
    service,
    dispatch: {
      makeProvider: () => provider,
      healthGate: passGate(),
      worktreeParent: path.join(root, "..", `${path.basename(root)}-wt`),
      // Tests not about containment run commands unwrapped; the sandbox has its
      // own tests below, run against the real launcher where one works.
      planSandbox: () => UNWRAPPED_SANDBOX,
      ...extra,
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-dispatch-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  service = createFlowService(flowServiceDeps());
  const created = await service.init({ cwd: root, title: "Dispatch fixture" });
  flowId = created.flow.id;
  flowDir = created.dir;
  const acFile = path.join(root, flowDir, "acceptance-criteria.md");
  await writeFile(acFile, (await readFile(acFile, "utf8")).replace(/- AC1:.*$/m, "- AC1: the made constant exists, proven by a test"), "utf8");
  await service.freeze({ cwd: root, id: flowId });
  await service.start({ cwd: root, id: flowId });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "flow package"]);
  logged = [];
  errored = [];
  console.log = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    errored.push(parts.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  if (savedXdg === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = savedXdg;
  await rm(root, { recursive: true, force: true });
  await rm(path.join(root, "..", `${path.basename(root)}-wt`), { recursive: true, force: true });
});

describe("AC1/AC2/AC5/AC6: a dispatch drives the next task from never-started to done", () => {
  test("success: attempt started before the model, task done with a runLink, commit on trigger/<flow>-<task>, cost recorded, AC untouched", async () => {
    await writeTriggers([dispatchEntry()]);
    const before = await flowJson();
    const acBefore = await readFile(path.join(root, flowDir, "acceptance-criteria.md"), "utf8");
    let attemptsWhenModelCalled = -1;
    const gateSeen: string[] = [];
    const provider = scripted([
      async () => {
        // AC2: the attempt is recorded BEFORE the model is called.
        const tasks = (await flowJson())["tasks"] as { id: string; attempts?: { log: { outcome: string }[] } }[];
        attemptsWhenModelCalled = tasks.find((t) => t.id === "T1")?.attempts?.log.length ?? 0;
        return [USAGE_ROUND_1, ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }];
      },
      [USAGE_NONE, { kind: "text_delta", text: "done" }, { kind: "model_end" }],
    ]);

    await run(provider, { healthGate: passGate(gateSeen) });

    expect(process.exitCode ?? 0).toBe(0);
    expect(attemptsWhenModelCalled).toBe(1);
    const record = await lastRecord();
    expect(record.outcome).toBe("ok");
    expect(record.dispatch?.task).toBe("T1");
    expect(record.dispatch?.closing).toBe("done");
    expect(record.dispatch?.branch).toBe(`trigger/${flowId}-T1`);
    expect(record.cost).toEqual({ recorded: true, usd: ROUND_1_USD, tokens: { input: 1000, output: 200 } });

    const after = await flowJson();
    const t1 = (after["tasks"] as { id: string; status: string; disposition?: string; runLink?: { runId: string }; attempts?: { count: number; log: { outcome: string }[] } }[]).find((t) => t.id === "T1")!;
    expect(t1.status).toBe("done");
    expect(t1.disposition).toBe("completed");
    expect(t1.runLink?.runId).toBe(record.dispatch?.runId);
    expect(t1.attempts?.log[0]?.outcome).toBe("started");

    // The work is on the trigger branch, committed, never on main.
    expect(git(root, ["show", `trigger/${flowId}-T1:src/new.ts`])).toBe("export const made = 1;");
    expect(git(root, ["ls-tree", "--name-only", "-r", "main"])).not.toContain("src/new.ts");
    expect(gateSeen).toHaveLength(1);
    // The worktree is gone; the branch stays.
    expect(git(root, ["worktree", "list"]).split("\n")).toHaveLength(1);

    // AC5: status, AC checksum and the AC file are untouched by the dispatch.
    expect(after["status"]).toBe(before["status"]);
    expect(after["acChecksum"]).toBe(before["acChecksum"]);
    expect(await readFile(path.join(root, flowDir, "acceptance-criteria.md"), "utf8")).toBe(acBefore);
  });

  test("provider failure: attempt failed with the reason, tokens still recorded, exit 1", async () => {
    await writeTriggers([dispatchEntry()]);
    const provider = scripted([
      [USAGE_ROUND_1, { kind: "provider_error", error: { kind: "unavailable", retryable: false, message: "upstream down" } }],
    ]);
    await run(provider);
    expect(process.exitCode).toBe(1);
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.dispatch?.closing).toBe("failed");
    expect(record.detail).toContain("provider error");
    expect(record.cost).toEqual({ recorded: true, usd: ROUND_1_USD, tokens: { input: 1000, output: 200 } });
    const t1 = ((await flowJson())["tasks"] as { id: string; status: string; attempts?: { log: { outcome: string; detail?: string }[] } }[]).find((t) => t.id === "T1")!;
    expect(t1.status).not.toBe("done");
    expect(t1.attempts?.log.map((e) => e.outcome)).toEqual(["started", "failed"]);
  });

  test("timeout: the wall-clock limit aborts the turn; attempt failed as timed out", async () => {
    await writeTriggers([dispatchEntry({ maxSeconds: 5 })]);
    let fire: (() => void) | undefined;
    let armedMs = 0;
    const provider = scripted([
      async (request, opts) => {
        const signal = opts.signal ?? (request as { signal?: AbortSignal }).signal;
        const aborted = new Promise<void>((resolve) => {
          if (signal?.aborted === true) resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        fire?.(); // the limit elapses while the model is still working
        await aborted;
        return [USAGE_ROUND_1, { kind: "model_end" }];
      },
    ]);
    await run(provider, {
      armTimeout: (ms: number, f: () => void) => {
        armedMs = ms;
        fire = f;
        return () => {};
      },
    });
    expect(armedMs).toBe(5000);
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.detail).toContain("timed out after 5s");
    const t1 = ((await flowJson())["tasks"] as { id: string; attempts?: { log: { outcome: string }[] } }[]).find((t) => t.id === "T1")!;
    expect(t1.attempts?.log.map((e) => e.outcome)).toEqual(["started", "failed"]);
  });

  test("health-gate failure: the commit stays on the branch but the task is NOT done — attempt failed", async () => {
    await writeTriggers([dispatchEntry()]);
    const provider = scripted([[USAGE_ROUND_1, ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }]]);
    await run(provider, { healthGate: async () => ({ pass: false, detail: "gate: fail — typecheck" }) });
    expect(process.exitCode).toBe(1);
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.detail).toContain("health gate failed");
    expect(git(root, ["show", `trigger/${flowId}-T1:src/new.ts`])).toBe("export const made = 1;");
    const t1 = ((await flowJson())["tasks"] as { id: string; status: string; attempts?: { log: { outcome: string }[] } }[]).find((t) => t.id === "T1")!;
    expect(t1.status).not.toBe("done");
    expect(t1.attempts?.log.map((e) => e.outcome)).toEqual(["started", "failed"]);
  });
});

describe("AC3: refusals happen before any model call, are recorded, exit 0", () => {
  async function expectRefused(code: string, provider = scripted([])): Promise<void> {
    const attemptsBefore = JSON.stringify(((await flowJson())["tasks"] as { attempts?: unknown }[]).map((t) => t.attempts));
    await run(provider);
    expect(process.exitCode ?? 0).toBe(0);
    expect(provider.calls()).toBe(0);
    const record = await lastRecord();
    expect(record.outcome).toBe("dispatch-refused");
    expect(record.dispatch?.refusal).toBe(code as never);
    const attemptsAfter = JSON.stringify(((await flowJson())["tasks"] as { attempts?: unknown }[]).map((t) => t.attempts));
    expect(attemptsAfter).toBe(attemptsBefore);
  }

  async function patchFlowJson(mutate: (flow: Record<string, unknown>) => void): Promise<void> {
    const flow = await flowJson();
    mutate(flow);
    await writeFile(path.join(root, flowDir, "flow.json"), `${JSON.stringify(flow, null, 2)}\n`, "utf8");
  }

  test("flow not in progress", async () => {
    await writeTriggers([dispatchEntry()]);
    await service.block({ cwd: root, id: flowId, reason: "waiting on the operator" });
    await expectRefused("flow-not-in-progress");
  });

  test("flow not frozen", async () => {
    await writeTriggers([dispatchEntry()]);
    await patchFlowJson((flow) => {
      flow["acChecksum"] = null;
    });
    await expectRefused("flow-not-frozen");
  });

  test("flow next is none (nothing left to do)", async () => {
    await writeTriggers([dispatchEntry()]);
    await patchFlowJson((flow) => {
      for (const task of flow["tasks"] as { status: string }[]) task.status = "done";
    });
    await expectRefused("nothing-ready");
  });

  test("flow next is blocked", async () => {
    await writeTriggers([dispatchEntry()]);
    await patchFlowJson((flow) => {
      const tasks = flow["tasks"] as { id: string; status: string; dependsOn?: string[] }[];
      for (const task of tasks) {
        if (task.id === "T1") task.dependsOn = ["T2"];
        else if (task.id === "T2") task.dependsOn = ["T1"];
        else task.status = "done";
      }
    });
    await expectRefused("blocked");
  });

  test("the ready task has an open attempt", async () => {
    await writeTriggers([dispatchEntry()]);
    await service.taskAttempt({ cwd: root, id: flowId, taskId: "T1", outcome: "started", detail: "someone else" });
    await expectRefused("open-attempt");
  });

  test("the task's attempt count reached the cap", async () => {
    await writeTriggers([dispatchEntry({ maxAttempts: 1 })]);
    await service.taskAttempt({ cwd: root, id: flowId, taskId: "T1", outcome: "started" });
    await service.taskAttempt({ cwd: root, id: flowId, taskId: "T1", outcome: "failed", detail: "earlier run" });
    await expectRefused("attempt-cap");
  });

  test("another dispatch holds the flow's dispatch lock (real overlap)", async () => {
    await writeTriggers([dispatchEntry()]);
    let resolveInside!: () => void;
    const inside = new Promise<void>((r) => {
      resolveInside = r;
    });
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const holder = withFileLock(dispatchLockPath(root, flowId), async () => {
      resolveInside();
      await released;
    });
    await inside;
    try {
      await expectRefused("dispatch-locked");
    } finally {
      release();
      await holder;
    }
  });
});

describe("AC4: fail closed — the entry's mode only; stored `auto` and a saved allowlist are ignored", () => {
  test("seeded stored auto + saved `bash *`/`echo *`: under entry mode `ask` every non-read call is denied and recorded", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "keryx-dispatch-xdg-"));
    process.env["XDG_DATA_HOME"] = config;
    try {
      expect(setProjectPermissionMode(root, "auto")).toBe(true);
      await mkdir(path.dirname(shellPermissionsPath()), { recursive: true });
      await writeFile(shellPermissionsPath(), JSON.stringify({ allow: ["bash *", "echo *"] }), "utf8");
      // The seed is live: the interactive shell WOULD read both.
      expect(getProjectPermissionMode(root)).toBe("auto");
      expect(loadShellPermissions().allow).toContain("echo *");

      await writeTriggers([dispatchEntry({ permissionMode: "ask" })]);
      const provider = scripted([
        [
          USAGE_ROUND_1,
          ...toolCall("shell_exec", { command: "echo hi > proof.txt" }, "c1"),
          ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }, "c2"),
          { kind: "model_end" },
        ],
        [USAGE_NONE, { kind: "text_delta", text: "could not proceed" }, { kind: "model_end" }],
      ]);
      await run(provider);

      const record = await lastRecord();
      const denied = (record.dispatch?.denials ?? []).map((d) => d.tool).sort();
      expect(denied).toEqual(["apply_patch", "shell_exec"]);
      for (const d of record.dispatch?.denials ?? []) {
        expect(d.reason).toContain('permission mode "ask"');
        expect(d.reason).toContain("denied");
      }
      expect(record.dispatch?.closing).toBe("blocked");
      // Nothing ran: no file, no commit on the trigger branch beyond main.
      expect(git(root, ["rev-parse", `trigger/${flowId}-T1`])).toBe(git(root, ["rev-parse", "main"]));
    } finally {
      await rm(config, { recursive: true, force: true });
    }
  });
});

describe("AC7/AC8: spend", () => {
  test("AC7: a trigger at its own ceiling is refused before any model call (seeded runs.jsonl), exit 0; another trigger still runs", async () => {
    await writeTriggers([dispatchEntry({ ceilingUsd: 0.5 }), dispatchEntry({ ceilingUsd: 0.5 }, "second")]);
    await appendTriggerRunRecord(root, {
      at: "2026-09-22T00:00:00.000Z",
      trigger: "overnight",
      firedBy: { kind: "schedule", cron: "0 2 * * *" },
      action: { kind: "flow-next", flow: flowId },
      outcome: "ok",
      detail: "seeded",
      cost: { recorded: true, usd: 0.5, tokens: { input: 1, output: 1 } },
    });
    const refusedProvider = scripted([]);
    await run(refusedProvider);
    expect(process.exitCode ?? 0).toBe(0);
    expect(refusedProvider.calls()).toBe(0);
    const refused = await lastRecord();
    expect(refused.outcome).toBe("budget-refused");
    expect(refused.detail).toContain("per-trigger ceiling");

    const other = scripted([[USAGE_ROUND_1, ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }]]);
    await run(other, {}, "second");
    expect(other.calls()).toBeGreaterThan(0);
    expect((await lastRecord()).outcome).toBe("ok");
  });

  test("AC8: the run stops at the remaining allowance — attempt failed 'spend cap reached', overshoot at most one response", async () => {
    const allowance = 0.001; // below one round's cost
    await writeTriggers([dispatchEntry({ ceilingUsd: allowance })]);
    const provider = scripted([
      [USAGE_ROUND_1, ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }],
      [USAGE_ROUND_1, { kind: "text_delta", text: "second round must never happen" }, { kind: "model_end" }],
    ]);
    await run(provider);
    expect(provider.calls()).toBe(1);
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.detail).toContain("spend cap reached");
    expect(record.cost.recorded).toBe(true);
    if (record.cost.recorded) expect(record.cost.usd).toBeLessThanOrEqual(allowance + ROUND_1_USD);
    const t1 = ((await flowJson())["tasks"] as { id: string; attempts?: { log: { outcome: string; detail?: string }[] } }[]).find((t) => t.id === "T1")!;
    expect(t1.attempts?.log.map((e) => e.outcome)).toEqual(["started", "failed"]);
    expect(t1.attempts?.log[1]?.detail).toContain("spend cap reached");
  });
});

describe("AC10: the maintenance lock is not held across a dispatch", () => {
  test("a separate process can take the project's maintenance lock while the agent is running", async () => {
    await writeTriggers([dispatchEntry()]);
    let childOutput = "";
    const provider = scripted([
      async () => {
        const script =
          `import { withMaintenanceLock } from ${JSON.stringify(path.join(REPO_ROOT, "src", "lib", "maintenance-lock.ts"))};\n` +
          `await withMaintenanceLock(${JSON.stringify(root)}, async () => console.log("acquired"), { waitMs: 0 });\n`;
        const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
        childOutput = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
        await child.exited;
        return [USAGE_ROUND_1, ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }];
      },
    ]);
    await run(provider);
    expect(childOutput.trim()).toBe("acquired");
    expect((await lastRecord()).outcome).toBe("ok");
  });
});

describe("AC1: list/status say report-only for an entry without a dispatch block", () => {
  test("report-only vs dispatch are both named", async () => {
    await writeTriggers([
      dispatchEntry(),
      { name: "report", on: { kind: "event", event: "post-merge" }, action: { kind: "flow-next", flow: flowId } },
    ]);
    await acquireCwd(root);
    try {
      await triggerCommand(["list"]);
      await triggerCommand(["status"]);
    } finally {
      releaseCwd();
    }
    const out = logged.join("\n");
    expect(out).toContain(`flow-next(${flowId}, report-only)`);
    expect(out).toContain(`flow-next(${flowId}, dispatch: scripted/m, mode trust`);
    expect(out.split("report-only").length - 1).toBeGreaterThanOrEqual(2); // once in list, once in status
  });
});

// ===========================================================================
// Flow 290 T13 — security review fixes (AC13, AC14, AC15, AC10 under the sandbox)
// ===========================================================================

async function records(): Promise<TriggerRunRecord[]> {
  const read = await readTriggerRuns(root);
  return read.state === "present" ? [...read.records] : [];
}

const NO_SANDBOX: UnattendedSandboxPlan = { ok: false, reason: "no sandbox launcher: test host" };

describe("AC13: trust never runs uncontained; ask is read-only", () => {
  test("trust with no sandbox refuses before any model call, reservation, worktree or attempt — reason recorded", async () => {
    await writeTriggers([dispatchEntry({ permissionMode: "trust" })]);
    const provider = scripted([]);
    await run(provider, { planSandbox: () => NO_SANDBOX });
    expect(provider.calls()).toBe(0);
    const record = await lastRecord();
    expect(record.outcome).toBe("dispatch-refused");
    expect(record.dispatch?.refusal).toBe("sandbox-unavailable");
    expect(record.detail).toContain("no sandbox launcher: test host");
    expect((await records()).some((r) => r.outcome === "reserved")).toBe(false);
    const t1 = ((await flowJson())["tasks"] as { id: string; attempts?: { count: number } }[]).find((t) => t.id === "T1")!;
    expect(t1.attempts?.count ?? 0).toBe(0);
    expect(git(root, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  test("ask with no sandbox runs, but every command and patch is refused — nothing lands", async () => {
    await writeTriggers([dispatchEntry({ permissionMode: "ask" })]);
    const provider = scripted([
      [
        USAGE_NONE,
        ...toolCall("shell_exec", { command: "echo hi > proof.txt" }, "c1"),
        ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }, "c2"),
        { kind: "model_end" },
      ],
    ]);
    await run(provider, { planSandbox: () => NO_SANDBOX });
    const record = await lastRecord();
    expect(record.dispatch?.closing).toBe("blocked");
    expect(record.detail).toContain('"ask" mode, every shell_exec refused');
    expect(git(root, ["rev-parse", `trigger/${flowId}-T1`])).toBe(git(root, ["rev-parse", "main"]));
  });

  test("the default health gate runs `keryx health run` and `health gate` INSIDE the sandbox, with its env", async () => {
    const plan: UnattendedSandboxPlan = {
      ok: true,
      launcher: "bwrap",
      args: ["--marker"],
      env: { PATH: "/usr/bin", HOME: "/scratch" },
      wrap: (argv) => ["bwrap", "--marker", "--", ...argv],
    };
    const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
    const result = await sandboxedHealthGate(root, plan, async (argv, env) => {
      seen.push({ argv, env });
      return { code: 0, out: "gate: pass" };
    });
    expect(result.pass).toBe(true);
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.argv.slice(0, 3)).toEqual(["bwrap", "--marker", "--"]);
      expect(call.env).toEqual(plan.env);
    }
    expect(seen[0]!.argv.slice(-2)).toEqual(["health", "run"]);
    expect(seen[1]!.argv.slice(-2)).toEqual(["health", "gate"]);
  });

  test("with no sandbox the health gate does not run the worktree's code at all", async () => {
    let ran = false;
    const result = await sandboxedHealthGate(root, NO_SANDBOX, async () => {
      ran = true;
      return { code: 0, out: "" };
    });
    expect(ran).toBe(false);
    expect(result.pass).toBe(false);
  });
});

const liveSandbox = planUnattendedSandbox({
  worktree: tmpdir(),
  scratchHome: tmpdir(),
  network: false,
  readOnly: [],
  env: process.env,
  home: homedir(),
});

describe.skipIf(!liveSandbox.ok)("AC10/AC13 (live bwrap): a dispatched agent's command runs sandboxed and can take the maintenance lock", () => {
  test("shell_exec under the real sandbox takes the worktree's maintenance lock; the lock dir is never committed", async () => {
    await writeTriggers([dispatchEntry({ permissionMode: "trust" })]);
    const lockModule = path.join(REPO_ROOT, "src", "lib", "maintenance-lock.ts");
    const script =
      `import { withMaintenanceLock } from ${JSON.stringify(lockModule)}; ` +
      `await withMaintenanceLock(process.cwd(), async () => { await Bun.write("lock-proof.txt", "acquired " + (process.env.GITHUB_TOKEN ?? "no-token") + "\\n"); }, { waitMs: 0 });`;
    const provider = scripted([
      [USAGE_ROUND_1, ...toolCall("shell_exec", { command: `bun -e '${script}'` }), { kind: "model_end" }],
      [USAGE_NONE, { kind: "text_delta", text: "done" }, { kind: "model_end" }],
    ]);
    const savedToken = process.env["GITHUB_TOKEN"];
    process.env["GITHUB_TOKEN"] = "ghp_must_not_reach_the_agent";
    try {
      await runTriggerOnce(root, "overnight", {
        service,
        dispatch: {
          makeProvider: () => provider,
          healthGate: passGate(),
          worktreeParent: path.join(root, "..", `${path.basename(root)}-wt`),
          // the real planner, against this host
        },
      });
    } finally {
      if (savedToken === undefined) delete process.env["GITHUB_TOKEN"];
      else process.env["GITHUB_TOKEN"] = savedToken;
    }
    const record = await lastRecord();
    expect(record.detail).toContain("hardened bwrap sandbox, network off");
    expect(record.outcome).toBe("ok");
    expect(git(root, ["show", `trigger/${flowId}-T1:lock-proof.txt`])).toBe("acquired no-token");
    expect(git(root, ["ls-tree", "-r", "--name-only", `trigger/${flowId}-T1`])).not.toContain(".locks");
  });
});

describe("AC14: spend is reserved before the first model call and never fails open", () => {
  const entryBits = {
    firedBy: { kind: "schedule", cron: "0 2 * * *" } as const,
    action: { kind: "flow-next", flow: "001" } as const,
  };

  test("two concurrent reservations for one trigger: exactly one gets the allowance (real overlap under the spend lock)", async () => {
    const results = await Promise.all(
      ["run-a", "run-b"].map((runId) =>
        reserveTriggerSpend(root, { runId, trigger: "overnight", ...entryBits, perTrigger: { name: "overnight", ceilingUsd: 1 } }),
      ),
    );
    const granted = results.filter((r) => r.reserved);
    const refused = results.filter((r) => !r.reserved);
    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    if (granted[0]!.reserved) expect(granted[0]!.usd).toBe(1);
  });

  test("a killed run's reservation keeps counting until an operator resolves it with the real spend", async () => {
    await writeTriggers([dispatchEntry({ ceilingUsd: 1 })]);
    const reserved = await reserveTriggerSpend(root, {
      runId: "killed-run",
      trigger: "overnight",
      ...entryBits,
      perTrigger: { name: "overnight", ceilingUsd: 1 },
    });
    expect(reserved.reserved).toBe(true);
    // No final record — the process died. The trigger is at its ceiling.
    const blocked = await evaluateTriggerBudget(root, "flow-next", {}, { name: "overnight", ceilingUsd: 1 });
    expect(blocked.allowed).toBe(false);

    await acquireCwd(root);
    try {
      await triggerCommand(["status"]);
      expect(logged.join("\n")).toContain("open spend reservation: run killed-run");
      await triggerCommand(["resolve", "killed-run", "--spent", "0.25"]);
    } finally {
      releaseCwd();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(openReservations(await records())).toEqual([]);
    const after = await evaluateTriggerBudget(root, "flow-next", {}, { name: "overnight", ceilingUsd: 1 });
    expect(after.allowed).toBe(true);
    if (after.allowed) expect(after.remainingUsd).toBeCloseTo(0.75, 10);
  });

  test("a response with no usage stops the run, fails the attempt, and charges the whole reservation", async () => {
    await writeTriggers([dispatchEntry({ ceilingUsd: 0.4 })]);
    const provider = scripted([[...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }]]);
    await run(provider);
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.detail).toContain("without token usage");
    expect(record.cost.recorded).toBe(true);
    if (record.cost.recorded) expect(record.cost.usd).toBe(0.4);
    expect(openReservations(await records())).toEqual([]);
  });

  test("a throw while writing the closing attempt still records the cost and closes the reservation", async () => {
    await writeTriggers([dispatchEntry()]);
    const throwing: FlowService = {
      ...service,
      taskAttempt: async (input) => {
        if (input.outcome !== "started") throw new Error("disk full");
        return service.taskAttempt(input);
      },
    };
    const provider = scripted([[USAGE_ROUND_1, { kind: "provider_error", error: { kind: "unavailable", retryable: false, message: "down" } }]]);
    await runTriggerOnce(root, "overnight", {
      service: throwing,
      dispatch: {
        makeProvider: () => provider,
        healthGate: passGate(),
        worktreeParent: path.join(root, "..", `${path.basename(root)}-wt`),
        planSandbox: () => UNWRAPPED_SANDBOX,
      },
    });
    const record = await lastRecord();
    expect(record.cost).toEqual({ recorded: true, usd: ROUND_1_USD, tokens: { input: 1000, output: 200 } });
    expect(record.detail).toContain("disk full");
    expect(openReservations(await records())).toEqual([]);
  });

  test("only providers known to report usage are accepted", () => {
    expect(providerReportsUsage("anthropic")).toBe(true);
    expect(providerReportsUsage("openai")).toBe(true);
    expect(providerReportsUsage("gemini")).toBe(true);
    expect(providerReportsUsage("grok")).toBe(true); // registry: streamUsage
    expect(providerReportsUsage("ollama")).toBe(false);
    expect(providerReportsUsage("deepseek")).toBe(false);
    expect(providerReportsUsage("no-such-provider")).toBe(false);
  });
});

describe("AC15: a killed run's worktree does not wedge the trigger branch", () => {
  const parent = (): string => path.join(root, "..", `${path.basename(root)}-wt`);

  test("a live stale worktree left on trigger/<flow>-<task> under the dispatcher's parent is recovered", async () => {
    await writeTriggers([dispatchEntry()]);
    await mkdir(parent(), { recursive: true });
    git(root, ["worktree", "add", "--quiet", "-b", `trigger/${flowId}-T1`, path.join(parent(), `${flowId}-T1-killed`), "HEAD"]);
    const provider = scripted([[USAGE_ROUND_1, ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }]]);
    await run(provider);
    const record = await lastRecord();
    expect(record.outcome).toBe("ok");
    expect(record.detail).toContain("recovered a stale worktree");
  });

  test("a registration whose directory is already gone is pruned", async () => {
    await writeTriggers([dispatchEntry()]);
    await mkdir(parent(), { recursive: true });
    const dead = path.join(parent(), `${flowId}-T1-dead`);
    git(root, ["worktree", "add", "--quiet", "-b", `trigger/${flowId}-T1`, dead, "HEAD"]);
    await rm(dead, { recursive: true, force: true });
    const provider = scripted([[USAGE_ROUND_1, ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }]]);
    await run(provider);
    expect((await lastRecord()).outcome).toBe("ok");
  });

  test("the branch checked out somewhere the dispatcher did not create is never touched — refused as a conflict", async () => {
    await writeTriggers([dispatchEntry()]);
    const operators = await mkdtemp(path.join(tmpdir(), "keryx-operator-wt-"));
    await rm(operators, { recursive: true, force: true });
    git(root, ["worktree", "add", "--quiet", "-b", `trigger/${flowId}-T1`, operators, "HEAD"]);
    try {
      const provider = scripted([]);
      await run(provider);
      const record = await lastRecord();
      expect(record.dispatch?.refusal).toBe("worktree-conflict");
      expect(provider.calls()).toBe(0);
      expect(git(root, ["worktree", "list"])).toContain(operators);
    } finally {
      git(root, ["worktree", "remove", "--force", operators]);
    }
  });
});

describe("T13: the dispatcher's own commit never runs repository hooks the agent could have written", () => {
  test("a tracked hooks dir (core.hooksPath) with a pre-commit hook does not run when the dispatcher commits", async () => {
    await writeTriggers([dispatchEntry()]);
    const marker = path.join(root, "..", `${path.basename(root)}-hook-ran`);
    await mkdir(path.join(root, ".githooks"), { recursive: true });
    await writeFile(path.join(root, ".githooks", "pre-commit"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    await writeFile(path.join(root, ".githooks", "post-commit"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "--no-verify", "-m", "hooks"]);
    git(root, ["config", "core.hooksPath", ".githooks"]);
    try {
      const provider = scripted([[USAGE_ROUND_1, ...toolCall("apply_patch", { patch: NEW_FILE_PATCH }), { kind: "model_end" }]]);
      await run(provider);
      expect((await lastRecord()).outcome).toBe("ok");
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await rm(marker, { force: true });
    }
  });
});
