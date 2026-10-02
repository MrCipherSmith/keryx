// Offline coverage for the long-session instrumentation and runner plumbing (flow 387 T22a):
// mechanism counting, volume tracking, the codex volume heuristic, gold stripping + verification,
// emission gating, labelled filenames and the dry run. Synthetic data, temp dirs only.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedMessage } from "../../src/harness/provider/types";
import {
  CLEARED_PREFIX,
  COLLAPSED_PREFIX,
  MIN_VOLUME_TOKENS,
  MechanismTracker,
  VolumeTracker,
  codexVolume,
} from "./long-metrics";
import {
  dryRun,
  finalizeLongRun,
  goldPathsFor,
  labelledFilename,
  mechanismRollup,
  parseSeeds,
  stripAndVerifyGold,
  worktreeReader,
  type LongRunSample,
} from "./long-runner-shared";
import { LONG_GOLD_ARTIFACT_PATHS, LONG_TASKS } from "./long-tasks";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "long-metrics-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const msg = (role: NormalizedMessage["role"], content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ role, content, ...extra });

describe("MechanismTracker", () => {
  test("counts prune events apart from compactions; a missing kind is a compaction (pre-flow checkout)", () => {
    const t = new MechanismTracker();
    t.onContextCompaction({ kind: "prune" });
    t.onContextCompaction({ kind: "prune" });
    t.onContextCompaction({ kind: "compact" });
    t.onContextCompaction({});
    const c = t.finish([], 64000);
    expect(c.pruneEvents).toBe(2);
    expect(c.compactionEvents).toBe(2);
    expect(c.contextWindow).toBe(64000);
    expect(c.pruneHook).toBe("onContextCompaction");
    expect(c.fired).toEqual({ prune: true, collapse: true, compaction: true, spill: false });
  });

  test("reads cleared results, collapsed records and replay-carrying assistants from the final history", () => {
    const replay = { reasoning: { replay: [{ provider: "p", data: "x" }] } } as unknown as Partial<NormalizedMessage>;
    const history: NormalizedMessage[] = [
      msg("user", "task"),
      msg("assistant", `${COLLAPSED_PREFIX} — each full output is saved to the file named]\nread_file(a) -> ok, full output: /s/1.txt`),
      msg("assistant", "calling", replay),
      msg("tool", `${CLEARED_PREFIX} — full text: /s/2.txt]`),
      msg("tool", "fresh result"),
      msg("assistant", "another", replay),
      msg("assistant", "no reasoning"),
    ];
    const c = new MechanismTracker().finish(history, null);
    expect(c.clearedResults).toBe(1);
    expect(c.collapsedRecords).toBe(1);
    expect(c.assistantMessages).toBe(4);
    expect(c.replayCarryingAssistants).toBe(2);
    expect(c.contextWindow).toBeNull();
    expect(c.fired).toEqual({ prune: true, collapse: true, compaction: false, spill: false });
  });

  test("a run where nothing fired reports nothing fired", () => {
    const t = new MechanismTracker();
    t.onToolResult("plain output");
    const c = t.finish([msg("user", "q"), msg("assistant", "a"), msg("tool", "r")], 64000);
    expect(c.fired).toEqual({ prune: false, collapse: false, compaction: false, spill: false });
  });

  test("recognises a spill marker in a tool result", () => {
    const t = new MechanismTracker();
    t.onToolResult('head\n[output truncated: 2100 lines, 60000 bytes in total; full output saved to /s/tool-output/c1.txt — read it with read_file {"path": "/s/tool-output/c1.txt"}]\ntail');
    t.onToolResult("an ordinary result");
    const c = t.finish([], null);
    expect(c.spilledOutputs).toBe(1);
    expect(c.fired.spill).toBe(true);
  });
});

