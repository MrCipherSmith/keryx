// Flow 400 (AC10, AC13): the report by arm and by channel. Pure arithmetic over records
// written through the real `openDecision` / `answerDecision`, with the arm forced by the
// test seam, so nothing here is random and nothing calls a model.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decisionsCommand } from "../commands/decisions";
import { assignArm, defaultSettings, reasonSubsample, type Arm } from "./arms";
import { answerDecision, openDecision, recordReason, REASON_SUBSAMPLE_ENV } from "./journal";
import { AC11_BLIND, AC11_DECISIONS, buildReport, renderReport } from "./report";
import { loadReport } from "./service";
import { readRecords } from "./store";
import type { OpenRecord } from "./types";

let root: string;
let savedReasonEnv: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-report-arms-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  // the reason subsample is switched off for the suite; the AC18 tests pin it per decision instead
  savedReasonEnv = process.env[REASON_SUBSAMPLE_ENV];
  delete process.env[REASON_SUBSAMPLE_ENV];
});

afterEach(async () => {
  if (savedReasonEnv === undefined) delete process.env[REASON_SUBSAMPLE_ENV];
  else process.env[REASON_SUBSAMPLE_ENV] = savedReasonEnv;
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "o0", label: "First" },
  { id: "o1", label: "Second" },
];

let counter = 0;

/** One decision in a chosen arm and channel, answered with the recommended option (`follow`) or the other one. */
async function decide(arm: Arm, input: { channel?: string; follow: boolean; irreversible?: boolean }): Promise<string> {
  counter += 1;
  const id = `d-${counter}`;
  const at = new Date(Date.UTC(2026, 9, 3, 10, counter, 0));
  await openDecision({
    cwd: root,
    id,
    question: `Question ${counter}?`,
    options: OPTIONS,
    recommendation: { optionId: "o0", reason: "simplest" },
    arm,
    salt: "test-salt",
    seq: counter,
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.irreversible === true ? { irreversible: true } : {}),
    now: () => at,
  });
  await answerDecision({ cwd: root, id, choice: input.follow ? "o0" : "o1", now: () => new Date(at.getTime() + 4000) });
  return id;
}

async function report() {
  return buildReport(await readRecords(root));
}

