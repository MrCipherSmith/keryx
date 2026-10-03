// Flow 400 (AC10, AC13): the report by arm and by channel. Pure arithmetic over records
// written through the real `openDecision` / `answerDecision`, with the arm forced by the
// test seam, so nothing here is random and nothing calls a model.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decisionsCommand } from "../commands/decisions";
import type { Arm } from "./arms";
import { answerDecision, openDecision } from "./journal";
import { buildReport, renderReport } from "./report";
import { loadReport } from "./service";
import { readRecords } from "./store";
import type { OpenRecord } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-report-arms-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
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

  test("the channel cut does not change the cut by arm: B on telegram is still counted in arm B", async () => {
    await decide("B", { channel: "telegram", follow: true });
    await decide("B", { follow: false });
    const result = await report();
    expect(result.byArm.B).toMatchObject({ decisions: 2, answered: 2, tally: { answered: 2, matched: 1 } });
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
