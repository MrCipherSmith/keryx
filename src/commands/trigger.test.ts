// Flow 286 T7: `keryx trigger run <name>` end-to-end through the real command
// entry point (`triggerCommand`) — not a stub of the resolution/lock layer.
// Sequential only. The AC3 concurrency proof needs separate PROCESSES
// (`console.log`/`process.exitCode` are shared globals two truly concurrent
// in-process calls cannot be attributed between) and lives in
// `trigger-run.e2e.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { triggerCommand } from "./trigger";
import { triggersConfigPath } from "../trigger/config";
import { appendTriggerRunRecord, readTriggerRuns, triggerRunsPath } from "../trigger/record";
import { DEFAULT_SPEND_CEILING_USD } from "../review/caps";
import { readProvenance } from "../sync/provenance";
import { acquireCwd, releaseCwd } from "../lib/test-cwd";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function headCommit(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
}

async function scaffoldProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-cli-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

async function writeTriggers(root: string, triggers: unknown[]): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(triggersConfigPath(root), JSON.stringify({ schemaVersion: 1, triggers }), "utf8");
}

let root = "";
let logged: string[] = [];
let errored: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(async () => {
  root = await scaffoldProject();
  await acquireCwd(root);
  logged = [];
  errored = [];
  console.log = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    errored.push(parts.map(String).join(" "));
  };
  // Bun does not clear `process.exitCode` on reassigning `undefined` (noted by
  // `modulesCommand`'s own test file); reset it explicitly per test.
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  releaseCwd();
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

describe("keryx trigger run — AC2: exactly one pass, exit code reflects only the action", () => {
  test("no .metaproject/triggers.json at all: nothing to do, exit 0", async () => {
    await triggerCommand(["run", "anything"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("nothing to do");
  });

  test("a disabled entry: nothing to do, exit 0, the action never runs", async () => {
    await writeTriggers(root, [
      { name: "paused", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" }, enabled: false },
    ]);

    await triggerCommand(["run", "paused"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("disabled");
    expect(await readProvenance(root, "gdgraph")).toBeNull(); // reconcile never ran
  });

  test("an unknown name: exit non-zero", async () => {
    await writeTriggers(root, [
      { name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } },
    ]);

    await triggerCommand(["run", "nope"]);

    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("unknown trigger");
  });

  test("a malformed (rejected) entry sharing the requested name: exit non-zero with its reasons, not 'unknown'", async () => {
    await writeTriggers(root, [
      { name: "broken", on: { kind: "event", event: "not-a-real-event" }, action: { kind: "reconcile" } },
    ]);

    await triggerCommand(["run", "broken"]);

    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("malformed");
    expect(errored.join("\n")).toContain("on.event");
  });

  test("'rebuild' — one pass reuses `keryx gdgraph build`, exit 0, provenance recorded", async () => {
    await writeTriggers(root, [
      { name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } },
    ]);
    const commit = headCommit(root);

    await triggerCommand(["run", "nightly"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain('ok — "rebuild" completed');
    const provenance = await readProvenance(root, "gdgraph");
    expect(provenance?.commit).toBe(commit);
  });

  test("'reconcile' — one pass reuses `keryx sync --apply`, exit 0, graph+memory provenance recorded", async () => {
    await writeTriggers(root, [
      { name: "post-merge-reconcile", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
    ]);
    const commit = headCommit(root);

    await triggerCommand(["run", "post-merge-reconcile"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain('ok — "reconcile" completed');
    expect((await readProvenance(root, "gdgraph"))?.commit).toBe(commit);
    expect((await readProvenance(root, "memory"))?.commit).toBe(commit);
  });

  test("'open-flow' — opens a flow from the entry's template, exit 0, recorded ok", async () => {
    await writeTriggers(root, [
      { name: "open-bugfix", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "bugfix sweep" } },
    ]);

    await triggerCommand(["run", "open-bugfix"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain('ok — opened flow');
    expect(logged.join("\n")).toContain('"bugfix sweep"');

    const flowDirs = (await readdir(path.join(root, ".metaproject", "flows"))).filter((d) => d.includes("bugfix-sweep"));
    expect(flowDirs.length).toBe(1);

    const runsRead = await readTriggerRuns(root);
    expect(runsRead.state).toBe("present");
    if (runsRead.state === "present") {
      expect(runsRead.records).toHaveLength(1);
      expect(runsRead.records[0]?.outcome).toBe("ok");
      expect(runsRead.records[0]?.action).toEqual({ kind: "open-flow", template: "bugfix sweep" });
    }
  });

  test("'open-flow' with skipIfOpen — a second firing while an equivalent flow is already open is a no-op with a stated reason (AC7)", async () => {
    await writeTriggers(root, [
      {
        name: "open-nightly-sweep",
        on: { kind: "schedule", cron: "0 3 * * *" },
        action: { kind: "open-flow", template: "nightly sweep", skipIfOpen: true },
      },
    ]);

    await triggerCommand(["run", "open-nightly-sweep"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("ok — opened flow");

    logged = [];
    await triggerCommand(["run", "open-nightly-sweep"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("already open for template");
    expect(logged.join("\n")).toContain("skipIfOpen");

    // Equivalence is on template + still-open status: still exactly one flow
    // directory on disk, not two.
    const flowDirs = (await readdir(path.join(root, ".metaproject", "flows"))).filter((d) => d.includes("nightly-sweep"));
    expect(flowDirs.length).toBe(1);

    const runsRead = await readTriggerRuns(root);
    expect(runsRead.state).toBe("present");
    if (runsRead.state === "present") {
      expect(runsRead.records).toHaveLength(2);
      expect(runsRead.records[0]?.outcome).toBe("ok");
      expect(runsRead.records[1]?.outcome).toBe("no-op");
      expect(runsRead.records[1]?.detail).toContain("already open for template");
    }
  });

  test("'flow-next' — reports the flow's next task into the record; it does not dispatch anything", async () => {
    await writeTriggers(root, [
      { name: "open-it", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "reported flow" } },
    ]);
    await triggerCommand(["run", "open-it"]);
    expect(process.exitCode ?? 0).toBe(0);
    const opened = await readTriggerRuns(root);
    if (opened.state !== "present") throw new Error("expected the open-flow run to be recorded");
    const openRecord = opened.records[0];
    if (!openRecord || openRecord.action.kind !== "open-flow") throw new Error("expected an open-flow record");
    const match = /opened flow (\S+) /.exec(openRecord.detail);
    const flowId = match?.[1];
    if (!flowId) throw new Error(`could not read the opened flow's id from: ${openRecord.detail}`);

    await writeTriggers(root, [
      { name: "open-it", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "reported flow" } },
      { name: "advance-flow", on: { kind: "event", event: "post-commit" }, action: { kind: "flow-next", flow: flowId } },
    ]);
    logged = [];
    await triggerCommand(["run", "advance-flow"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain(`flow ${flowId}'s next task is T1`);
    expect(logged.join("\n")).toContain("resume: never-started");

    const runsRead = await readTriggerRuns(root);
    expect(runsRead.state).toBe("present");
    if (runsRead.state === "present") {
      const record = runsRead.records.at(-1);
      if (!record) throw new Error("expected a flow-next record");
      expect(record.outcome).toBe("ok");
      expect(record.action).toEqual({ kind: "flow-next", flow: flowId });
      expect(record.detail).toContain("T1");
      expect(record.cost.recorded).toBe(false);
      if (!record.cost.recorded) {
        expect(record.cost.reason).toContain('"flow-next" does not call a model');
      }
    }
  });

  test("budget-refused (AC8) — a run whose recorded trigger spend is at the ceiling exits 0, opens nothing, and is recorded as budget-refused", async () => {
    await writeTriggers(root, [
      { name: "open-over-budget", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "should not open" } },
    ]);
    // Seed the ledger `evaluateTriggerBudget` reads from: this project's own
    // fired-trigger record, at (not past) the default ceiling.
    await appendTriggerRunRecord(root, {
      at: new Date().toISOString(),
      trigger: "some-earlier-trigger",
      firedBy: { kind: "event", event: "ci" },
      action: { kind: "open-flow", template: "earlier work" },
      outcome: "ok",
      detail: "seeded for the budget test",
      cost: { recorded: true, usd: DEFAULT_SPEND_CEILING_USD },
    });

    await triggerCommand(["run", "open-over-budget"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("spend ceiling");
    expect(logged.join("\n")).toContain("refusing to start");

    const flowDirs = await readdir(path.join(root, ".metaproject", "flows")).catch(() => []);
    expect(flowDirs.filter((d) => d.includes("should-not-open")).length).toBe(0);

    const runsRead = await readTriggerRuns(root);
    expect(runsRead.state).toBe("present");
    if (runsRead.state === "present") {
      const record = runsRead.records.at(-1);
      expect(record?.outcome).toBe("budget-refused");
      expect(record?.trigger).toBe("open-over-budget");
    }
  });

  test("review finding 3 (T15) — an unreadable run ledger refuses the budget gate rather than failing it open", async () => {
    await writeTriggers(root, [
      { name: "open-with-bad-ledger", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "should not open either" } },
    ]);
    // Damage the ledger `evaluateTriggerBudget` reads from directly, the same
    // way a partial write / disk corruption would: one line that will not
    // parse as JSON. Before the fix this collapsed to `spent: undefined`,
    // `evaluateSpendCap` reported `not-recorded`/`stop: false`, and the run
    // proceeded — AC8's promise silently disabled for good by one bad line.
    await mkdir(path.dirname(triggerRunsPath(root)), { recursive: true });
    await writeFile(triggerRunsPath(root), "this is not jsonl\n", "utf8");

    await triggerCommand(["run", "open-with-bad-ledger"]);

    // Same outcome kind and exit-code contract as the over-ceiling refusal:
    // exit 0 (a refusal is a clean "nothing done this pass", not a crash).
    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("could not be read");
    expect(logged.join("\n")).toContain("refusing to start");
    // The message says the ledger could not be read, never a quoted spend
    // number for this cause.
    expect(logged.join("\n")).not.toContain("$undefined");
    expect(logged.join("\n")).not.toContain("$NaN");

    const flowDirs = await readdir(path.join(root, ".metaproject", "flows")).catch(() => []);
    expect(flowDirs.filter((d) => d.includes("should-not-open-either")).length).toBe(0);
  });

  // Delegated-runner failure path (`delegateToLocalRunner` in `./gdgraph.ts`):
  // a copied local runner that fails sets `process.exitCode` WITHOUT
  // throwing. `runReadyTrigger` reads `process.exitCode` right after the call
  // specifically to still catch this as "the action itself failed" (AC2)
  // instead of reading it as ok because nothing threw.
  test("a failing action (gdgraph build's delegated-runner path exiting non-zero): exit non-zero, not swallowed", async () => {
    await writeTriggers(root, [
      { name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } },
    ]);
    await mkdir(path.join(root, ".metaproject", "core", "gdgraph"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "core", "gdgraph", "cli.ts"), "process.exitCode = 1;\n", "utf8");

    await triggerCommand(["run", "nightly"]);

    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain('action "rebuild" failed');
  });
});

describe("keryx trigger — CLI wiring", () => {
  test("no subcommand or --help prints usage, exit 0", async () => {
    await triggerCommand([]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("keryx trigger run <name>");
  });

  test("an unknown trigger subcommand exits 1", async () => {
    await triggerCommand(["frobnicate"]);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("Unknown trigger command");
  });

  test("`run` with no name: usage error, exit 1", async () => {
    await triggerCommand(["run"]);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("Usage: keryx trigger run <name>");
  });
});