describe("AC10: --channel is recorded and the report cuts by it, merging A and B on telegram", () => {
  test("the open command records the channel, lower-cased, and a question without one is tui", async () => {
    const cwd = process.cwd();
    process.chdir(root);
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await decisionsCommand(["open", "--question", "Which way?", "--option", "o0=First", "--option", "o1=Second", "--recommend", "o0", "--reason", "simplest", "--stage", "design", "--flow", "400", "--channel", "Telegram", "--json"]);
      await decisionsCommand(["open", "--question", "And then?", "--option", "o0=First", "--option", "o1=Second", "--stage", "design", "--flow", "400", "--json"]);
    } finally {
      log.mockRestore();
      process.chdir(cwd);
    }
    const opens = (await readRecords(root)).filter((r): r is OpenRecord => r.kind === "open");
    expect(opens.map((o) => o.channel)).toEqual(["telegram", "tui"]);
  });

  test("on telegram arms A and B are one row; on tui they are separate", async () => {
    await decide("A", { channel: "telegram", follow: true });
    await decide("B", { channel: "telegram", follow: false });
    await decide("C", { channel: "telegram", follow: true });
    await decide("D", { channel: "telegram", follow: true });
    await decide("A", { follow: true });
    await decide("B", { follow: false });

    const result = await report();
    const telegram = result.byChannel.find((c) => c.channel === "telegram");
    const tui = result.byChannel.find((c) => c.channel === "tui");
    expect(telegram?.rows.map((r) => r.key)).toEqual(["A+B", "C", "D"]);
    expect(telegram?.rows[0]?.row).toMatchObject({ decisions: 2, answered: 2, tally: { answered: 2, matched: 1 } });
    expect(tui?.rows.map((r) => r.key)).toEqual(["A-free", "B"]);
    expect(tui?.rows[0]?.row.tally).toEqual({ answered: 1, matched: 1 });
    expect(tui?.rows[1]?.row.tally).toEqual({ answered: 1, matched: 0 });

    const text = renderReport(result);
    expect(text).toContain("Channel telegram:");
    expect(text).toContain("A+B (mark, no preselection)");
    expect(text).toContain("arms A and B are one condition here");
    expect(text).toContain("Channel tui:");
  });

  test("the headline arm table covers the tui channel only; telegram is in its own cut", async () => {
    await decide("B", { channel: "telegram", follow: true });
    await decide("B", { follow: false });
    const result = await report();
    expect(result.headlineChannel).toBe("tui");
    expect(result.byArm.B).toMatchObject({ decisions: 1, answered: 1, tally: { answered: 1, matched: 0 } });
    expect(result.byChannel.find((c) => c.channel === "telegram")?.rows[0]?.row).toMatchObject({ decisions: 1, tally: { answered: 1, matched: 1 } });
    const text = renderReport(result);
    expect(text).toContain("By arm, channel tui only");
    expect(text).toContain("Channel telegram:");
  });

  test("a telegram A with a very different time to answer does not move the headline A median or share", async () => {
    const answerAt = async (arm: Arm, channel: string | undefined, ms: number, follow: boolean): Promise<void> => {
      counter += 1;
      const id = `m-${counter}`;
      const at = new Date(Date.UTC(2026, 9, 3, 12, counter, 0));
      await openDecision({ cwd: root, id, question: `Median ${counter}?`, options: OPTIONS, recommendation: { optionId: "o0", reason: "simplest" }, arm, salt: "test-salt", seq: counter, ...(channel === undefined ? {} : { channel }), now: () => at });
      await answerDecision({ cwd: root, id, choice: follow ? "o0" : "o1", now: () => new Date(at.getTime() + ms) });
    };
    await answerAt("A", undefined, 4000, true);
    await answerAt("A", undefined, 6000, false);
    const before = await report();
    expect(before.armA.free).toMatchObject({ decisions: 2, medianMs: 5000, tally: { answered: 2, matched: 1 } });

    await answerAt("A", "telegram", 600_000, true);
    const after = await report();
    expect(after.armA.free).toEqual(before.armA.free);
    expect(after.byArm.A).toEqual(before.byArm.A);
    expect(after.byChannel.find((c) => c.channel === "telegram")?.rows[0]).toMatchObject({ key: "A+B", row: { decisions: 1, medianMs: 600_000 } });
    expect(renderReport(after)).toMatch(/A free\s+2 decisions, 2 answered, match 50% \(1\/2\), median 5\.0s/);
  });

  test("a journal with only telegram records still prints its channel cut under an empty headline", async () => {
    await decide("C", { channel: "telegram", follow: true });
    const text = renderReport(await report());
    expect(text).toContain("none yet on tui");
    expect(text).toContain("Channel telegram:");
  });

  test("the report loaded from disk carries the same channel rows", async () => {
    await decide("A", { channel: "telegram", follow: true });
    await decide("C", { channel: "telegram", follow: true });
    const loaded = await loadReport(root);
    expect(loaded.byChannel.map((c) => [c.channel, c.rows.map((r) => r.key)])).toEqual([["telegram", ["A+B", "C"]]]);
  });
});

