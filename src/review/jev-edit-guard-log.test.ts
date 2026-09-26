import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendEditGuardLog,
  editGuardTodayStats,
  type EditGuardLogRecord,
  EDIT_GUARD_LOG_PATH,
  readEditGuardLogRecords,
  recentEditGuardFlags,
} from "./jev-edit-guard-log";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keryx-edit-guard-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<EditGuardLogRecord> = {}): EditGuardLogRecord {
  return {
    at: new Date().toISOString(),
    file: "src/a.ts",
    tool: "Edit",
    status: "clean",
    latencyMs: 10,
    jevCalls: 1,
    threshold: 0.5,
    flags: [],
    ...overrides,
  };
}

describe("readEditGuardLogRecords", () => {
  test("no file at all -> []", async () => {
    expect(await readEditGuardLogRecords(dir)).toEqual([]);
  });

  test("round-trips an appended record", async () => {
    await appendEditGuardLog(dir, record({ status: "flagged", flags: [{ ruleId: "r1", clauseId: "c1", file: "src/a.ts", line: 3, probability: 0.8 }] }));
    const records = await readEditGuardLogRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("flagged");
    expect(records[0]!.flags).toHaveLength(1);
  });

  test("appends without clobbering prior lines", async () => {
    await appendEditGuardLog(dir, record({ file: "src/a.ts" }));
    await appendEditGuardLog(dir, record({ file: "src/b.ts" }));
    const records = await readEditGuardLogRecords(dir);
    expect(records.map((r) => r.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a malformed line is dropped, not thrown over, and does not blind the reader to good lines", async () => {
    await appendEditGuardLog(dir, record({ file: "src/a.ts" }));
    const file = path.join(dir, EDIT_GUARD_LOG_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record({ file: "src/a.ts" }))}\nnot json at all\n{"missing":"required fields"}\n`);
    const records = await readEditGuardLogRecords(dir);
    expect(records).toHaveLength(1);
  });
});

describe("editGuardTodayStats", () => {
  test("sums only today's records (UTC calendar date)", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const today = record({ at: "2026-06-15T00:00:01.000Z", jevCalls: 2, costUsd: 0.01, flags: [{ ruleId: "r", clauseId: "c", file: "a", line: 1, probability: 0.9 }] });
    const yesterday = record({ at: "2026-06-14T23:59:59.000Z", jevCalls: 5, costUsd: 0.5 });
    expect(editGuardTodayStats([today, yesterday], now)).toEqual({ calls: 2, flagged: 1, costUsd: 0.01 });
  });

  test("empty log -> all zero", () => {
    expect(editGuardTodayStats([])).toEqual({ calls: 0, flagged: 0, costUsd: 0 });
  });
});

describe("recentEditGuardFlags", () => {
  test("flattens flags newest-record-first, capped at the limit", () => {
    const older = record({ at: "2026-01-01T00:00:00.000Z", flags: [{ ruleId: "r1", clauseId: "c1", file: "a", line: 1, probability: 0.6 }] });
    const newer = record({ at: "2026-01-02T00:00:00.000Z", flags: [{ ruleId: "r2", clauseId: "c2", file: "b", line: 2, probability: 0.7 }] });
    const flat = recentEditGuardFlags([older, newer], 10);
    expect(flat.map((f) => f.ruleId)).toEqual(["r2", "r1"]);
  });

  test("respects the limit", () => {
    const records = Array.from({ length: 5 }, (_, i) => record({ flags: [{ ruleId: `r${i}`, clauseId: "c", file: "a", line: 1, probability: 0.5 }] }));
    expect(recentEditGuardFlags(records, 2)).toHaveLength(2);
  });
});
