// Offline coverage for the AC10/AC11 instrumentation (flow 387 T13a): usage accumulation,
// per-harness output parsing, repeated-read counting, aggregation and the verdict lines.
// Synthetic data only — no network, no runner, no fixture reads.

import { describe, expect, test } from "bun:test";
import {
  KeryxUsageAccumulator,
  RepeatedReadTracker,
  ac10Verdict,
  ac11Verdict,
  aggregateLeg,
  canonicalArgs,
  codexMetrics,
  fixtureFilename,
  grokMetrics,
  opencodeMetrics,
  renderTokenTable,
  type InstrumentedSeedSample,
  type LegAggregate,
  type LegFixture,
  type RepeatedReadMetrics,
  type TaskTokenMetrics,
} from "./token-metrics";
import { buildTokenEconomySection } from "./build-comparative-report";

function metrics(uncached: number | null, cached: number | null, output: number | null = 10, requests: number | null = 2): TaskTokenMetrics {
  return { uncachedInputTokens: uncached, cachedInputTokens: cached, cacheWriteTokens: null, outputTokens: output, requests };
}

function repeats(afterEither: number, repeated = afterEither): RepeatedReadMetrics {
  return { repeated, repeatedAfterCompaction: afterEither, repeatedAfterPrune: 0, repeatedAfterCompactionOrPrune: afterEither, pruneHook: null };
}

function sample(seed: number, success: boolean, m: TaskTokenMetrics, rr: RepeatedReadMetrics | null = null, model = "m"): InstrumentedSeedSample {
  return { seed, success, tokens: null, toolCalls: 1, model, metrics: m, repeatedReads: rr };
}

function leg(provider: string, model: string, samples: InstrumentedSeedSample[], taskId = "t1"): LegFixture {
  return {
    provider,
    model,
    tasks: [{ taskId, contextOn: { variant: "context-on", samples }, contextOff: { variant: "context-off", samples: [] } }],
  };
}

describe("KeryxUsageAccumulator", () => {
  test("sums every request; cacheRead is a subset of input", () => {
    const acc = new KeryxUsageAccumulator();
    acc.addUsage({ inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 50 });
    acc.addUsage({ inputTokens: 1500, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 70 });
    expect(acc.metrics()).toEqual({
      uncachedInputTokens: 900,
      cachedInputTokens: 1600,
      cacheWriteTokens: 100,
      outputTokens: 120,
      requests: 2,
    });
  });

  test("a request missing cacheRead makes cached and uncached null, never a partial sum", () => {
    const acc = new KeryxUsageAccumulator();
    acc.addUsage({ inputTokens: 1000, cacheReadTokens: 600, outputTokens: 5 });
    acc.addUsage({ inputTokens: 1000, outputTokens: 5 });
    const m = acc.metrics();
    expect(m.cachedInputTokens).toBeNull();
    expect(m.uncachedInputTokens).toBeNull();
    expect(m.outputTokens).toBe(10);
    expect(m.requests).toBe(2);
  });

  test("no requests yields all-null metrics", () => {
    expect(new KeryxUsageAccumulator().metrics().requests).toBeNull();
  });
});

describe("harness output parsers", () => {
  test("codex: uncached = input - cached; requests unknown", () => {
    const m = codexMetrics([
      { type: "thread.started" },
      { type: "turn.completed", usage: { input_tokens: 10000, cached_input_tokens: 7000, output_tokens: 300, reasoning_output_tokens: 50 } },
    ]);
    expect(m).toEqual({ uncachedInputTokens: 3000, cachedInputTokens: 7000, cacheWriteTokens: null, outputTokens: 300, requests: null });
  });

  test("codex: no turn.completed or missing cached field -> all null", () => {
    expect(codexMetrics([{ type: "thread.started" }]).uncachedInputTokens).toBeNull();
    const m = codexMetrics([{ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }]);
    expect(m.cachedInputTokens).toBeNull();
    expect(m.uncachedInputTokens).toBeNull();
  });

  test("opencode: input is already uncached; sums step_finish events", () => {
    const step = (input: number, read: number, write: number, output: number) => ({
      type: "step_finish",
      part: { tokens: { input, output, reasoning: 0, cache: { read, write }, total: input + output + read + write } },
    });
    const m = opencodeMetrics([step(100, 900, 50, 20), { type: "tool_use" }, step(200, 1100, 0, 30)]);
    expect(m).toEqual({ uncachedInputTokens: 300, cachedInputTokens: 2000, cacheWriteTokens: 50, outputTokens: 50, requests: 2 });
  });

  test("opencode: missing cache block keeps uncached but nulls cached", () => {
    const m = opencodeMetrics([{ type: "step_finish", part: { tokens: { input: 10, output: 2 } } }]);
    expect(m.uncachedInputTokens).toBe(10);
    expect(m.cachedInputTokens).toBeNull();
  });

  test("grok: no cached field -> uncached null (never assumed), requests from num_turns", () => {
    const m = grokMetrics({ usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, num_turns: 4 });
    expect(m).toEqual({ uncachedInputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 10, requests: 4 });
  });

  test("grok: OpenAI-style cached_tokens detail is honoured", () => {
    const m = grokMetrics({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } }, num_turns: 2 });
    expect(m.uncachedInputTokens).toBe(40);
    expect(m.cachedInputTokens).toBe(60);
  });
});

