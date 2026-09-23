// Flow 300 T5 — the shared seam: config+ledger projection, the scheduled/event
// partition, and the change-detecting watcher (AC7's mechanics; the repaint
// half is in ops-sidebar.test.ts).

import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createTriggerLedgerWatcher,
  eventEntries,
  findEntry,
  isScheduledEntry,
  loadTriggerLedgerView,
  scheduledEntries,
  triggerLedgerPaths,
  type LedgerSource,
} from "./trigger-ledger";
import { appendRuns, makeProject, manualInterval, writeReport, writeTriggers } from "./ops-sidebar.test-helpers";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  const root = await makeProject("keryx-ledger-");
  roots.push(root);
  return root;
}

const record = (trigger: string, at: string, outcome: string, cost: unknown) => ({
  at,
  trigger,
  firedBy: { kind: "event", event: "post-merge" },
  action: { kind: "rebuild" },
  outcome,
  detail: `${outcome} detail`,
  cost,
}) as never;

test("no config: kind absent, no entries, spend absent — never a crash", async () => {
  const view = await loadTriggerLedgerView(await project());
  expect(view.config.kind).toBe("absent");
  expect(view.entries).toEqual([]);
  expect(view.spend).toEqual({ state: "absent" });
});

test("a file that is not a trigger config is broken with the loader's problem", async () => {
  const root = await project();
  await writeFile(path.join(root, ".metaproject", "triggers.json"), "{ not json", "utf8");
  const view = await loadTriggerLedgerView(root);
  expect(view.config).toMatchObject({ kind: "broken", problem: "not-json" });
});

test("entries join their records newest-first; isScheduledEntry partitions them", async () => {
  const root = await project();
  await writeTriggers(root, [
    { name: "rebuild-on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
    { name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "reconcile" } },
  ]);
  await appendRuns(root, [
    record("rebuild-on-merge", "2026-09-20T10:00:00.000Z", "ok", { recorded: false, reason: "no model" }),
    record("nightly", "2026-09-21T02:00:00.000Z", "failed", { recorded: true, usd: 0.25 }),
    record("rebuild-on-merge", "2026-09-22T10:00:00.000Z", "lock-refused", { recorded: false, reason: "refused" }),
  ]);
  const view = await loadTriggerLedgerView(root, { recordsPerEntry: 5 });
  expect(view.config.kind).toBe("ok");
  const merge = findEntry(view, "rebuild-on-merge");
  expect(merge?.records.map((r) => r.outcome)).toEqual(["lock-refused", "ok"]);
  expect(merge?.latest?.outcome).toBe("lock-refused");
  expect(merge?.runCount).toBe(2);
  expect(eventEntries(view).map((e) => e.entry.name)).toEqual(["rebuild-on-merge"]);
  expect(scheduledEntries(view).map((e) => e.entry.name)).toEqual(["nightly"]);
  expect(isScheduledEntry(findEntry(view, "nightly")!.entry)).toBe(true);
  // Spend is the governance report's own figure: recorded USD, unrecorded counted apart.
  expect(view.spend).toEqual({
    state: "present",
    spentUsd: 0.25,
    runsWithCostRecorded: 1,
    runsWithCostNotRecorded: 2,
    runsTotal: 3,
    // No record is a flow dispatch, so none of it is shown under a flow.
    attributedToFlowsUsd: undefined,
    openReservations: 0,
    openReservedUsd: 0,
  });
});

test("recordsPerEntry caps the list but not runCount", async () => {
  const root = await project();
  await writeTriggers(root, [{ name: "t", on: { kind: "event", event: "ci" }, action: { kind: "rebuild" } }]);
  await appendRuns(
    root,
    Array.from({ length: 6 }, (_, i) => record("t", `2026-09-2${i}T00:00:00.000Z`, "ok", { recorded: false, reason: "x" })),
  );
  const view = await loadTriggerLedgerView(root, { recordsPerEntry: 2 });
  expect(findEntry(view, "t")?.records).toHaveLength(2);
  expect(findEntry(view, "t")?.runCount).toBe(6);
});

test("watcher: baseline is silent, an unchanged tick notifies nothing, each changed source is named", async () => {
  const root = await project();
  const timer = manualInterval();
  const watcher = createTriggerLedgerWatcher({ root, interval: timer.interval });
  const seen: Array<ReadonlySet<LedgerSource>> = [];
  watcher.subscribe((changed) => seen.push(changed));
  await watcher.ready;
  await timer.fire();
  expect(seen).toEqual([]);

  await writeTriggers(root, [{ name: "t", on: { kind: "event", event: "ci" }, action: { kind: "rebuild" } }]);
  await timer.fire();
  expect([...(seen.at(-1) ?? [])]).toEqual(["triggers"]);

  await appendRuns(root, [record("t", "2026-09-22T00:00:00.000Z", "ok", { recorded: false, reason: "x" })]);
  await writeReport(root, "2026-09-23T05:40:00.000Z");
  await timer.fire();
  expect(new Set(seen.at(-1))).toEqual(new Set<LedgerSource>(["runs", "governance"]));

  const before = seen.length;
  await timer.fire();
  expect(seen.length).toBe(before);
  watcher.stop();
});

test("watcher.check() is what the shell calls after a turn — same detection, no timer needed", async () => {
  const root = await project();
  const watcher = createTriggerLedgerWatcher({ root, interval: manualInterval().interval });
  await watcher.ready;
  await appendRuns(root, [record("t", "2026-09-22T00:00:00.000Z", "ok", { recorded: false, reason: "x" })]);
  expect([...(await watcher.check())]).toEqual(["runs"]);
  expect([...(await watcher.check())]).toEqual([]);
  watcher.stop();
});

test("triggerLedgerPaths names the three watched files", async () => {
  const root = await project();
  const paths = triggerLedgerPaths(root);
  expect(paths.runs).toBe(path.join(root, ".metaproject", "data", "trigger", "runs.jsonl"));
  expect(paths.triggers).toBe(path.join(root, ".metaproject", "triggers.json"));
  expect(paths.governance).toBe(path.join(root, ".metaproject", "data", "governance", "artifacts", "latest.json"));
});