describe("VolumeTracker", () => {
  const prefix = "bench-long/svc/";

  test("counts distinct task files read, normalising ./ and repeats, and calls by kind", () => {
    const v = new VolumeTracker(prefix, 4, 10);
    v.onToolCall("read_file", JSON.stringify({ path: "bench-long/svc/mod-01.ts" }));
    v.onToolCall("read_file", JSON.stringify({ path: "./bench-long/svc/mod-01.ts" }));
    v.onToolCall("read_file", JSON.stringify({ path: "bench-long/svc/mod-02.ts" }));
    v.onToolCall("read_file", JSON.stringify({ path: "/abs/spill/tool-output/x.txt" }));
    v.onToolCall("read_file", "not json");
    v.onToolCall("search_code", "{}");
    v.onToolCall("shell_exec", "{}");
    v.onToolResult("a".repeat(400));
    const r = v.result();
    expect(r).toMatchObject({ toolCalls: 7, readFileCalls: 5, distinctPathsRead: 2, searchCalls: 1, shellCalls: 1, toolOutputChars: 400, estToolOutputTokens: 100 });
  });

  test("volumeOk needs 80% of the files AND the token floor: a grep over the corpus is not enough", () => {
    const grepper = new VolumeTracker(prefix, 22, 1000);
    grepper.onToolCall("search_code", "{}");
    grepper.onToolResult("x".repeat(40_000));
    expect(grepper.result().volumeOk).toBe(false);

    const faithful = new VolumeTracker(prefix, 5, 1000);
    for (let i = 0; i < 4; i += 1) faithful.onToolCall("read_file", JSON.stringify({ path: `${prefix}mod-0${i}.ts` }));
    faithful.onToolResult("x".repeat(4000));
    expect(faithful.result().volumeOk).toBe(true);

    const shallow = new VolumeTracker(prefix, 5, 1000);
    for (let i = 0; i < 4; i += 1) shallow.onToolCall("read_file", JSON.stringify({ path: `${prefix}mod-0${i}.ts` }));
    shallow.onToolResult("x");
    expect(shallow.result().volumeOk).toBe(false);
  });

  test("the default floor is the documented 60K tokens", () => {
    expect(MIN_VOLUME_TOKENS).toBe(60_000);
  });
});

describe("codexVolume", () => {
  const cmd = (command: string, out: string) => ({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: out } });

  test("counts commands, output size, search commands and distinct task paths named", () => {
    const events = [
      cmd("sed -n '1,200p' bench-long/registry/shards/shard-01.log", "a".repeat(800)),
      cmd("cat bench-long/registry/shards/shard-02.log", "b".repeat(800)),
      cmd("sed -n '1,50p' bench-long/registry/shards/shard-01.log", "c".repeat(400)),
      cmd("rg ZONE-SWITCH bench-long/registry/shards", "d".repeat(100)),
      { type: "turn.completed" },
    ];
    const v = codexVolume(events, "bench-long/registry/shards/", 2, 100);
    expect(v.toolCalls).toBe(4);
    expect(v.distinctPathsRead).toBe(2);
    expect(v.searchCalls).toBe(1);
    expect(v.toolOutputChars).toBe(2100);
    expect(v.volumeOk).toBe(true);
  });

  test("an empty stream is not volumeOk", () => {
    expect(codexVolume([], "bench-long/", 22).volumeOk).toBe(false);
  });
});

