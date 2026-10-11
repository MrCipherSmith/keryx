import { describe, expect, test } from "bun:test";
import { checkDispatch } from "./dispatch-check";
import { MAX_RETRY_ROUNDS, type RetryState, notRunLine, planRetry } from "./retry-plan";
import { DEFAULT_WAVE_BYTES, buildSlices, packWaves, sliceSourceFromDiff, validateWaveBytes, waveBytesOf } from "./slice";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_context: {
      request: { raw: "review the change" },
      scope: { mode: "diff", files: ["src/a.ts"] },
      routing: { selected_reviewers: ["review-logic"] },
      token_policy: { context_mode: "light", omissions: [] },
    },
    reviewer: "review-logic",
    scope_mode: "diff",
    model: { tier: "standard", tier_reasons: ["base"], tier_resolution: "session-fallback", model_discovery: {}, inherit: true },
    budget: { max_findings: 10 },
    ...overrides,
  };
}

function gitFile(filePath: string, count: number): string {
  const lines = Array.from({ length: count }, (_, n) => `+const v${n} = ${n};`);
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,0 +1,${count} @@\n${lines.join("\n")}\n`;
}

describe("checkDispatch", () => {
  test("a diff-scope payload with no slice and no diff is refused with REVIEWER_INPUT_NO_SLICE", async () => {
    const result = await checkDispatch([payload()]);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("REVIEWER_INPUT_NO_SLICE");
  });

  test("a payload that breaks the schema is REVIEWER_INPUT_INVALID", async () => {
    const result = await checkDispatch([payload({ budget: { max_findings: 0 }, slices: ["slice-01"] })], {
      pathBytes: () => 10,
    });
    expect(result.errors.some((error) => error.code === "REVIEWER_INPUT_INVALID")).toBe(true);
  });

  test("a named slice that fits passes; one over the ceiling is refused", async () => {
    const manifest = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 5))).manifest;
    const fits = await checkDispatch([payload({ slices: ["slice-01"] })], { manifest });
    expect(fits.errors).toEqual([]);
    expect(fits.ok).toBe(true);

    const over = await checkDispatch([payload({ slices: ["slice-01"] })], { manifest, maxBytes: 10 });
    expect(over.errors.map((error) => error.code)).toEqual(["REVIEWER_INPUT_TOO_LARGE"]);
  });

  test("an unknown slice is REVIEWER_INPUT_SLICE_UNKNOWN", async () => {
    const manifest = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 5))).manifest;
    const result = await checkDispatch([payload({ slices: ["slice-99"] })], { manifest });
    expect(result.errors.map((error) => error.code)).toEqual(["REVIEWER_INPUT_SLICE_UNKNOWN"]);
  });

  test("a whole-diff string over the ceiling is refused, a small one passes, path scope needs no slice", async () => {
    const big = await checkDispatch([payload({ diff: "x".repeat(500) })], { maxBytes: 300 });
    expect(big.errors.map((error) => error.code)).toEqual(["REVIEWER_INPUT_TOO_LARGE"]);
    const small = await checkDispatch([payload({ diff: "x".repeat(100) })], { maxBytes: 300 });
    expect(small.ok).toBe(true);
    const path = await checkDispatch([payload({ scope_mode: "path", target_path: "src/a.ts" })]);
    expect(path.ok).toBe(true);
  });
});

describe("planRetry", () => {
  const diff = Array.from({ length: 6 }, (_, index) => gitFile(`src/m/f${index}.ts`, 60)).join("");
  const built = buildSlices(sliceSourceFromDiff(diff), { maxBytes: 20_000 });
  const textOf = (id: string): string => built.slices.find((slice) => slice.id === id)!.text;
  const base = {
    manifest: built.manifest,
    reviewer: "review-logic",
    readSliceText: (entry: { id: string }) => textOf(entry.id),
  };
  const empty = { schemaVersion: 1 as const, reviewers: {} };

  test("a finished status is accepted", () => {
    const plan = planRetry({ ...base, result: { status: "DONE" }, state: empty });
    expect(plan.decision).toBe("accepted");
  });

  test("the first INCOMPLETE gets one retry on slices at most half the size", () => {
    const largest = Math.max(...built.manifest.slices.map((slice) => slice.bytes));
    const plan = planRetry({ ...base, result: { status: "INCOMPLETE" }, state: empty });
    expect(plan.decision).toBe("retry");
    expect(plan.newSlices.length).toBeGreaterThan(built.manifest.slices.length);
    for (const slice of plan.newSlices) {
      expect(slice.bytes).toBeLessThanOrEqual(largest / 2);
      expect(slice.id.startsWith("r1-review-logic-")).toBe(true);
      expect(slice.attempt).toBe(1);
    }
    expect(plan.state.reviewers["review-logic"]).toEqual({ attempt: 1, status: "INCOMPLETE", notRun: false, stalls: 1, covered: [] });
  });

  test("a second failure is not-run with the report line, and is never retried again", () => {
    const first = planRetry({ ...base, result: { status: "INCOMPLETE" }, state: empty });
    const second = planRetry({ ...base, result: { status: "BLOCKED" }, state: first.state });
    expect(second.decision).toBe("not-run");
    expect(second.reportLine).toBe(notRunLine("review-logic", "BLOCKED"));
    expect(second.reportLine).toContain("- **Not run:** review-logic");
    expect(second.reportLine).toContain("never counted as a clean pass");
    expect(second.newSlices).toEqual([]);
    expect(second.state.reviewers["review-logic"]?.notRun).toBe(true);
  });

  test("the attempt in the result itself also counts", () => {
    const plan = planRetry({ ...base, result: { status: "INCOMPLETE", attempt: 1 }, state: empty });
    expect(plan.decision).toBe("not-run");
  });

  test("NEEDS_CONTEXT is not terminal: the first one asks for an answer, the second is not-run", () => {
    const first = planRetry({ ...base, result: { status: "NEEDS_CONTEXT", needs_context: ["which slices were unread?"] }, state: empty });
    expect(first.decision).toBe("context");
    expect(first.needsContext).toEqual(["which slices were unread?"]);
    expect(first.reason).toContain("scope is not closed");
    expect(first.newSlices).toEqual([]);
    expect(first.state.reviewers["review-logic"]).toEqual({ attempt: 1, status: "NEEDS_CONTEXT", notRun: false, stalls: 1, covered: [] });
    const second = planRetry({ ...base, result: { status: "NEEDS_CONTEXT" }, state: first.state });
    expect(second.decision).toBe("not-run");
    expect(second.state.reviewers["review-logic"]?.notRun).toBe(true);
  });

  test("a slice too small to halve is not-run rather than an endless retry", () => {
    const tiny = buildSlices(sliceSourceFromDiff(gitFile("src/t.ts", 1)));
    const plan = planRetry({
      manifest: tiny.manifest,
      result: { status: "INCOMPLETE" },
      reviewer: "review-logic",
      state: empty,
      readSliceText: () => tiny.slices[0]!.text,
    });
    expect(plan.decision).toBe("not-run");
  });
});

describe("waves", () => {
  const diff = Array.from({ length: 12 }, (_, index) => gitFile(`src/w${index}/f.ts`, 200)).join("");
  const built = buildSlices(sliceSourceFromDiff(diff), { maxBytes: 6_000, waveBytes: 12_000 });
  const ids = built.manifest.slices.map((slice) => slice.id);
  const textOf = (id: string): string => built.slices.find((slice) => slice.id === id)!.text;
  const base = { manifest: built.manifest, reviewer: "review-logic", readSliceText: (entry: { id: string }) => textOf(entry.id) };
  const empty: RetryState = { schemaVersion: 1, reviewers: {} };

  test("the manifest carries a wave budget no smaller than the slice ceiling", () => {
    expect(built.manifest.waveBytes).toBe(12_000);
    expect(waveBytesOf(buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 3)), { maxBytes: 10_000 }).manifest)).toBe(DEFAULT_WAVE_BYTES);
    expect(waveBytesOf({ maxBytes: built.manifest.maxBytes })).toBe(Math.max(built.manifest.maxBytes, DEFAULT_WAVE_BYTES));
    expect(() => validateWaveBytes(100, 6_000)).toThrow("Invalid --wave-bytes");
  });

  test("packWaves keeps each wave within the budget and lets an oversize entry travel alone", () => {
    const waves = packWaves(built.manifest.slices, 12_000);
    for (const wave of waves) {
      const total = wave.reduce((sum, slice) => sum + slice.bytes, 0);
      expect(total <= 12_000 || wave.length === 1).toBe(true);
    }
    expect(waves.flat().map((slice) => slice.id)).toEqual(ids);
    expect(packWaves([{ bytes: 50 }, { bytes: 10 }], 20)).toEqual([[{ bytes: 50 }], [{ bytes: 10 }]]);
  });

  test("dispatch-check allows a wave at the wave ceiling and refuses one above it", async () => {
    const wave = packWaves(built.manifest.slices, 12_000)[0]!.map((slice) => slice.id);
    const fits = await checkDispatch([payload({ slices: wave })], { manifest: built.manifest });
    expect(fits.errors).toEqual([]);
    expect(fits.maxBytes).toBe(12_000);
    const over = await checkDispatch([payload({ slices: ids.slice(0, wave.length + 1) })], { manifest: built.manifest });
    expect(over.errors.map((error) => error.code)).toEqual(["REVIEWER_INPUT_TOO_LARGE"]);
    expect(over.errors[0]!.message).toContain("retry-plan");
  });

  test("a reviewer that covers new slices is not spent: the next wave is handed out with no stall", () => {
    let state = empty;
    const covered: string[] = [];
    for (let round = 1; round <= 5; round += 1) {
      const next = ids.filter((id) => !covered.includes(id)).slice(0, 2);
      const plan = planRetry({ ...base, result: { status: "INCOMPLETE", slices: next }, state });
      covered.push(...next);
      expect(plan.progress).toBe(true);
      expect(plan.stalls).toBe(0);
      expect(plan.decision).toBe("retry");
      expect(plan.newSlices).toEqual([]);
      expect(plan.wave.every((slice) => !covered.includes(slice.id))).toBe(true);
      state = plan.state;
    }
    expect(state.reviewers["review-logic"]?.covered?.length).toBe(10);
  });

  test("a result with nothing new spends an attempt; the second in a row is not-run", () => {
    const first = planRetry({ ...base, result: { status: "INCOMPLETE", slices: [ids[0]!] }, state: empty });
    const stalled = planRetry({ ...base, result: { status: "INCOMPLETE", slices: [ids[0]!] }, state: first.state });
    expect(stalled.progress).toBe(false);
    expect(stalled.stalls).toBe(1);
    expect(stalled.decision).toBe("retry");
    expect(stalled.newSlices.length).toBeGreaterThan(0);
    const dead = planRetry({ ...base, result: { status: "BLOCKED", slices: [ids[0]!] }, state: stalled.state });
    expect(dead.decision).toBe("not-run");
    expect(dead.state.reviewers["review-logic"]?.notRun).toBe(true);
  });

  test("progress resets the stall count, so progress between stalls keeps the reviewer alive", () => {
    const a = planRetry({ ...base, result: { status: "INCOMPLETE" }, state: empty });
    expect(a.stalls).toBe(1);
    const b = planRetry({ ...base, result: { status: "INCOMPLETE", slices: [ids[0]!] }, state: a.state });
    expect(b.stalls).toBe(0);
    expect(b.decision).toBe("retry");
  });

  test("the round cap ends a reviewer that keeps making slow progress", () => {
    let state = empty;
    let decision = "";
    for (let round = 0; round <= MAX_RETRY_ROUNDS; round += 1) {
      const plan = planRetry({ ...base, result: { status: "INCOMPLETE", slices: [ids[round % ids.length]!] }, state });
      decision = plan.decision;
      state = plan.state;
      if (round < MAX_RETRY_ROUNDS) expect(plan.decision).toBe("retry");
    }
    expect(decision).toBe("not-run");
  });

  test("a finished result with slices still open is a wave, and with all covered it is accepted", () => {
    const partial = planRetry({ ...base, result: { status: "DONE", slices: ids.slice(0, 2) }, state: empty });
    expect(partial.decision).toBe("wave");
    expect(partial.remaining.slices).toBe(ids.length - 2);
    expect(partial.remaining.waves).toBeGreaterThan(1);
    expect(partial.wave.reduce((sum, slice) => sum + slice.bytes, 0)).toBeLessThanOrEqual(12_000);
    const rest = planRetry({ ...base, result: { status: "DONE", slices: ids.slice(2) }, state: partial.state });
    expect(rest.decision).toBe("accepted");
    expect(rest.remaining.slices).toBe(0);
  });

  test("--next-wave with no result plans the first wave and counts no stall", () => {
    const plan = planRetry({ ...base, result: {}, nextWave: true, state: empty });
    expect(plan.decision).toBe("wave");
    expect(plan.stalls).toBe(0);
    expect(plan.wave.length).toBeGreaterThan(0);
    expect(plan.remaining.slices).toBe(ids.length);
    expect(plan.state.reviewers["review-logic"]?.attempt).toBe(0);
  });

  test("a legacy retry state without scope identity is invalidated", () => {
    const legacy = { schemaVersion: 1 as const, reviewers: { "review-logic": { attempt: 1, status: "INCOMPLETE", notRun: false } } };
    expect(() => planRetry({ ...base, result: { status: "BLOCKED" }, state: legacy })).toThrow("current scope");
    const fresh = planRetry({ ...base, result: {}, nextWave: true, state: legacy });
    expect(fresh.decision).toBe("wave");
    expect(fresh.priorAttempts).toBe(0);
    expect(fresh.stalls).toBe(0);
    expect(fresh.remaining.slices).toBe(ids.length);
  });

  test("covering one piece of a re-cut does not credit the slice it was cut from", () => {
    const failed = planRetry({ ...base, result: { status: "INCOMPLETE" }, state: empty });
    const added = { ...built.manifest, slices: [...built.manifest.slices, ...failed.newSlices.map(({ text: _text, ...entry }) => entry)] };
    const piece = failed.newSlices[0]!.id;
    const next = planRetry({ ...base, manifest: added, result: { status: "INCOMPLETE", slices: [piece] }, state: failed.state });
    expect(next.progress).toBe(true);
    expect(next.remaining.slices).toBeGreaterThan(0);
    expect(next.wave.map((slice) => slice.id)).not.toContain(piece);
  });
});

describe("autonomy hardening retry regressions", () => {
  const built = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 20)));
  const base = { manifest: built.manifest, reviewer: "review-logic", readSliceText: () => built.slices[0]!.text };
  test("DONE with open needs_context requests context instead of acceptance", () => {
    const plan = planRetry({ ...base, result: { status: "DONE", needs_context: ["which contract applies?"] }, state: { schemaVersion: 1, reviewers: {} } });
    expect(plan.decision).toBe("context");
    expect(plan.needsContext).toEqual(["which contract applies?"]);
  });
  test("legacy covered IDs do not accept a regenerated manifest without fresh review", () => {
    const stale = { schemaVersion: 1 as const, reviewers: { "review-logic": { attempt: 1, status: "DONE", notRun: false, covered: built.manifest.slices.map(s => s.id), stalls: 0 } } };
    const changed = buildSlices(sliceSourceFromDiff(gitFile("src/new.ts", 20)));
    const plan = planRetry({ ...base, manifest: changed.manifest, readSliceText: () => changed.slices[0]!.text, result: {}, nextWave: true, state: stale });
    expect(plan.decision).toBe("wave");
    expect(plan.remaining.slices).toBeGreaterThan(0);
  });
});

test("same-size content rewrite invalidates coverage and stalls", () => {
  const built = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 20)));
  const base = { manifest: built.manifest, reviewer: "review-logic", readSliceText: () => built.slices[0]!.text };
  const first = planRetry({ ...base, result: { status: "DONE", slices: built.manifest.slices.map(s => s.id) }, state: { schemaVersion: 1, reviewers: {} } });
  expect(first.decision).toBe("accepted");
  const next = planRetry({ ...base, readSliceText: () => built.slices[0]!.text.replace("src/a.ts", "src/z.ts"), result: {}, nextWave: true, state: first.state });
  expect(next.decision).toBe("wave");
  expect(next.priorAttempts).toBe(0);
  expect(next.remaining.slices).toBeGreaterThan(0);
});

test("stale incoming coverage and attempts cannot repopulate a changed scope", () => {
  const built = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 20)));
  const base = { manifest: built.manifest, reviewer: "review-logic", readSliceText: () => built.slices[0]!.text };
  const first = planRetry({ ...base, result: { status: "DONE", slices: built.manifest.slices.map(s => s.id) }, state: { schemaVersion: 1, reviewers: {} } });
  const changed = { ...base, readSliceText: () => built.slices[0]!.text.replace("src/a.ts", "src/z.ts"), state: first.state };
  const stale = { status: "DONE", attempt: 6, slices: built.manifest.slices.map(s => s.id) };
  expect(() => planRetry({ ...changed, result: stale })).toThrow("current scope");
  expect(() => planRetry({ ...changed, result: { ...stale, scopeFingerprint: first.state.scopeFingerprint! } })).toThrow("current scope");
  const fresh = planRetry({ ...changed, result: {}, nextWave: true });
  expect(fresh.priorAttempts).toBe(0);
  expect(fresh.decision).toBe("wave");
});

test("unknown reviewer status never accepts scope", () => {
  const built = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 20)));
  const plan = planRetry({ manifest: built.manifest, reviewer: "review-logic", result: { status: "FAILED", slices: built.manifest.slices.map(s => s.id) }, state: { schemaVersion: 1, reviewers: {} }, readSliceText: () => built.slices[0]!.text });
  expect(plan.decision).toBe("not-run");
});
