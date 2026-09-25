// Flow 341 (AC1/AC2) — `task-cost.ts`: recording, pure aggregation, and the
// on-disk rolling store. The pure section (recordTaskCost/statsForKey/
// allStats/statsFor/taskCostLookupFrom) never touches fs; the store section
// uses a fresh `mkdtemp` dir per test, never the real `~/.local/share/keryx`.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allStats,
  appendTaskCostRecord,
  EMPTY_TASK_COST_STORE,
  MAX_SAMPLES_PER_KEY,
  readTaskCostStore,
  recordTaskCost,
  statsFor,
  statsForKey,
  taskCostFilePath,
  taskCostKey,
  taskCostLookupFrom,
  UNCATEGORIZED,
  writeTaskCostStore,
  type TaskCostRecord,
  type TaskCostStore,
} from "./task-cost";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function rec(overrides: Partial<TaskCostRecord> = {}): TaskCostRecord {
  return {
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
    category: "subagents",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    success: true,
    recordedAt: 1_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure: keying, recording, aggregation
// ---------------------------------------------------------------------------

test("taskCostKey: joins provider/model/category; an undefined category falls to UNCATEGORIZED", () => {
  expect(taskCostKey("anthropic", "claude-sonnet-5", "subagents")).toBe("anthropic::claude-sonnet-5::subagents");
  expect(taskCostKey("anthropic", "claude-sonnet-5", undefined)).toBe(`anthropic::claude-sonnet-5::${UNCATEGORIZED}`);
});

test("recordTaskCost: pure — returns a NEW store, never mutates the input", () => {
  const before: TaskCostStore = {};
  const after = recordTaskCost(before, rec());
  expect(before).toEqual({});
  expect(after).not.toBe(before);
  expect(after["anthropic::claude-sonnet-5::subagents"]).toEqual([rec()]);
});

test("recordTaskCost: appends onto the same key across calls, oldest first", () => {
  let store: TaskCostStore = EMPTY_TASK_COST_STORE;
  store = recordTaskCost(store, rec({ recordedAt: 1 }));
  store = recordTaskCost(store, rec({ recordedAt: 2 }));
  const key = taskCostKey("anthropic", "claude-sonnet-5", "subagents");
  expect(store[key]!.map((r) => r.recordedAt)).toEqual([1, 2]);
});

test("recordTaskCost: the window is capped at MAX_SAMPLES_PER_KEY, dropping the OLDEST record first", () => {
  let store: TaskCostStore = EMPTY_TASK_COST_STORE;
  for (let i = 0; i < MAX_SAMPLES_PER_KEY + 5; i++) {
    store = recordTaskCost(store, rec({ recordedAt: i }));
  }
  const key = taskCostKey("anthropic", "claude-sonnet-5", "subagents");
  const kept = store[key]!;
  expect(kept.length).toBe(MAX_SAMPLES_PER_KEY);
  expect(kept[0]!.recordedAt).toBe(5); // the first 5 (0..4) were dropped
  expect(kept.at(-1)!.recordedAt).toBe(MAX_SAMPLES_PER_KEY + 4);
});

test("recordTaskCost: different categories for the same provider/model are separate keys", () => {
  let store: TaskCostStore = EMPTY_TASK_COST_STORE;
  store = recordTaskCost(store, rec({ category: "subagents" }));
  store = recordTaskCost(store, rec({ category: "docs" }));
  expect(Object.keys(store).sort()).toEqual(["anthropic::claude-sonnet-5::docs", "anthropic::claude-sonnet-5::subagents"]);
});

test("statsForKey: n, median tokens (even count averages the two middle values), success rate", () => {
  const records = [rec({ totalTokens: 100, success: true }), rec({ totalTokens: 300, success: false })];
  const s = statsForKey(records, "anthropic", "claude-sonnet-5", "subagents");
  expect(s).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5", category: "subagents", n: 2, medianTokens: 200, successRate: 0.5 });
});

test("statsForKey: median cost per task is computed ONLY from records with a known cost; a record with none is excluded, never treated as 0", () => {
  const records = [rec({ costUsd: 0.1 }), rec({ costUsd: 0.3 }), rec()]; // third has no costUsd at all
  const s = statsForKey(records, "anthropic", "claude-sonnet-5", "subagents");
  expect(s.medianCostUsd).toBe(0.2);
  expect(s.n).toBe(3); // n counts every record, cost or not
});

test("statsForKey: no record anywhere carries a cost — medianCostUsd is omitted entirely, never a fabricated number", () => {
  const s = statsForKey([rec(), rec()], "anthropic", "claude-sonnet-5", "subagents");
  expect("medianCostUsd" in s).toBe(false);
});

test("allStats: sorted by provider, then model, then category; empty keys never appear", () => {
  const store: TaskCostStore = {
    "openai::gpt-6::subagents": [rec({ providerId: "openai", modelId: "gpt-6" })],
    "anthropic::claude-sonnet-5::docs": [rec({ category: "docs" })],
    "anthropic::claude-sonnet-5::subagents": [rec()],
    "anthropic::claude-opus-5.5::subagents": [],
  };
  const rows = allStats(store);
  expect(rows.map((r) => `${r.providerId}/${r.modelId}/${r.category}`)).toEqual([
    "anthropic/claude-sonnet-5/docs",
    "anthropic/claude-sonnet-5/subagents",
    "openai/gpt-6/subagents",
  ]);
});

test("statsFor: undefined when nothing is recorded for that exact key", () => {
  const store = recordTaskCost(EMPTY_TASK_COST_STORE, rec({ category: "subagents" }));
  expect(statsFor(store, "anthropic", "claude-sonnet-5", "docs")).toBeUndefined();
  expect(statsFor(store, "anthropic", "claude-sonnet-5", "subagents")).toBeDefined();
});

test("taskCostLookupFrom: the TaskCostLookup shape derive-default-table.ts consumes — built from an already-loaded store, no disk access of its own", () => {
  const store = recordTaskCost(EMPTY_TASK_COST_STORE, rec({ costUsd: 0.05 }));
  const lookup = taskCostLookupFrom(store);
  expect(lookup("anthropic", "claude-sonnet-5", "subagents")?.medianCostUsd).toBe(0.05);
  expect(lookup("anthropic", "claude-sonnet-5", "docs")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Impure: the on-disk store — 0600, atomic, degrade-to-empty on any problem.
// ---------------------------------------------------------------------------

test("readTaskCostStore: a missing file reads as the empty store, never throws", async () => {
  const dir = await tempDir("keryx-task-cost-");
  expect(readTaskCostStore(dir)).toEqual({});
});

test("readTaskCostStore: malformed JSON reads as the empty store", async () => {
  const dir = await tempDir("keryx-task-cost-");
  await Bun.write(taskCostFilePath(dir), "{not json");
  expect(readTaskCostStore(dir)).toEqual({});
});

test("readTaskCostStore: a key whose array contains a malformed record is dropped wholesale", async () => {
  const dir = await tempDir("keryx-task-cost-");
  const good = taskCostKey("anthropic", "claude-sonnet-5", "subagents");
  const bad = taskCostKey("anthropic", "claude-opus-5.5", "subagents");
  await Bun.write(
    taskCostFilePath(dir),
    JSON.stringify({
      [good]: [rec()],
      [bad]: [{ providerId: "anthropic" }], // missing every other required field
    }),
  );
  const store = readTaskCostStore(dir);
  expect(Object.keys(store)).toEqual([good]);
});

test("writeTaskCostStore + readTaskCostStore: round-trips exactly, and the file is owner-only (0600)", async () => {
  const dir = await tempDir("keryx-task-cost-");
  const store = recordTaskCost(EMPTY_TASK_COST_STORE, rec());
  writeTaskCostStore(store, dir);
  expect(readTaskCostStore(dir)).toEqual(store);
  if (process.platform !== "win32") {
    const info = await stat(taskCostFilePath(dir));
    expect(info.mode & 0o777).toBe(0o600);
  }
});

test("appendTaskCostRecord: a fresh append onto an absent file creates and persists it", async () => {
  const dir = await tempDir("keryx-task-cost-");
  const ok = await appendTaskCostRecord(rec(), dir);
  expect(ok).toBe(true);
  const store = readTaskCostStore(dir);
  expect(store[taskCostKey("anthropic", "claude-sonnet-5", "subagents")]).toEqual([rec()]);
});

test("appendTaskCostRecord: two sequential appends both land (read-modify-write under a lock, not a blind overwrite)", async () => {
  const dir = await tempDir("keryx-task-cost-");
  await appendTaskCostRecord(rec({ recordedAt: 1 }), dir);
  await appendTaskCostRecord(rec({ recordedAt: 2 }), dir);
  const store = readTaskCostStore(dir);
  const key = taskCostKey("anthropic", "claude-sonnet-5", "subagents");
  expect(store[key]!.map((r) => r.recordedAt)).toEqual([1, 2]);
});

test("appendTaskCostRecord: concurrent appends to the SAME key never clobber each other (the lock actually serializes them)", async () => {
  const dir = await tempDir("keryx-task-cost-");
  await Promise.all(Array.from({ length: 8 }, (_, i) => appendTaskCostRecord(rec({ recordedAt: i }), dir)));
  const store = readTaskCostStore(dir);
  const key = taskCostKey("anthropic", "claude-sonnet-5", "subagents");
  expect(store[key]!.length).toBe(8);
  expect(new Set(store[key]!.map((r) => r.recordedAt)).size).toBe(8); // every one of the 8 survived — none overwritten
});