describe("AC13: arm A free and arm A forced are reported apart", () => {
  test("a drawn A and a forced A are separate rows and sum to arm A", async () => {
    await decide("A", { follow: true });
    await decide("A", { follow: false });
    // an irreversible question is always arm A with forced: true, whatever arm was asked for
    const forcedId = await decide("D", { follow: false, irreversible: true });

    const records = await readRecords(root);
    const forced = records.find((r): r is OpenRecord => r.kind === "open" && r.id === forcedId);
    expect(forced).toMatchObject({ arm: "A", forced: true });

    const result = await report();
    expect(result.armA.free).toMatchObject({ decisions: 2, answered: 2, tally: { answered: 2, matched: 1 } });
    expect(result.armA.forced).toMatchObject({ decisions: 1, answered: 1, tally: { answered: 1, matched: 0 } });
    expect(result.byArm.A.decisions).toBe(3);
    expect(result.byArm.D.decisions).toBe(0);

    const text = renderReport(result);
    expect(text).toMatch(/A free\s+2 decisions, 2 answered, match 50% \(1\/2\)/);
    expect(text).toMatch(/A forced\s+1 decision, 1 answered, match 0% \(0\/1\)/);
  });

  test("a question without a recommendation is in no arm cell: it would only skew the A count and median time", async () => {
    const at = new Date(Date.UTC(2026, 9, 3, 11, 0, 0));
    const answerAfter = async (id: string, ms: number): Promise<void> => {
      await answerDecision({ cwd: root, id, choice: "o0", now: () => new Date(at.getTime() + ms) });
    };
    for (const [i, id] of ["norec-1", "norec-2"].entries()) {
      await openDecision({ cwd: root, id, question: `No recommendation ${i}?`, options: OPTIONS, arm: "A", salt: "test-salt", seq: 100 + i, now: () => at });
      await answerAfter(id, 500);
    }
    await openDecision({ cwd: root, id: "rec-1", question: "With one?", options: OPTIONS, recommendation: { optionId: "o0", reason: "simplest" }, arm: "A", salt: "test-salt", seq: 102, now: () => at });
    await answerAfter("rec-1", 9000);

    const result = await report();
    expect(result.armA.free).toMatchObject({ decisions: 1, answered: 1, medianMs: 9000 });
    expect(result.byArm.A).toMatchObject({ decisions: 1, answered: 1, medianMs: 9000 });
    expect(result.byChannel.find((c) => c.channel === "tui")?.rows.find((r) => r.key === "A-free")?.row).toMatchObject({ decisions: 1, medianMs: 9000 });
    // still counted as what they are
    expect(result.total).toBe(3);
    expect(result.withoutRecommendation).toBe(2);
  });

  test("on a channel the forced A stays out of the merged A+B row", async () => {
    await decide("A", { channel: "telegram", follow: true });
    await decide("B", { channel: "telegram", follow: true });
    await decide("A", { channel: "telegram", follow: false, irreversible: true });
    const telegram = (await report()).byChannel.find((c) => c.channel === "telegram");
    expect(telegram?.rows.map((r) => [r.key, r.row.decisions])).toEqual([
      ["A+B", 2],
      ["A-forced", 1],
    ]);
  });
});

/** The first position where the salt puts a decision in (or out of) the reason subsample. */
function seqFor(inSample: boolean, from: number): number {
  for (let seq = from; seq < from + 1000; seq += 1) {
    if (reasonSubsample(assignArm("test-salt", seq).seed, seq) === inSample) return seq;
  }
  throw new Error("no such position");
}

let reasonCounter = 1000;

/** One tui decision with a pinned reason draw: answered after `ms`, with the recommended option or not, and a reason or not. */
async function decideReason(input: { requested: boolean; follow: boolean; ms?: number; reason?: string; arm?: Arm; channel?: string }): Promise<string> {
  reasonCounter += 1;
  const seq = seqFor(input.requested, reasonCounter * 10);
  const id = `r-${reasonCounter}`;
  const at = new Date(Date.UTC(2026, 9, 3, 14, reasonCounter % 60, 0));
  await openDecision({
    cwd: root,
    id,
    question: `Reasoned ${reasonCounter}?`,
    options: OPTIONS,
    recommendation: { optionId: "o0", reason: "simplest" },
    arm: input.arm ?? "B",
    salt: "test-salt",
    seq,
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    now: () => at,
  });
  await answerDecision({ cwd: root, id, choice: input.follow ? "o0" : "o1", now: () => new Date(at.getTime() + (input.ms ?? 4000)) });
  if (input.reason !== undefined) await recordReason(root, id, input.reason);
  return id;
}

