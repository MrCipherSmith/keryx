// Flow 400 (AC6): the open record gains arm, seed, preselected, order, channel, forced and
// recommendation.reason, and a journal written before that still reads.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { armOfMode } from "./arms";
import { DEFAULT_CHANNEL, answerDecision, openDecision } from "./journal";
import { buildReport, loadReport, renderReport } from "./service";
import { journalFile, readRecords } from "./store";
import type { OpenRecord } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-journal-"));
  await mkdir(path.join(root, ".metaproject", "data", "decisions"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one" },
  { id: "b", label: "Option B", description: "the quick one" },
  { id: "c", label: "Option C", description: "the odd one" },
];

describe("AC6: the new open record", () => {
  test("carries arm, seed, preselected, order, channel, forced and the recommendation with its reason", async () => {
    await openDecision({
      cwd: root,
      id: "d-new",
      question: "Which approach?",
      options: OPTIONS,
      recommendation: { optionId: "b", reason: "it is reversible" },
      arm: "B",
      salt: "test-salt",
      seq: 3,
    });
    const [record] = await readRecords(root);
    expect(record).toMatchObject({
      kind: "open",
      id: "d-new",
      arm: "B",
      mode: "partial",
      preselected: false,
      forced: false,
      channel: DEFAULT_CHANNEL,
      order: ["a", "b", "c"],
      recommendation: { optionId: "b", reason: "it is reversible" },
    });
    expect(DEFAULT_CHANNEL).toBe("tui");
    expect(typeof (record as OpenRecord).seed).toBe("number");
  });

  test("the channel can be set, and the shuffled arms store the shuffled order", async () => {
    await openDecision({
      cwd: root,
      id: "d-tg",
      question: "Which approach?",
      options: OPTIONS,
      recommendation: { optionId: "a", reason: "r" },
      arm: "C",
      channel: "telegram",
      random: () => 0,
    });
    const [record] = (await readRecords(root)) as OpenRecord[];
    expect(record).toMatchObject({ arm: "C", channel: "telegram" });
    expect([...(record?.order ?? [])].sort()).toEqual(["a", "b", "c"]);
  });

  test("the result of openDecision mirrors the record", async () => {
    const opened = await openDecision({ cwd: root, question: "Which approach?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, arm: "A", salt: "s", seq: 1 });
    expect(opened).toMatchObject({ arm: "A", mode: "ordinary", preselected: true, forced: false, channel: "tui" });
  });
});

describe("AC6: an old record still reads", () => {
  // A record as flow 392 wrote it: a mode, and none of the flow 400 fields.
  const OLD_OPEN = {
    kind: "open",
    id: "d-old",
    at: "2026-10-01T10:00:00.000Z",
    flow: null,
    stage: "design",
    question: "Which approach?",
    options: OPTIONS,
    recommendation: { optionId: "a", reason: "least risk" },
    mode: "blind",
    order: ["c", "a", "b"],
    showMark: false,
    irreversible: false,
    seq: 1,
  };
  const OLD_ANSWER = { kind: "answer", id: "d-old", at: "2026-10-01T10:00:05.000Z", choice: "b", matched: false, deviation: true, timeToAnswerMs: 5000, seq: 2 };

  async function writeOld(): Promise<void> {
    await writeFile(journalFile(root), `${JSON.stringify(OLD_OPEN)}\n${JSON.stringify(OLD_ANSWER)}\n`, "utf8");
  }

  test("readRecords returns it, with the new fields simply absent", async () => {
    await writeOld();
    const records = await readRecords(root);
    expect(records.map((r) => r.kind)).toEqual(["open", "answer"]);
    const open = records[0] as OpenRecord;
    expect(open.arm).toBeUndefined();
    expect(open.seed).toBeUndefined();
    expect(open.channel).toBeUndefined();
    expect(open.forced).toBeUndefined();
    expect(open.mode).toBe("blind");
    expect(armOfMode(open.mode)).toBe("D");
  });

  test("the report counts it by its mode", async () => {
    await writeOld();
    const report = await loadReport(root);
    expect(report.total).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.byMode.blind).toEqual({ answered: 1, matched: 0 });
    expect(renderReport(report)).toContain("blind");
  });

  test("old and new records share one journal and one report", async () => {
    await writeOld();
    await openDecision({ cwd: root, id: "d-new", question: "Second?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, arm: "B" });
    await answerDecision({ cwd: root, id: "d-new", choice: "a" });
    const records = await readRecords(root);
    expect(records.filter((r) => r.kind === "open")).toHaveLength(2);
    const report = buildReport(records);
    expect(report.total).toBe(2);
    expect(report.answered).toBe(2);
    expect(report.byMode.blind).toEqual({ answered: 1, matched: 0 });
    expect(report.byMode.partial).toEqual({ answered: 1, matched: 1 });
  });

  test("an old record can still be answered", async () => {
    await writeOld();
    const answered = await answerDecision({ cwd: root, id: "d-old", choice: "a" });
    expect(answered.choice).toBe("a");
  });
});
