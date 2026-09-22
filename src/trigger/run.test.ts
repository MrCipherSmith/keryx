// Flow 286 T7: `resolveTriggerForRun` + `withTriggerRunLock` — the core-zone
// half of `keryx trigger run <name>`. The CLI dispatch (`../commands/
// trigger.ts`, calling `syncCommand`/`gdgraphCommand`) is exercised
// separately in `../commands/trigger.test.ts` and
// `../commands/trigger-run.e2e.test.ts` — this file stays at the level this
// module actually owns: which entry `<name>` resolves to, and whether a run
// may proceed under the project's trigger lock.

import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluateTriggerBudget, resolveTriggerForRun, triggerRunLockPath, withTriggerRunLock } from "./run";
import { triggersConfigPath } from "./config";
import { appendTriggerRunRecord, triggerRunsPath } from "./record";
import { pathExists } from "../lib/fs";

async function projectWith(content: string | undefined): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-run-"));
  if (content !== undefined) {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(triggersConfigPath(root), content, "utf8");
  }
  return root;
}

describe("resolveTriggerForRun", () => {
  test("no triggers.json at all: 'config-absent'", async () => {
    const root = await projectWith(undefined);
    expect(resolveTriggerForRun(root, "whatever")).toEqual({ kind: "config-absent" });
  });

  test("a triggers.json that is not JSON: 'config-broken' names the fileProblem", async () => {
    const root = await projectWith("not json at all");
    expect(resolveTriggerForRun(root, "whatever")).toEqual({ kind: "config-broken", fileProblem: "not-json" });
  });

  test("a valid file, an enabled entry: 'ready' with the resolved entry", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }],
      }),
    );
    const result = resolveTriggerForRun(root, "nightly");
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.entry.name).toBe("nightly");
      expect(result.entry.action).toEqual({ kind: "rebuild" });
      expect(result.entry.enabled).toBe(true);
    }
  });

  test("a valid file, a disabled entry: 'disabled' with the resolved entry", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          {
            name: "paused",
            on: { kind: "event", event: "post-merge" },
            action: { kind: "reconcile" },
            enabled: false,
          },
        ],
      }),
    );
    const result = resolveTriggerForRun(root, "paused");
    expect(result.kind).toBe("disabled");
    if (result.kind === "disabled") expect(result.entry.name).toBe("paused");
  });

  test("a name absent from the file entirely: 'unknown-name' lists what IS known", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }],
      }),
    );
    const result = resolveTriggerForRun(root, "nope");
    expect(result).toEqual({ kind: "unknown-name", known: ["nightly"] });
  });

  test("a name that matches a REJECTED (malformed) entry: 'rejected' carries its reasons, not 'unknown-name'", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "broken", on: { kind: "event", event: "not-a-real-event" }, action: { kind: "reconcile" } }],
      }),
    );
    const result = resolveTriggerForRun(root, "broken");
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons.join(" ")).toContain("on.event");
    }
  });
});

describe("triggerRunLockPath", () => {
  test("one project-scoped path, under .metaproject/data/trigger", () => {
    expect(triggerRunLockPath("/repo")).toBe(path.join("/repo", ".metaproject", "data", "trigger", ".run.lock"));
  });
});

