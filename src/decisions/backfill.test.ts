// Backfilled decisions: the import, their separation in the report and the one-line
// summary, and the lookups that must never reach them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GROUP_SUBCOMMANDS } from "../lib/group-subcommands";
import { importBackfill, parseBackfill, renderImportResult } from "./import";
import { buildReport, renderReport, renderReportLine } from "./report";
import { answerDecision, changeAnswer, giveReason, latestAnsweredDecision, loadReport, openDecision, reportLine } from "./service";
import { readRecords } from "./store";
import type { OpenRecord } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-decisions-backfill-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "o0", label: "First" },
  { id: "o1", label: "Second" },
];

function entry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "bf-p12-q0",
    at: "2026-08-14T09:30:00.000Z",
    flow: "392",
    stage: "design",
    question: "Which way?",
    options: OPTIONS,
    recommendation: { optionId: "o0", reason: "simpler" },
    source: "poll 12",
    answer: { choice: "o0" },
    ...overrides,
  });
}

const file = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("import", () => {
  test("a valid decision is written as an open record, then an answer", async () => {
    const result = await importBackfill(root, file(entry()));
    expect(result).toMatchObject({ imported: 1, skipped: 0, withRecommendation: 1, answered: 1, deviations: 0, dryRun: false });
    const records = await readRecords(root);
    expect(records.map((r) => r.kind)).toEqual(["open", "answer"]);
    const open = records[0] as OpenRecord;
    expect(open).toMatchObject({
      id: "bf-p12-q0",
      at: "2026-08-14T09:30:00.000Z",
      flow: "392",
      stage: "design",
      mode: "ordinary",
      order: ["o0", "o1"],
      showMark: true,
      irreversible: false,
      backfilled: true,
      source: "poll 12",
    });
    expect(records[1]).toMatchObject({ kind: "answer", id: "bf-p12-q0", at: "2026-08-14T09:30:00.000Z", seq: 1, choice: "o0", changed: false, timeToAnswerMs: 0 });
  });

  test("without a recommendation nothing is marked; without an answer no answer record is written", async () => {
    await importBackfill(root, file(entry({ recommendation: null, answer: null })));
    const records = await readRecords(root);
    expect(records.map((r) => r.kind)).toEqual(["open"]);
    expect(records[0]).toMatchObject({ recommendation: null, showMark: false, mode: "ordinary" });
  });

  test("a reason record follows the answer, stamped with the time the question was asked", async () => {
    const result = await importBackfill(root, file(entry({ answer: { choice: "o1" }, reason: "the other one is closer to what we do\nanyway" })));
    expect(result.deviations).toBe(1);
    const records = await readRecords(root);
    expect(records.map((r) => r.kind)).toEqual(["open", "answer", "reason"]);
    expect(records[2]).toMatchObject({ kind: "reason", id: "bf-p12-q0", at: "2026-08-14T09:30:00.000Z", reason: "the other one is closer to what we do anyway" });
  });

  test("an answer that is the human's own words is kept when it says so, and is refused when it does not", async () => {
    const result = await importBackfill(root, file(entry({ answer: { choice: "neither, do X", other: true } })));
    expect(result).toMatchObject({ imported: 1, answered: 1, deviations: 1 });
    expect(await readRecords(root)).toContainEqual(expect.objectContaining({ kind: "answer", choice: "neither, do X", other: true }));
    await expect(importBackfill(root, file(entry({ id: "bf-2", answer: { choice: "neither, do X" } })))).rejects.toThrow(/is not one of the options/);
  });

  test("the second import of the same file writes nothing and says which ids it skipped", async () => {
    const text = file(entry(), entry({ id: "bf-p12-q1", answer: { choice: "o1" } }));
    await importBackfill(root, text);
    const before = await readRecords(root);
    const again = await importBackfill(root, text);
    expect(again).toMatchObject({ imported: 0, skipped: 2, skippedIds: ["bf-p12-q0", "bf-p12-q1"] });
    expect(await readRecords(root)).toEqual(before);
    expect(renderImportResult(again)).toContain("Imported: 0, skipped: 2");
    expect(renderImportResult(again)).toContain("bf-p12-q0");
  });

  test("an id repeated inside one file is imported once", async () => {
    const result = await importBackfill(root, file(entry(), entry()));
    expect(result).toMatchObject({ imported: 1, skipped: 1 });
    expect((await readRecords(root)).filter((r) => r.kind === "open")).toHaveLength(1);
  });

  test("an id already used by a live decision is skipped, never overwritten", async () => {
    await openDecision({ cwd: root, id: "bf-p12-q0", question: "live", options: OPTIONS });
    const result = await importBackfill(root, file(entry()));
    expect(result.skipped).toBe(1);
    expect(((await readRecords(root))[0] as OpenRecord).backfilled).toBeUndefined();
  });

  test.each([
    ["a duplicate option id", { options: [{ id: "o0", label: "A" }, { id: "o0", label: "B" }] }, /duplicate option id: o0/],
    ["a recommendation that is not an option", { recommendation: { optionId: "zz", reason: "" } }, /recommended option "zz"/],
    ["an answer that is not an option", { answer: { choice: "zz" } }, /answer "zz" is not one of the options/],
    ["a single option", { options: [{ id: "o0", label: "A" }] }, /at least two options/],
    ["a date that is not a date", { at: "yesterday" }, /"at" must be an ISO date/],
    ["no question", { question: "  " }, /needs a question/],
  ])("%s writes nothing, and the message names the line", async (_name, overrides, message) => {
    const text = file(entry({ id: "ok-1" }), entry(overrides as Record<string, unknown>));
    await expect(importBackfill(root, text)).rejects.toThrow(message);
    await expect(importBackfill(root, text)).rejects.toThrow(/nothing was imported; 1 line could not be read:\nline 2:/);
    expect(await readRecords(root)).toEqual([]);
  });

  test("a line that is not JSON is named with its line number", () => {
    const parsed = parseBackfill(`${entry()}\n{broken\n\n${entry({ id: "x" })}`);
    expect(parsed.entries.map((e) => e.id)).toEqual(["bf-p12-q0", "x"]);
    expect(parsed.errors).toEqual([{ line: 2, message: "not valid JSON" }]);
  });

  test("--dry-run counts and writes nothing", async () => {
    const result = await importBackfill(root, file(entry(), entry({ id: "b", answer: { choice: "o1" } })), { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, imported: 2, withRecommendation: 2, answered: 2, deviations: 1 });
    expect(await readRecords(root)).toEqual([]);
    expect(renderImportResult(result)).toBe("Dry run, nothing written. Imported: 2, skipped: 0, with recommendation: 2, answered: 2, deviations: 1");
  });

  test("the printed line", async () => {
    const result = await importBackfill(root, file(entry(), entry({ id: "b", recommendation: null }), entry({ id: "c", answer: { choice: "o1" } })));
    expect(renderImportResult(result)).toBe("Imported: 3, skipped: 0, with recommendation: 2, answered: 3, deviations: 1");
  });
});