describe("RepeatedReadTracker", () => {
  test("counts exact repeats of read_file/search_code only, argument key order ignored", () => {
    const t = new RepeatedReadTracker();
    t.onToolCall("read_file", '{"path":"a.ts","limit":10}');
    t.onToolCall("read_file", '{"limit":10,"path":"a.ts"}');
    t.onToolCall("read_file", '{"path":"b.ts"}');
    t.onToolCall("shell_exec", '{"command":"ls"}');
    t.onToolCall("shell_exec", '{"command":"ls"}');
    t.onToolCall("search_code", '{"pattern":"x"}');
    t.onToolCall("search_code", '{"pattern":"x"}');
    expect(t.result()).toMatchObject({ repeated: 2, repeatedAfterCompaction: 0, repeatedAfterCompactionOrPrune: 0 });
  });

  test("a repeat counts after compaction only when the event falls between the identical calls", () => {
    const t = new RepeatedReadTracker();
    t.onToolCall("read_file", '{"path":"a.ts"}');
    t.onCompaction();
    t.onToolCall("read_file", '{"path":"a.ts"}'); // repeat, compaction in between -> counted
    t.onToolCall("read_file", '{"path":"a.ts"}'); // repeat, no new event since the last identical call -> not counted
    expect(t.result()).toMatchObject({ repeated: 2, repeatedAfterCompaction: 1, repeatedAfterCompactionOrPrune: 1 });
  });

  test("prune events are counted separately and in the combined figure, once per repeat", () => {
    const t = new RepeatedReadTracker("onContextPrune");
    t.onToolCall("read_file", '{"path":"a.ts"}');
    t.onPrune();
    t.onCompaction();
    t.onToolCall("read_file", '{"path":"a.ts"}');
    expect(t.result()).toEqual({
      repeated: 1,
      repeatedAfterCompaction: 1,
      repeatedAfterPrune: 1,
      repeatedAfterCompactionOrPrune: 1,
      pruneHook: "onContextPrune",
    });
  });

  test("canonicalArgs falls back to the trimmed raw string for non-JSON", () => {
    expect(canonicalArgs("  not json ")).toBe("not json");
  });
});

describe("aggregateLeg", () => {
  test("means, success rate and repeated-read totals", () => {
    const agg = aggregateLeg(
      leg("deepseek", "m", [sample(1, true, metrics(100, 50), repeats(1)), sample(2, false, metrics(300, 150), repeats(2, 3))]),
    );
    expect(agg).toMatchObject({
      harness: "keryx",
      meanUncachedInput: 200,
      meanCachedInput: 100,
      meanOutput: 10,
      meanRequests: 2,
      successRate: 0.5,
      repeatedReadTotals: { repeated: 4, afterCompactionOrPrune: 3 },
    });
    expect(agg.gaps).toEqual([]);
  });

  test("a harness leg name is derived from a *-cli provider", () => {
    expect(aggregateLeg(leg("codex-cli", "g", [sample(1, true, metrics(1, 1))])).harness).toBe("codex");
  });

  test("a null figure in any run nulls the mean and records why", () => {
    const agg = aggregateLeg(leg("codex-cli", "g", [sample(1, true, metrics(100, 50)), sample(2, true, metrics(null, null))]));
    expect(agg.meanUncachedInput).toBeNull();
    expect(agg.gaps.join(" ")).toContain("uncached input not reported");
  });

  test("uninstrumented legacy samples give null means and a gap, success rate still computed", () => {
    const legacy = { seed: 1, success: true, tokens: 5, toolCalls: 1 };
    const agg = aggregateLeg({
      provider: "deepseek",
      model: "m",
      tasks: [{ taskId: "t1", contextOn: { variant: "context-on", samples: [legacy] }, contextOff: { variant: "context-off", samples: [] } }],
    });
    expect(agg.meanUncachedInput).toBeNull();
    expect(agg.successRate).toBe(1);
    expect(agg.gaps[0]).toContain("no token instrumentation");
  });
});

function agg(provider: string, model: string, uncached: number | null, extra: Partial<LegFixture> = {}, taskId = "t1"): LegAggregate {
  return aggregateLeg({ ...leg(provider, model, [sample(1, true, metrics(uncached, 0))], taskId), ...extra });
}