describe("withTriggerRunLock (AC3 decision: refuse immediately, do not wait)", () => {
  test("an uncontended call acquires, runs fn once, and releases — the lock directory is gone afterward", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-lock-"));
    let ran = 0;
    const outcome = await withTriggerRunLock(root, async () => {
      ran += 1;
      return "done";
    });
    expect(outcome).toEqual({ acquired: true, result: "done" });
    expect(ran).toBe(1);
    expect(await pathExists(triggerRunLockPath(root))).toBe(false);
  });

  test("a real second call, concurrent with a still-running first, refuses instead of waiting or corrupting the count", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-lock-"));
    let started = 0;
    let finished = 0;

    // Real concurrency: two promises, both hitting the SAME on-disk lock
    // directory via the real `withFileLock` — not a stubbed lock. The first
    // holds it across an actual await (its own body sleeps) so the second's
    // attempt is guaranteed to land while the first still holds it.
    const first = withTriggerRunLock(root, async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      finished += 1;
      return "first";
    });
    // Give `first` a moment to win the initial `mkdir` race and actually hold
    // the lock before `second` attempts it — otherwise which one wins the
    // very first race is unspecified (harmlessly; the assertions below don't
    // depend on which one runs), but only a genuinely LATER second call
    // reliably exercises "arrives while the first still holds it".
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withTriggerRunLock(root, async () => {
      started += 1;
      finished += 1;
      return "second";
    });

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(started).toBe(1); // the refused call's fn never ran at all
    expect(finished).toBe(1);
    expect(firstOutcome).toEqual({ acquired: true, result: "first" });
    expect(secondOutcome.acquired).toBe(false);
    if (!secondOutcome.acquired) {
      expect(secondOutcome.reason).toContain("holds this project's trigger lock");
    }
    // Released cleanly afterward — a refused caller must never leave the
    // winner's lock directory behind, or every future run would refuse forever.
    expect(await pathExists(triggerRunLockPath(root))).toBe(false);
  });
});

describe("evaluateTriggerBudget (AC8, review finding 3, T15: an unreadable ledger refuses; an absent one does not)", () => {
  test("no runs.jsonl at all: a demonstrated $0, allowed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-budget-"));
    const outcome = await evaluateTriggerBudget(root, "open-flow");
    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) {
      expect(outcome.evaluation.spent).toBe(0);
      expect(outcome.evaluation.status).toBe("under");
    }
  });

  test("a readable ledger under the ceiling: allowed, spend reflected in the evaluation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-budget-"));
    await appendTriggerRunRecord(root, {
      at: new Date().toISOString(),
      trigger: "earlier",
      firedBy: { kind: "event", event: "ci" },
      action: { kind: "open-flow", template: "earlier work" },
      outcome: "ok",
      detail: "seeded",
      cost: { recorded: true, usd: 1 },
    });
    const outcome = await evaluateTriggerBudget(root, "open-flow");
    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) expect(outcome.evaluation.spent).toBe(1);
  });

  test("a ledger with one damaged line: refuses — spend cannot be verified, so it must not read as a demonstrated $0", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-budget-"));
    await mkdir(path.dirname(triggerRunsPath(root)), { recursive: true });
    await writeFile(triggerRunsPath(root), "not valid jsonl at all\n", "utf8");

    const outcome = await evaluateTriggerBudget(root, "open-flow");

    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      // Says the ledger could not be read — never quotes a spend number for
      // this cause, which would misrepresent an unverifiable ledger as a
      // known amount.
      expect(outcome.reason).toContain("could not be read");
      expect(outcome.reason).not.toContain("$0 ");
      expect(outcome.reason).not.toContain("$undefined");
      expect(outcome.reason).not.toContain("$NaN");
    }
  });

  test("a ledger that is readable overall but has one damaged line among valid ones: still refuses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-budget-"));
    await appendTriggerRunRecord(root, {
      at: new Date().toISOString(),
      trigger: "earlier",
      firedBy: { kind: "event", event: "ci" },
      action: { kind: "open-flow", template: "earlier work" },
      outcome: "ok",
      detail: "seeded",
      cost: { recorded: true, usd: 1 },
    });
    // Append one damaged line after a valid one — `readTriggerRuns` reports
    // the WHOLE file unreadable rather than reporting the readable remainder
    // as the complete history (`./record.ts`'s own contract).
    await appendFile(triggerRunsPath(root), "{not json\n", "utf8");

    const outcome = await evaluateTriggerBudget(root, "open-flow");
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toContain("could not be read");
  });
});