/** One live decision answered `choice`, shown the given way. */
async function live(id: string, choice: string, mode: "ordinary" | "blind", now: Date, answeredAfterMs = 4000): Promise<void> {
  await openDecision({ cwd: root, id, question: `live ${id}`, options: OPTIONS, recommendation: { optionId: "o0", reason: "" }, random: () => (mode === "blind" ? 0 : 0.99), now: () => now });
  await answerDecision({ cwd: root, id, choice, now: () => new Date(now.getTime() + answeredAfterMs) });
}

describe("report", () => {
  const T = new Date("2026-10-02T10:00:00.000Z");

  async function seed(): Promise<void> {
    await importBackfill(
      root,
      file(
        entry({ id: "h1", answer: { choice: "o0" } }),
        entry({ id: "h2", answer: { choice: "o0" } }),
        entry({ id: "h3", answer: { choice: "o1" }, reason: "we had a constraint", source: "poll 3" }),
        entry({ id: "h4", answer: { choice: "o1" }, source: "poll 4" }),
        entry({ id: "h5", recommendation: null, answer: { choice: "o1" } }),
        entry({ id: "h6", answer: null }),
      ),
    );
    await live("l1", "o0", "ordinary", T, 2000);
    await live("l2", "o1", "ordinary", T, 6000);
    await live("l3", "o0", "blind", T, 10000);
  }

  test("backfilled decisions are counted in a block of their own", async () => {
    await seed();
    const report = await loadReport(root);
    expect(report.backfilled).toMatchObject({ total: 6, answered: 5, withRecommendation: 5, withoutRecommendation: 1, matchTally: { answered: 4, matched: 2 }, matchShare: 0.5 });
    expect(report.backfilled.deviations.map((d) => [d.id, d.source, d.reason])).toEqual([
      ["h3", "poll 3", "we had a constraint"],
      ["h4", "poll 4", undefined],
    ]);
  });

  test("the live numbers count only live decisions", async () => {
    await seed();
    const report = await loadReport(root);
    expect(report).toMatchObject({ total: 3, answered: 3, unanswered: 0, withoutRecommendation: 0 });
    expect(report.byMode.ordinary).toEqual({ answered: 2, matched: 1 });
    expect(report.byMode.blind).toEqual({ answered: 1, matched: 1 });
    expect(report.byStage.map((row) => row.stage)).toEqual(["unspecified"]);
    expect(report.deviations.map((d) => d.id)).toEqual(["l2"]);
    expect(report.irreversible).toBe(0);
  });

  test("the time to answer ignores backfilled records, whose stored time is 0", async () => {
    await seed();
    const report = await loadReport(root);
    // live: 2s, 6s, 10s; with the six backfilled zeros the median would be 0
    expect(report.timing).toEqual({ answered: 3, medianMs: 6000 });
    expect(renderReport(report)).toContain("Median time to answer: 6.0s (3 answered).");
    const onlyBackfilled = buildReport((await readRecords(root)).filter((r) => !r.id.startsWith("l")));
    expect(onlyBackfilled.timing).toEqual({ answered: 0, medianMs: null });
  });

  test("the text has the block, with the totals and every deviation and its reason", async () => {
    await seed();
    const text = renderReport(await loadReport(root));
    expect(text).toContain("Decisions: 3 recorded, 3 answered");
    expect(text).toContain("До (историческое, дозаполнено задним числом):");
    expect(text).toContain("всего: 6, с рекомендацией: 5, совпадение: 50% (2/4)");
    expect(text).toContain("отклонений: 2");
    expect(text).toContain("причина: we had a constraint");
    expect(text).toContain("причина: (не указана)");
    expect(text).toContain("poll 3");
    expect(text.indexOf("Deviations: 1")).toBeLessThan(text.indexOf("До (историческое"));
  });

  test("a journal of only backfilled decisions still reports them, and says there is nothing live", async () => {
    await importBackfill(root, file(entry()));
    const text = renderReport(await loadReport(root));
    expect(text).toContain("No live decisions recorded yet.");
    expect(text).toContain("совпадение: 100% (1/1)");
    expect(renderReport(buildReport([]))).toBe("No decisions recorded yet.");
  });

  test("the JSON report carries the backfilled section", async () => {
    await seed();
    const json = JSON.parse(JSON.stringify(await loadReport(root))) as { backfilled: { total: number; matchShare: number; deviations: unknown[] }; total: number };
    expect(json.total).toBe(3);
    expect(json.backfilled).toMatchObject({ total: 6, matchShare: 0.5 });
    expect(json.backfilled.deviations).toHaveLength(2);
  });

  test("--line is one line in Russian", async () => {
    await seed();
    const line = await reportLine(root);
    expect(line).toBe("Журнал решений: всего 9 (до: 6, после: 3). Совпадение с рекомендацией: видимая 50% (1/2), скрытая 100% (1/1); до: 50% (2/4).");
    expect(line.includes("\n")).toBe(false);
  });

  test("--line says нет данных where a denominator is 0", async () => {
    expect(renderReportLine(buildReport([]))).toBe("Журнал решений: всего 0 (до: 0, после: 0). Совпадение с рекомендацией: видимая нет данных, скрытая нет данных; до: нет данных.");
    await importBackfill(root, file(entry()));
    expect(await reportLine(root)).toBe("Журнал решений: всего 1 (до: 1, после: 0). Совпадение с рекомендацией: видимая нет данных, скрытая нет данных; до: 100% (1/1).");
  });
});

