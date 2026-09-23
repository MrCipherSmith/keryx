// Flow 286 T8, AC4: the fired-trigger record store.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendTriggerRunRecord,
  latestRunByTrigger,
  NO_MODEL_COST,
  openReservations,
  readTriggerRuns,
  triggerRunsPath,
  type TriggerRunRecord,
} from "./record";

async function tmpProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-trigger-record-"));
}

function baseRecord(trigger: string, at: string): Omit<TriggerRunRecord, "v"> {
  return {
    at,
    trigger,
    firedBy: { kind: "schedule", cron: "0 2 * * *" },
    action: { kind: "rebuild" },
    outcome: "ok",
    detail: 'action "rebuild" completed.',
    cost: NO_MODEL_COST,
  };
}

describe("triggerRunsPath", () => {
  test("lives under .metaproject/data/trigger, beside the run lock", () => {
    expect(triggerRunsPath("/repo")).toBe(path.join("/repo", ".metaproject", "data", "trigger", "runs.jsonl"));
  });
});

describe("appendTriggerRunRecord / readTriggerRuns", () => {
  test("no file yet: 'absent'", async () => {
    const root = await tmpProject();
    expect(await readTriggerRuns(root)).toEqual({ state: "absent", path: triggerRunsPath(root) });
  });

  test("append then read: one record, versioned, in file order", async () => {
    const root = await tmpProject();
    const appended = await appendTriggerRunRecord(root, baseRecord("nightly", "2026-09-22T19:00:00.000Z"));
    expect(appended.status).toBe("appended");

    const read = await readTriggerRuns(root);
    expect(read.state).toBe("present");
    if (read.state === "present") {
      expect(read.records).toHaveLength(1);
      expect(read.records[0]).toMatchObject({ v: 1, trigger: "nightly", outcome: "ok" });
    }
  });

  test("multiple records for the same trigger: all kept, in append order", async () => {
    const root = await tmpProject();
    await appendTriggerRunRecord(root, baseRecord("nightly", "2026-09-22T19:00:00.000Z"));
    await appendTriggerRunRecord(root, { ...baseRecord("nightly", "2026-09-22T20:00:00.000Z"), outcome: "failed", detail: "boom" });

    const read = await readTriggerRuns(root);
    expect(read.state).toBe("present");
    if (read.state === "present") {
      expect(read.records.map((r) => r.outcome)).toEqual(["ok", "failed"]);
    }
  });

  test("a damaged line: whole read is 'unreadable', not silently dropped", async () => {
    const root = await tmpProject();
    await appendTriggerRunRecord(root, baseRecord("nightly", "2026-09-22T19:00:00.000Z"));
    await mkdir(path.dirname(triggerRunsPath(root)), { recursive: true });
    await writeFile(triggerRunsPath(root), `${(await readFile(triggerRunsPath(root), "utf8")).trimEnd()}\n{not json\n`, "utf8");

    const read = await readTriggerRuns(root);
    expect(read.state).toBe("unreadable");
    if (read.state === "unreadable") expect(read.reason).toContain("could not be parsed");
  });

  test("the write is a pure append — an earlier record is never rewritten", async () => {
    const root = await tmpProject();
    await appendTriggerRunRecord(root, baseRecord("first", "2026-09-22T19:00:00.000Z"));
    const before = await readFile(triggerRunsPath(root), "utf8");
    await appendTriggerRunRecord(root, baseRecord("second", "2026-09-22T19:01:00.000Z"));
    const after = await readFile(triggerRunsPath(root), "utf8");
    expect(after.startsWith(before)).toBe(true);
  });

  test("survives real concurrent writers — every appended line lands intact and parseable", async () => {
    const root = await tmpProject();
    const writers = Array.from({ length: 25 }, (_, i) =>
      appendTriggerRunRecord(root, baseRecord(`t${i}`, new Date(2026, 8, 22, 19, 0, i).toISOString())),
    );
    const results = await Promise.all(writers);
    expect(results.every((r) => r.status === "appended")).toBe(true);

    const read = await readTriggerRuns(root);
    expect(read.state).toBe("present");
    if (read.state === "present") {
      expect(read.records).toHaveLength(25);
      const names = new Set(read.records.map((r) => r.trigger));
      expect(names.size).toBe(25); // every writer's own record is present, none clobbered another's
    }
  });
});

// Flow 297 (AC2): the "reserved" record can now additively carry the
// dispatch's flow/task, so an OPEN reservation is attributable — and a
// "reserved" record written BEFORE this change (no `dispatch` block) still
// reads, just with `flow`/`task` left `undefined` rather than guessed.
describe("openReservations: flow/task attribution (flow 297, AC2)", () => {
  function reservedRecord(runId: string, overrides: Partial<TriggerRunRecord> = {}): TriggerRunRecord {
    return {
      ...baseRecord("overnight", "2026-09-23T00:00:00.000Z"),
      v: 1,
      outcome: "reserved",
      detail: `reserved for ${runId}`,
      cost: { recorded: false, reason: "a reservation" },
      reservation: { runId, usd: 1 },
      ...overrides,
    };
  }

  test("a reservation whose record carries `dispatch` reports the flow and task it was opened for", () => {
    const records: TriggerRunRecord[] = [
      reservedRecord("run-1", { dispatch: { runId: "run-1", flow: "297", task: "T5" } }),
    ];
    const open = openReservations(records);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ runId: "run-1", flow: "297", task: "T5" });
  });

  test("a pre-change reservation record (no `dispatch` block) still reads, with flow/task left undefined — never a crash, never a guess", () => {
    const records: TriggerRunRecord[] = [reservedRecord("run-2")];
    const open = openReservations(records);
    expect(open).toHaveLength(1);
    expect(open[0]?.runId).toBe("run-2");
    expect(open[0]?.flow).toBeUndefined();
    expect(open[0]?.task).toBeUndefined();
  });

  test("a closing record for the same runId still closes the reservation, flow-attributed or not", () => {
    const records: TriggerRunRecord[] = [
      reservedRecord("run-3", { dispatch: { runId: "run-3", flow: "297", task: "T5" } }),
      {
        ...baseRecord("overnight", "2026-09-23T00:05:00.000Z"),
        v: 1,
        outcome: "ok",
        cost: { recorded: true, usd: 0.5 },
        dispatch: { runId: "run-3", flow: "297", task: "T5", closing: "done" },
      },
    ];
    expect(openReservations(records)).toEqual([]);
  });
});

describe("latestRunByTrigger", () => {
  test("last occurrence in file order wins, per trigger name", () => {
    const records: TriggerRunRecord[] = [
      { ...baseRecord("a", "t1"), v: 1, outcome: "failed" },
      { ...baseRecord("a", "t2"), v: 1, outcome: "ok" },
      { ...baseRecord("b", "t3"), v: 1, outcome: "no-op" },
    ];
    const latest = latestRunByTrigger(records);
    expect(latest.get("a")?.outcome).toBe("ok");
    expect(latest.get("a")?.at).toBe("t2");
    expect(latest.get("b")?.outcome).toBe("no-op");
    expect(latest.has("c")).toBe(false);
  });
});
