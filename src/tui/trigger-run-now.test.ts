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
import { existsSync } from "node:fs";
import { maintenanceLockPath, withMaintenanceLock } from "../lib/maintenance-lock";
import { resolveKeryxInvocation } from "../trigger/schedule";
import type { TriggerRunRecord } from "../trigger/record";
import { CLI, appendRuns, makeProject, writeTriggers } from "./ops-sidebar.test-helpers";
import {
  createTriggerRunNow,
  describeDetachedRuns,
  runNowChildEnv,
  runNowLogPath,
  triggerRunArgv,
  type RunNowChild,
  type RunNowSpawn,
  type RunNowSpawnOptions,
} from "./trigger-run-now";

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

/** A fake spawn that records exactly what run-now asked the OS to start. */
function recordingSpawn(): {
  spawn: RunNowSpawn;
  calls: Array<{ command: string; args: readonly string[]; options: RunNowSpawnOptions }>;
  exit(code: number): void;
  killed: string[];
} {
  const calls: Array<{ command: string; args: readonly string[]; options: RunNowSpawnOptions }> = [];
  const killed: string[] = [];
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  return {
    calls,
    killed,
    exit: (code) => onExit?.(code, null),
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const child = {
        on(event: string, cb: (...a: never[]) => void) {
          if (event === "exit") onExit = cb as never;
          return child;
        },
        unref() {},
        kill(signal?: string) {
          killed.push(String(signal));
          return true;
        },
      };
      return child as unknown as RunNowChild;
    },
  };
}

test("AC6 (review F6): with the DEFAULT invocation, run() spawns this process's own interpreter + entry — never `keryx` on PATH", async () => {
  const root = await project();
  const fake = recordingSpawn();
  // No `invocation` passed: the production default path.
  const runNow = createTriggerRunNow({ root, spawn: fake.spawn });
  const done = runNow.run("nightly");
  expect(done).toBeDefined();
  const expected = resolveKeryxInvocation();
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]?.command).toBe(process.execPath);
  expect(fake.calls[0]?.command).not.toBe("keryx");
  expect(fake.calls[0]?.args).toEqual([expected.scriptPath as string, "trigger", "run", "nightly"]);
  fake.exit(0);
  await done;
});

test("AC6: the argv of a compiled binary is the binary alone (review F2)", () => {
  expect(triggerRunArgv("nightly", resolveKeryxInvocation("/$bunfs/root/keryx", "/usr/local/bin/keryx"))).toEqual([
    "/usr/local/bin/keryx",
    "trigger",
    "run",
    "nightly",
  ]);
});

test("review F4: the child is detached in its own process group with output to a self-ignoring log; dispose never signals it", async () => {
  const root = await project();
  const fake = recordingSpawn();
  const runNow = createTriggerRunNow({ root, invocation: INVOCATION, spawn: fake.spawn });
  const done = runNow.run("nightly");
  const options = fake.calls[0]?.options;
  expect(options?.detached).toBe(true);
  expect(options?.stdio[0]).toBe("ignore");
  expect(typeof options?.stdio[1]).toBe("number");
  expect(options?.stdio[1]).toBe(options?.stdio[2]);
  expect(options?.cwd).toBe(root);
  const logPath = runNowLogPath(root, "nightly");
  expect(await readFile(path.join(path.dirname(logPath), ".gitignore"), "utf8")).toContain("*");
  // A second run-now of the same name from this shell starts nothing.
  expect(runNow.run("nightly")).toBeUndefined();
  // Quitting the shell: nothing is killed; the run is reported as continuing.
  const detached = runNow.dispose();
  expect(fake.killed).toEqual([]);
  expect(detached).toEqual([{ name: "nightly", logPath }]);
  expect(describeDetachedRuns(detached)).toBe(`keryx: trigger nightly keeps running in the background — log: ${logPath}`);
  fake.exit(0);
  expect((await done!).exitCode).toBe(0);
});

test("review F5: the child env drops every KERYX_SESSION_* key and keeps the rest", async () => {
  const root = await project();
  const fake = recordingSpawn();
  const runNow = createTriggerRunNow({
    root,
    invocation: INVOCATION,
    spawn: fake.spawn,
    env: { PATH: "/usr/bin", KERYX_SESSION_PROVIDER: "anthropic", KERYX_SESSION_MODEL: "claude-x", KERYX_SESSION_LEASE_STALE_MS: "1", KERYX_HOME: "/h" },
  });
  const done = runNow.run("nightly");
  expect(fake.calls[0]?.options.env).toEqual({ PATH: "/usr/bin", KERYX_HOME: "/h" });
  expect(runNowChildEnv({ KERYX_SESSION_X: "1", A: "b" })).toEqual({ A: "b" });
  fake.exit(0);
  await done;
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

test(
  "review F4: single-flight survives a restart through the CLI's own lock — a fresh shell's run-now of a still-running trigger records `lock-refused`",
  async () => {
    const root = await project();
    await writeTriggers(root, [{ name: "rebuild-on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } }]);
    // Shell A starts a run that holds the maintenance lock (the CLI's own test seam stretches the hold).
    const shellA = createTriggerRunNow({ root, invocation: INVOCATION, env: { ...process.env, KERYX_TRIGGER_RUN_HOLD_MS: "4000" } });
    const first = shellA.run("rebuild-on-merge")!;
    // Shell A quits: its run keeps going.
    expect(shellA.dispose().map((r) => r.name)).toEqual(["rebuild-on-merge"]);
    // Wait on the lock itself, not a clock guess.
    const lock = maintenanceLockPath(root);
    for (let i = 0; i < 400 && !existsSync(lock); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(lock)).toBe(true);
    // Shell B — a restart, knowing nothing of A — tries the same trigger.
    const second = await createTriggerRunNow({ root, invocation: INVOCATION }).run("rebuild-on-merge")!;
    expect(second.output).toContain("holds this project's maintenance lock");
    await first;
    const records = await ledger(root);
    expect(records.map((r) => r.outcome)).toContain("lock-refused");
    // A's detached run finished on its own and wrote its OWN closing record.
    expect(records).toHaveLength(2);
  },
  60_000,
);