describe("AC18: the share of named reasons for agreement and deviation, and the time to answer by reasonRequested", () => {
  test("agreement and deviation are two shares; an agreement outside the subsample was never asked and is not counted", async () => {
    await decideReason({ requested: true, follow: true, reason: "obvious" });
    await decideReason({ requested: true, follow: true });
    await decideReason({ requested: false, follow: true });
    await decideReason({ requested: false, follow: false, reason: "too slow" });
    await decideReason({ requested: false, follow: false });
    await decideReason({ requested: true, follow: false, reason: "risky" });

    const { reasons } = await report();
    expect(reasons.agreement).toEqual({ decisions: 2, named: 1 });
    expect(reasons.deviation).toEqual({ decisions: 3, named: 2 });

    const text = renderReport(await report());
    expect(text).toMatch(/agreement\s+50% \(1\/2\)/);
    expect(text).toMatch(/deviation\s+67% \(2\/3\)/);
  });

  test("the median time to answer is reported apart for reasonRequested decisions", async () => {
    await decideReason({ requested: true, follow: true, ms: 10_000 });
    await decideReason({ requested: true, follow: false, ms: 20_000 });
    await decideReason({ requested: true, follow: true, ms: 60_000 });
    await decideReason({ requested: false, follow: true, ms: 2000 });
    await decideReason({ requested: false, follow: true, ms: 4000 });

    const { reasons } = await report();
    expect(reasons.requested).toEqual({ answered: 3, medianMs: 20_000 });
    expect(reasons.notRequested).toEqual({ answered: 2, medianMs: 3000 });
    expect(renderReport(await report())).toContain("reason requested 20.0s (3 answered), not requested 3.0s (2 answered)");
  });

  test("another channel does not move the headline medians, and a decision without a recommendation is in neither share", async () => {
    await decideReason({ requested: true, follow: true, ms: 5000 });
    const before = (await report()).reasons;
    await decideReason({ requested: true, follow: true, ms: 900_000, channel: "telegram" });
    const after = (await report()).reasons;
    expect(after.requested).toEqual(before.requested);
    // the share spans every channel
    expect(after.agreement.decisions).toBe(before.agreement.decisions + 1);

    const at = new Date(Date.UTC(2026, 9, 3, 15, 0, 0));
    await openDecision({ cwd: root, id: "no-rec", question: "No recommendation?", options: OPTIONS, arm: "A", salt: "test-salt", seq: seqFor(true, 90_000), now: () => at });
    await answerDecision({ cwd: root, id: "no-rec", choice: "o1", now: () => new Date(at.getTime() + 1000) });
    expect((await report()).reasons.deviation).toEqual(after.deviation);
  });

  test("an own answer is a deviation, never an agreement", async () => {
    const seq = seqFor(true, 70_000);
    const at = new Date(Date.UTC(2026, 9, 3, 16, 0, 0));
    await openDecision({ cwd: root, id: "own", question: "Own?", options: OPTIONS, recommendation: { optionId: "o0", reason: "simplest" }, arm: "B", salt: "test-salt", seq, now: () => at });
    await answerDecision({ cwd: root, id: "own", choice: "something else entirely", other: true, now: () => new Date(at.getTime() + 1000) });
    const { reasons } = await report();
    expect(reasons.agreement.decisions).toBe(0);
    expect(reasons.deviation.decisions).toBe(1);
  });

  test("--json carries the shares and the two medians", async () => {
    await decideReason({ requested: true, follow: true, reason: "obvious", ms: 8000 });
    await decideReason({ requested: false, follow: false, reason: "no", ms: 2000 });
    const cwd = process.cwd();
    process.chdir(root);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    try {
      await decisionsCommand(["report", "--json"]);
    } finally {
      log.mockRestore();
      process.chdir(cwd);
    }
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.reasons).toMatchObject({
      agreement: { decisions: 1, named: 1 },
      deviation: { decisions: 1, named: 1 },
      requested: { answered: 1, medianMs: 8000 },
      notRequested: { answered: 1, medianMs: 2000 },
    });
  });
});