describe("gold stripping", () => {
  test("goldPathsFor adds the ablation-long result fixtures present in the worktree", () => {
    const root = tmp();
    mkdirSync(join(root, "fixtures/benchmark/keryx"), { recursive: true });
    writeFileSync(join(root, "fixtures/benchmark/keryx/ablation-long-results.json"), "{}");
    writeFileSync(join(root, "fixtures/benchmark/keryx/ablation-results.json"), "{}");
    const paths = goldPathsFor(root);
    expect(paths).toContain("fixtures/benchmark/keryx/ablation-long-results.json");
    expect(paths).not.toContain("fixtures/benchmark/keryx/ablation-results.json");
    for (const p of LONG_GOLD_ARTIFACT_PATHS) expect(paths).toContain(p);
  });

  test("stripAndVerifyGold removes every gold artifact, including this task's own source and a prior result fixture", () => {
    const root = tmp();
    mkdirSync(join(root, "scripts/benchmark"), { recursive: true });
    mkdirSync(join(root, "fixtures/benchmark/keryx"), { recursive: true });
    for (const p of [...LONG_GOLD_ARTIFACT_PATHS, "scripts/benchmark/mutating-tasks.ts", "scripts/benchmark/ablation-tasks.ts", "fixtures/benchmark/keryx/ablation-long-results-codex.json"]) {
      writeFileSync(join(root, p), "gold");
    }
    writeFileSync(join(root, "scripts/benchmark/token-metrics.ts"), "keep");
    stripAndVerifyGold(root);
    for (const p of [...LONG_GOLD_ARTIFACT_PATHS, "scripts/benchmark/mutating-tasks.ts", "scripts/benchmark/ablation-tasks.ts", "fixtures/benchmark/keryx/ablation-long-results-codex.json"]) {
      expect(existsSync(join(root, p))).toBe(false);
    }
    expect(existsSync(join(root, "scripts/benchmark/token-metrics.ts"))).toBe(true);
  });

  test("a worktree that does not exist cannot be verified clean: it throws, never 'passes'", () => {
    expect(() => stripAndVerifyGold(join(tmpdir(), "definitely-not-a-worktree-xyz"))).toThrow(/AC-5/);
  });
});

describe("plumbing", () => {
  test("parseSeeds accepts lists and rejects junk", () => {
    expect(parseSeeds("1,2,3")).toEqual([1, 2, 3]);
    expect(parseSeeds(" 2 ")).toEqual([2]);
    expect(() => parseSeeds("1,x")).toThrow();
    expect(() => parseSeeds("0")).toThrow();
  });

  test("labelledFilename keeps a baseline run from clobbering a flow run", () => {
    expect(labelledFilename("ablation-long-results.json", undefined)).toBe("ablation-long-results.json");
    expect(labelledFilename("ablation-long-results.json", "")).toBe("ablation-long-results.json");
    expect(labelledFilename("ablation-long-results.json", "Baseline Main")).toBe("ablation-long-results-baseline-main.json");
  });

  test("worktreeReader returns undefined for a missing file", () => {
    const root = tmp();
    writeFileSync(join(root, "a.txt"), "hi");
    const read = worktreeReader(root);
    expect(read("a.txt")).toBe("hi");
    expect(read("nope.txt")).toBeUndefined();
  });

  test("finalizeLongRun writes only when valid", async () => {
    const calls: string[] = [];
    const io = {
      writeResultsFixture: async () => void calls.push("write"),
      printManifest: () => void calls.push("print"),
      logLine: () => void calls.push("log"),
    };
    expect(await finalizeLongRun({}, {} as never, { valid: false, errors: ["bad"] }, "f.json", io)).toBe(1);
    expect(calls).not.toContain("write");
    expect(calls).not.toContain("print");
    expect(await finalizeLongRun({}, {} as never, { valid: true, errors: [] }, "f.json", io)).toBe(0);
    expect(calls).toContain("write");
    expect(calls).toContain("print");
  });

  test("dryRun seeds every long task and every oracle rejects the untouched tree", async () => {
    const lines: string[] = [];
    expect(await dryRun(LONG_TASKS, (l) => lines.push(l))).toBe(true);
    expect(lines).toHaveLength(LONG_TASKS.length);
    for (const l of lines) expect(l).toContain("pristine-tree oracle success=false");
  });

  test("mechanismRollup counts fired mechanisms over keryx runs only", () => {
    const base = { volume: { volumeOk: true }, success: true } as unknown as LongRunSample;
    const fired = (p: boolean, c: boolean) => ({ ...base, mechanisms: { fired: { prune: p, collapse: p, compaction: c, spill: false } } }) as unknown as LongRunSample;
    const cli = { ...base, mechanisms: null, success: false } as unknown as LongRunSample;
    const r = mechanismRollup([fired(true, false), fired(true, true), cli]);
    expect(r).toMatchObject({ runs: 3, withMechanisms: 2, anyPrune: 2, anyCompaction: 1, anySpill: 0, volumeOk: 3, successes: 2 });
  });
});