describe("ac10Verdict", () => {
  test("met when keryx is the lowest", () => {
    const v = ac10Verdict([agg("deepseek", "m", 100), agg("codex-cli", "g", 500), agg("opencode-cli", "o", 300)]);
    expect(v.status).toBe("met");
    expect(v.line).toContain("model mismatch disclosed");
  });

  test("met when within 5% of the lowest, not met just beyond", () => {
    expect(ac10Verdict([agg("deepseek", "m", 105), agg("codex-cli", "m", 100)]).status).toBe("met");
    expect(ac10Verdict([agg("deepseek", "m", 106), agg("codex-cli", "m", 100)]).status).toBe("not met");
  });

  test("no model-mismatch caveat when every leg uses the same model", () => {
    expect(ac10Verdict([agg("deepseek", "m", 100), agg("codex-cli", "m", 100)]).line).not.toContain("mismatch");
  });

  test("not comparable: no keryx leg, a single leg, missing figure, differing task sets", () => {
    expect(ac10Verdict([agg("codex-cli", "g", 1), agg("opencode-cli", "o", 2)]).status).toBe("not comparable");
    expect(ac10Verdict([agg("deepseek", "m", 1)]).line).toContain("only one leg");
    const missing = ac10Verdict([agg("deepseek", "m", 100), agg("grok-cli", "x", null)]);
    expect(missing.status).toBe("not comparable");
    expect(missing.line).toContain("grok/x");
    const diffTasks = ac10Verdict([agg("deepseek", "m", 100), agg("codex-cli", "g", 100, {}, "t2")]);
    expect(diffTasks.status).toBe("not comparable");
    expect(diffTasks.line).toContain("task sets differ");
  });
});

describe("ac11Verdict", () => {
  const keryx = (ok: boolean, after: number): LegAggregate =>
    aggregateLeg(leg("deepseek", "m", [sample(1, ok, metrics(1, 1), repeats(after))]));

  test("met when success holds and repeat count is not higher", () => {
    expect(ac11Verdict(keryx(true, 1), keryx(true, 3)).status).toBe("met");
    expect(ac11Verdict(keryx(true, 3), keryx(true, 3)).status).toBe("met");
  });

  test("not met on lower success or more repeats", () => {
    expect(ac11Verdict(keryx(false, 0), keryx(true, 3)).status).toBe("not met");
    expect(ac11Verdict(keryx(true, 4), keryx(true, 3)).status).toBe("not met");
  });

  test("not comparable without a baseline, with differing tasks, or without repeat data", () => {
    expect(ac11Verdict(keryx(true, 0), undefined).line).toContain("--baseline");
    expect(ac11Verdict(keryx(true, 0), aggregateLeg(leg("deepseek", "m", [sample(1, true, metrics(1, 1), repeats(0))], "other"))).line).toContain("task sets differ");
    const noRepeats = aggregateLeg(leg("deepseek", "m", [sample(1, true, metrics(1, 1), null)]));
    const v = ac11Verdict(keryx(true, 0), noRepeats);
    expect(v.status).toBe("not comparable");
    expect(v.line).toContain("baseline");
  });
});

describe("report assembly and filenames", () => {
  test("buildTokenEconomySection renders the table and both verdict lines", () => {
    const section = buildTokenEconomySection(
      [
        leg("deepseek", "m", [sample(1, true, metrics(100, 40), repeats(0))]),
        leg("codex-cli", "g", [sample(1, false, metrics(900, 100))]),
      ],
      leg("deepseek", "m", [sample(1, true, metrics(120, 40), repeats(2))]),
    );
    expect(section.ac10.status).toBe("met");
    expect(section.ac11.status).toBe("met");
    expect(section.markdown).toContain("| keryx | m | context-on | 100 | 40 | 10 | 2 | 100% (n=1) |");
    expect(section.markdown).toContain("| codex | g | context-on | 900 | 100 | 10 | 2 | 0% (n=1) |");
    expect(section.markdown).toContain("AC10: met");
    expect(section.markdown).toContain("AC11: met");
  });

  test("renderTokenTable shows n/a for missing figures", () => {
    expect(renderTokenTable([agg("grok-cli", "x", null)])).toContain("| grok | x | context-on | n/a |");
  });

  test("fixtureFilename keeps the legacy name for the default model and keys any other on the model", () => {
    expect(fixtureFilename("r-codex.json", "gpt-5.6-sol", "gpt-5.6-sol")).toBe("r-codex.json");
    expect(fixtureFilename("r-codex.json", "gpt-5.6-sol", "gpt-6.1-sol")).toBe("r-codex-gpt-6.1-sol.json");
    expect(fixtureFilename("r-opencode.json", "d", "opencode/Some Model:x")).toBe("r-opencode-opencode-some-model-x.json");
  });
});