describe("AC20: eligible, and the ineligible questions on a line of their own", () => {
  test("eligible is false exactly when forced is true, on the record the journal writes", async () => {
    await decide("A", { follow: true });
    await decide("D", { follow: false, irreversible: true });
    const opens = (await readRecords(root)).filter((r): r is OpenRecord => r.kind === "open");
    expect(opens.map((o) => [o.forced === true, o.eligible])).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  test("the report counts the ineligible questions apart from the arm comparison", async () => {
    await decide("B", { follow: true });
    await decide("A", { follow: false, irreversible: true });
    await decide("A", { follow: true, irreversible: true });
    const result = await report();
    expect(result.ineligible).toEqual({ decisions: 2, answered: 2 });
    expect(renderReport(result)).toContain("Not in the arm comparison (ineligible: irreversible, an action or a blind.ts match, always arm A): 2 decisions, 2 answered.");
    // and the eligible ones are counted in the per-arm progress, the ineligible ones are not
    expect(result.progress.perArm.counts).toEqual({ A: 0, B: 1, C: 0, D: 0 });
  });

  test("a record written before the field existed still reads: eligible follows forced", async () => {
    const at = new Date(Date.UTC(2026, 9, 3, 17, 0, 0));
    for (const [id, forced] of [["old-free", false], ["old-forced", true]] as const) {
      await openDecision({ cwd: root, id, question: `Old ${id}?`, options: OPTIONS, recommendation: { optionId: "o0", reason: "simplest" }, arm: "A", salt: "test-salt", seq: forced ? 501 : 500, ...(forced ? { irreversible: true } : {}), now: () => at });
      await answerDecision({ cwd: root, id, choice: "o0", now: () => new Date(at.getTime() + 1000) });
    }
    const stripped = (await readRecords(root)).map((record) => {
      if (record.kind !== "open") return record;
      const { eligible: _eligible, reasonRequested: _requested, ...old } = record;
      return old;
    });
    expect(stripped.some((r) => r.kind === "open" && "eligible" in r)).toBe(false);
    const result = buildReport(stripped);
    expect(result.ineligible).toEqual({ decisions: 1, answered: 1 });
    expect(result.armA.free.decisions).toBe(1);
    expect(result.armA.forced.decisions).toBe(1);
    expect(result.reasons.agreement.decisions).toBe(0);
  });
});

describe("AC21: progress toward flow 392 AC11 and toward the per-arm threshold", () => {
  test("AC11 counts the answered decisions and the blind ones against 20 and 5", async () => {
    const empty = (await report()).progress.ac11;
    expect(empty).toEqual({ decisions: 0, decisionsTarget: AC11_DECISIONS, blind: 0, blindTarget: AC11_BLIND, met: false });
    expect(AC11_DECISIONS).toBe(20);
    expect(AC11_BLIND).toBe(5);

    for (let i = 0; i < 4; i += 1) await decide("C", { follow: true });
    for (let i = 0; i < 3; i += 1) await decide("D", { follow: false });
    const some = await report();
    expect(some.progress.ac11).toMatchObject({ decisions: 7, blind: some.byMode.blind.answered, met: false });
    expect(renderReport(some)).toContain(`flow 392 AC11: 7/20 decisions, ${some.byMode.blind.answered}/5 blind (not reached yet)`);
  });

  test("AC11 is reached at 20 answered decisions with 5 blind, and not before", async () => {
    // D is the blind arm: its decisions are opened in blind mode
    for (let i = 0; i < 5; i += 1) await decide("D", { follow: i % 2 === 0 });
    const blind = (await report()).progress.ac11.blind;
    expect(blind).toBe(5);
    for (let i = 0; i < 14; i += 1) await decide("A", { follow: true });
    expect((await report()).progress.ac11).toMatchObject({ decisions: 19, met: false });
    await decide("B", { follow: true });
    expect((await report()).progress.ac11).toMatchObject({ decisions: 20, blind: 5, met: true });
  });

  test("the per-arm threshold defaults to 150 and counts reversible, answered questions with a recommendation, over every channel", async () => {
    await decide("A", { follow: true });
    await decide("A", { follow: true, channel: "telegram" });
    await decide("B", { follow: false });
    await decide("C", { follow: true });
    await decide("A", { follow: true, irreversible: true });
    const result = await report();
    expect(result.progress.perArm).toEqual({ threshold: 150, counts: { A: 2, B: 1, C: 1, D: 0 }, met: false });
    expect(renderReport(result)).toContain("per arm, threshold 150 reversible questions with a recommendation, answered: A 2, B 1, C 1, D 0 (not reached yet)");
  });

  test("a configured threshold is used, and met needs every arm at or above it", async () => {
    const settings = { ...defaultSettings(), perArmThreshold: 2 };
    for (const arm of ["A", "B", "C"] as const) {
      await decide(arm, { follow: true });
      await decide(arm, { follow: false });
    }
    const records = await readRecords(root);
    expect(buildReport(records, 0, { settings }).progress.perArm).toMatchObject({ threshold: 2, counts: { A: 2, B: 2, C: 2, D: 0 }, met: false });
    await decide("D", { follow: true });
    await decide("D", { follow: true });
    const met = buildReport(await readRecords(root), 0, { settings }).progress.perArm;
    expect(met).toMatchObject({ threshold: 2, counts: { A: 2, B: 2, C: 2, D: 2 }, met: true });
    expect(renderReport(buildReport(await readRecords(root), 0, { settings }))).toContain("threshold 2 reversible questions");
  });
});

// Review of the AC17-AC21 delta: F-001, F-002, F-004, F-005.

/** One decision on a chosen surface (reasonPrompt), with a pinned reason draw, answered after `ms`. */
async function decideOn(input: { prompt: boolean; requested: boolean; follow: boolean; ms: number; irreversible?: boolean; reason?: string }): Promise<string> {
  reasonCounter += 1;
  const seq = seqFor(input.requested, reasonCounter * 10);
  const id = `s-${reasonCounter}`;
  const at = new Date(Date.UTC(2026, 9, 3, 18, reasonCounter % 60, 0));
  await openDecision({
    cwd: root,
    id,
    question: `Surface ${reasonCounter}?`,
    options: OPTIONS,
    recommendation: { optionId: "o0", reason: "simplest" },
    arm: "B",
    salt: "test-salt",
    seq,
    reasonPrompt: input.prompt,
    ...(input.irreversible === true ? { irreversible: true } : {}),
    now: () => at,
  });
  await answerDecision({ cwd: root, id, choice: input.follow ? "o0" : "o1", now: () => new Date(at.getTime() + input.ms) });
  if (input.reason !== undefined) await recordReason(root, id, input.reason);
  return id;
}

describe("F-001: a deviation counts in the reasons share only where the surface could ask", () => {
  test("the open record keeps whether the surface prompts, and a deviation on a picker is counted apart, not in the share", async () => {
    await decideOn({ prompt: true, requested: false, follow: false, ms: 1000, reason: "slow" });
    await decideOn({ prompt: true, requested: false, follow: false, ms: 1000 });
    await decideOn({ prompt: false, requested: false, follow: false, ms: 1000 });
    await decideOn({ prompt: false, requested: false, follow: false, ms: 1000 });
    await decideOn({ prompt: false, requested: false, follow: false, ms: 1000 });

    const opens = (await readRecords(root)).filter((r): r is OpenRecord => r.kind === "open");
    expect(opens.map((o) => o.reasonPrompt)).toEqual([true, true, false, false, false]);
    const { reasons } = await report();
    // before the fix the three picker deviations sat in the denominator: 1/5
    expect(reasons.deviation).toEqual({ decisions: 2, named: 1 });
    expect(reasons.deviationNotAsked).toBe(3);
    const text = renderReport(await report());
    expect(text).toMatch(/deviation\s+50% \(1\/2\)\s+\(asked on every surface that can prompt\)/);
    expect(text).toContain("not asked  3 deviations on a surface that never prompts");
    expect(text).not.toContain("always asked");
  });

  test("a record from before the field counts as promptable", async () => {
    await decideOn({ prompt: true, requested: false, follow: false, ms: 1000, reason: "old" });
    const records = await readRecords(root);
    const old = records.map((r) => {
      if (r.kind !== "open") return r;
      const { reasonPrompt: _prompt, ...rest } = r;
      return rest;
    });
    const built = buildReport(old);
    expect(built.reasons.deviation).toEqual({ decisions: 1, named: 1 });
    expect(built.reasons.deviationNotAsked).toBe(0);
  });
});

describe("F-002: the time to answer compares the same population on both sides", () => {
  test("forced irreversible questions and picker menus are in neither median", async () => {
    await decideOn({ prompt: true, requested: true, follow: true, ms: 10_000 });
    await decideOn({ prompt: true, requested: false, follow: true, ms: 2000 });
    await decideOn({ prompt: true, requested: false, follow: true, ms: 4000 });
    const before = (await report()).reasons;
    expect(before.requested).toEqual({ answered: 1, medianMs: 10_000 });
    expect(before.notRequested).toEqual({ answered: 2, medianMs: 3000 });

    // a forced irreversible question and two picker answers, all slow: they used to pad the "not requested" side
    await decideOn({ prompt: true, requested: false, follow: true, ms: 500_000, irreversible: true });
    await decideOn({ prompt: false, requested: false, follow: true, ms: 600_000 });
    await decideOn({ prompt: false, requested: false, follow: true, ms: 700_000 });
    const after = (await report()).reasons;
    expect(after.requested).toEqual(before.requested);
    expect(after.notRequested).toEqual(before.notRequested);
    expect(renderReport(await report())).toContain("eligible questions on a surface that can prompt: reason requested 10.0s (1 answered), not requested 3.0s (2 answered)");
  });
});

describe("F-004: `open` does not reveal the reason subsample before the question is shown", () => {
  async function run(args: string[]): Promise<string> {
    const cwd = process.cwd();
    process.chdir(root);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      await decisionsCommand(args);
    } finally {
      log.mockRestore();
      process.chdir(cwd);
    }
    return lines.join("\n");
  }

  const OPEN = ["open", "--question", "Which way?", "--option", "o0=First", "--option", "o1=Second", "--recommend", "o0", "--reason", "simplest", "--stage", "design", "--flow", "400"];

  test("neither the JSON nor the text of `open` carries reasonRequested or a hint about the subsample", async () => {
    const json = await run([...OPEN, "--json"]);
    expect(Object.keys(JSON.parse(json))).not.toContain("reasonRequested");
    expect(json).not.toContain("reasonRequested");
    const text = await run([...OPEN.map((a) => (a === "Which way?" ? "Another way?" : a))]);
    expect(text).not.toContain("subsample");
    expect(text).not.toContain("optional reason");
    // it is still decided and written on the record, before the question is shown
    const opens = (await readRecords(root)).filter((r): r is OpenRecord => r.kind === "open");
    expect(opens.every((o) => typeof o.reasonRequested === "boolean")).toBe(true);
  });

  test("`answer` is where the caller learns it: a matched answer asks for a reason exactly when the record says so", async () => {
    for (const [i, requested] of [true, false].entries()) {
      const id = `cli-${i}`;
      await openDecision({ cwd: root, id, question: `CLI ${i}?`, options: OPTIONS, recommendation: { optionId: "o0", reason: "r" }, arm: "B", salt: "test-salt", seq: seqFor(requested, 50_000 + i * 100) });
      const answered = JSON.parse(await run(["answer", id, "--choice", "o0", "--json"]));
      expect(answered).toMatchObject({ matched: true, askReason: requested });
    }
    const text = await run(["answer", "cli-0", "--choice", "o1"]);
    expect(text).not.toContain("reason subsample");
    const inSample = `cli-text`;
    await openDecision({ cwd: root, id: inSample, question: "CLI text?", options: OPTIONS, recommendation: { optionId: "o0", reason: "r" }, arm: "B", salt: "test-salt", seq: seqFor(true, 60_000) });
    expect(await run(["answer", inSample, "--choice", "o0"])).toContain("This decision is in the reason subsample");
  });
});

describe("F-005: the settings block names the environment switch", () => {
  test("with KERYX_DECISIONS_REASON_SUBSAMPLE=off the report says so; unset, the subsample is on", async () => {
    await decideReason({ requested: true, follow: true });
    const on = await report();
    expect(on.settings.reasonSubsampleOff).toBe(false);
    expect(renderReport(on)).toContain("Reason subsample: on (one third of the eligible questions).");
    process.env[REASON_SUBSAMPLE_ENV] = "off";
    const off = await report();
    expect(off.settings.reasonSubsampleOff).toBe(true);
    expect(renderReport(off)).toContain("Reason subsample: off (KERYX_DECISIONS_REASON_SUBSAMPLE)");
  });
});
