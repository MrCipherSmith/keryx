// Flow 300 T7 — AC6: run-now is `keryx trigger run <name>` in a child process
// of the same build, bound by exactly the CLI's locks, budgets and refusals.
//
// Real child processes on fixture projects. For each refusal the same fixture
// is then run through `keryx trigger run` directly, and the two ledger
// records must match apart from `at` (and a dispatch's generated `runId`,
// which is minted fresh by design for every run).

import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { withMaintenanceLock } from "../lib/maintenance-lock";
import { resolveKeryxInvocation } from "../trigger/schedule";
import type { TriggerRunRecord } from "../trigger/record";
import { CLI, appendRuns, makeProject, writeTriggers } from "./ops-sidebar.test-helpers";
import { createTriggerRunNow, triggerRunArgv } from "./trigger-run-now";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  const root = await makeProject("keryx-runnow-");
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** The TUI launched as `bun src/cli.ts shell` — the build under test. */
const INVOCATION = { execPath: process.execPath, scriptPath: CLI };

async function ledger(root: string): Promise<TriggerRunRecord[]> {
  const raw = await readFile(path.join(root, ".metaproject", "data", "trigger", "runs.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TriggerRunRecord);
}

/** A record with the per-run fields blanked. */
function comparable(record: TriggerRunRecord | undefined): unknown {
  if (record === undefined) return undefined;
  const { at: _at, ...rest } = record;
  return rest.dispatch === undefined ? rest : { ...rest, dispatch: { ...rest.dispatch, runId: "<runId>" } };
}

/** `keryx trigger run <name>` typed at a shell; returns its exit code. */
async function cliRun(root: string, name: string): Promise<number> {
  const proc = Bun.spawn([process.execPath, CLI, "trigger", "run", name], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return proc.exited;
}

test("AC6: the argv is this process's own interpreter + entry script, never `keryx` on PATH", () => {
  const invocation = resolveKeryxInvocation();
  expect(triggerRunArgv("nightly")).toEqual([invocation.execPath, invocation.scriptPath, "trigger", "run", "nightly"]);
  expect(triggerRunArgv("nightly", INVOCATION)).toEqual([process.execPath, CLI, "trigger", "run", "nightly"]);
  expect(triggerRunArgv("nightly")[0]).not.toBe("keryx");
});

test("AC6: never in-process, never a JobRegistry task (structural)", async () => {
  const source = await readFile(path.join(import.meta.dir, "trigger-run-now.ts"), "utf8");
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  expect(code).not.toMatch(/runTriggerOnce|triggerCommand|commands\/trigger/);
  expect(code).not.toMatch(/background-job-registry|jobRegistry/);
  expect(code).toMatch(/resolveKeryxInvocation/);
});

test(
  "AC6: with the maintenance lock held, run-now records `lock-refused` — the same record `keryx trigger run` writes",
  async () => {
    const root = await project();
    await writeTriggers(root, [{ name: "rebuild-on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } }]);
    const runNow = createTriggerRunNow({ root, invocation: INVOCATION });
    const result = await withMaintenanceLock(root, async () => {
      const tui = await runNow.run("rebuild-on-merge")!;
      await cliRun(root, "rebuild-on-merge");
      return tui;
    }, { waitMs: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("holds this project's maintenance lock");
    const [fromTui, fromCli] = await ledger(root);
    expect(fromTui?.outcome).toBe("lock-refused");
    expect(comparable(fromTui)).toEqual(comparable(fromCli));
  },
  60_000,
);

test(
  "AC6: an `open-flow` over the spend ceiling records `budget-refused` — the same record as the CLI's",
  async () => {
    const root = await project();
    await writeTriggers(root, [{ name: "open-weekly", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "Weekly" } }]);
    await appendRuns(root, [
      {
        at: "2026-09-20T00:00:00.000Z",
        trigger: "open-weekly",
        firedBy: { kind: "event", event: "ci" },
        action: { kind: "open-flow", template: "Weekly" },
        outcome: "ok",
        detail: "an expensive past",
        cost: { recorded: true, usd: 50 },
      },
    ]);
    const result = await createTriggerRunNow({ root, invocation: INVOCATION }).run("open-weekly")!;
    await cliRun(root, "open-weekly");
    const records = await ledger(root);
    const [fromTui, fromCli] = records.slice(1);
    expect(fromTui?.outcome).toBe("budget-refused");
    expect(result.output).toContain(fromTui?.detail ?? "<none>");
    expect(comparable(fromTui)).toEqual(comparable(fromCli));
  },
  60_000,
);

test(
  "AC6: a `flow-next` dispatch that cannot run records the CLI's own `dispatch-refused` code",
  async () => {
    const root = await project();
    // A flow that exists but was never started: `flow-not-in-progress`.
    execFileSync(process.execPath, [CLI, "flow", "init", "--title", "Fixture flow"], { cwd: root, stdio: "ignore" });
    await writeTriggers(root, [
      {
        name: "work-001",
        on: { kind: "event", event: "ci" },
        action: {
          kind: "flow-next",
          flow: "001",
          dispatch: {
            provider: "anthropic",
            model: "claude-x",
            permissionMode: "ask",
            rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
            ceilingUsd: 1,
          },
        },
      },
    ]);
    const result = await createTriggerRunNow({ root, invocation: INVOCATION }).run("work-001")!;
    const cliExit = await cliRun(root, "work-001");
    const [fromTui, fromCli] = await ledger(root);
    expect(fromTui?.outcome).toBe("dispatch-refused");
    expect(fromTui?.dispatch?.refusal).toBe("flow-not-in-progress");
    expect(result.exitCode).toBe(cliExit);
    expect(comparable(fromTui)).toEqual(comparable(fromCli));
  },
  60_000,
);

test("AC6: a second run-now of the same trigger while one is in flight starts nothing; dispose stops the child", async () => {
  const killed: string[] = [];
  let close: ((code: number) => void) | undefined;
  const runNow = createTriggerRunNow({
    root: "/tmp",
    invocation: INVOCATION,
    spawn: () => ({
      stdout: null,
      stderr: null,
      on(event: string, cb: (arg: never) => void) {
        if (event === "close") close = cb as (code: number) => void;
        return this;
      },
      kill(signal) {
        killed.push(String(signal));
        close?.(143);
        return true;
      },
    }),
  });
  const first = runNow.run("t");
  expect(first).toBeDefined();
  expect(runNow.run("t")).toBeUndefined();
  expect([...runNow.running()]).toEqual(["t"]);
  runNow.dispose();
  expect(killed).toEqual(["SIGTERM"]);
  expect((await first!).exitCode).toBe(143);
  expect(runNow.running().size).toBe(0);
});