describe("lookups never reach a backfilled decision", () => {
  const T = new Date("2026-10-02T10:00:00.000Z");

  test("the latest answered decision skips a backfilled one that is later in the file", async () => {
    await live("l1", "o0", "ordinary", T);
    await importBackfill(root, file(entry({ flow: null })));
    expect(await latestAnsweredDecision(root)).toBe("l1");
  });

  test("with only backfilled decisions there is no latest one", async () => {
    await importBackfill(root, file(entry({ flow: "392" })));
    expect(await latestAnsweredDecision(root)).toBeUndefined();
    expect(await latestAnsweredDecision(root, "392")).toBeUndefined();
  });

  test("a bare change or reason finds nothing to act on, and changes nothing", async () => {
    await importBackfill(root, file(entry({ flow: "392" })));
    const before = await readRecords(root);
    await expect(changeAnswer({ cwd: root, choice: "o1", flow: "392", session: "s1" })).rejects.toThrow(/no decision from this session/);
    await expect(giveReason({ cwd: root, text: "why", flow: "392", session: "s1" })).rejects.toThrow(/no decision from this session/);
    expect(await readRecords(root)).toEqual(before);
  });

  test("naming a backfilled decision by id still lets the human add a reason, but not change its answer", async () => {
    await importBackfill(root, file(entry({ answer: { choice: "o1" } })));
    await expect(changeAnswer({ cwd: root, id: "bf-p12-q0", choice: "o0" })).rejects.toThrow(/backfilled historical record/);
    const done = await giveReason({ cwd: root, id: "bf-p12-q0", text: "later thought" });
    expect(done).toMatchObject({ id: "bf-p12-q0", recorded: true });
    expect((await loadReport(root)).backfilled.deviations[0]?.reason).toBe("later thought");
  });
});

describe("the CLI knows the subcommand", () => {
  test("`keryx decisions import` is in the known first-subcommand list, so the top-level check lets it through", () => {
    expect(GROUP_SUBCOMMANDS.get("decisions")).toContain("import");
  });
});
