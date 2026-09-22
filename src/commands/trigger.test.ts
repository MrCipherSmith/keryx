// Flow 286 T7: `keryx trigger run <name>` end-to-end through the real command
// entry point (`triggerCommand`) — not a stub of the resolution/lock layer.
// Sequential only. The AC3 concurrency proof needs separate PROCESSES
// (`console.log`/`process.exitCode` are shared globals two truly concurrent
// in-process calls cannot be attributed between) and lives in
// `trigger-run.e2e.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { triggerCommand } from "./trigger";
import { triggersConfigPath } from "../trigger/config";
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

  test("'open-flow' — refuses cleanly as not implemented in this build, exit 0", async () => {
    await writeTriggers(root, [
      { name: "open-bugfix", on: { kind: "event", event: "ci" }, action: { kind: "open-flow", template: "bugfix" } },
    ]);

    await triggerCommand(["run", "open-bugfix"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("not implemented in this build");
  });

  test("'flow-next' — refuses cleanly as not implemented in this build, exit 0", async () => {
    await writeTriggers(root, [
      { name: "advance-flow", on: { kind: "event", event: "post-commit" }, action: { kind: "flow-next", flow: "286" } },
    ]);

    await triggerCommand(["run", "advance-flow"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(logged.join("\n")).toContain("not implemented in this build");
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

  test("an unknown trigger subcommand (e.g. install/list/status — not this dispatch's scope) exits 1", async () => {
    await triggerCommand(["install"]);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("Unknown trigger command");
  });

  test("`run` with no name: usage error, exit 1", async () => {
    await triggerCommand(["run"]);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("Usage: keryx trigger run <name>");
  });
});
