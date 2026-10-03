// Backfilled decisions: the import, their separation in the report and the one-line
// summary, and the lookups that must never reach them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GROUP_SUBCOMMANDS } from "../lib/group-subcommands";
import { importBackfill, parseBackfill, renderImportResult } from "./import";
import { buildReport, renderReport, renderReportLine } from "./report";
import { answerDecision, changeAnswer, giveReason, latestAnsweredDecision, loadReport, openDecision, recordReason, reportLine } from "./service";
import { decisionsDir, journalLockFile, readJournal, readRecords, withJournalLock } from "./store";
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

  test("an answer that is the human's own words is kept when it says so, and is skipped as malformed when it does not", async () => {
    const result = await importBackfill(root, file(entry({ answer: { choice: "neither, do X", other: true } })));
    expect(result).toMatchObject({ imported: 1, answered: 1, deviations: 1 });
    expect(await readRecords(root)).toContainEqual(expect.objectContaining({ kind: "answer", choice: "neither, do X", other: true }));
    const bad = await importBackfill(root, file(entry({ id: "bf-2", answer: { choice: "neither, do X" } })));
    expect(bad.imported).toBe(0);
    expect(bad.malformed).toEqual([{ line: 1, message: expect.stringMatching(/is not one of the options/) }]);
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
  ])("%s is skipped with its line number and reason, and the rest is imported", async (_name, overrides, message) => {
    const text = file(entry({ id: "ok-1" }), entry(overrides as Record<string, unknown>), entry({ id: "ok-3" }));
    const result = await importBackfill(root, text);
    expect(result).toMatchObject({ imported: 2, skipped: 0 });
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]?.line).toBe(2);
    expect(result.malformed[0]?.message).toMatch(message);
    expect((await readRecords(root)).filter((r) => r.kind === "open").map((r) => r.id)).toEqual(["ok-1", "ok-3"]);
    const printed = renderImportResult(result);
    expect(printed.split("\n")[0]).toBe("Imported: 2, skipped: 0, with recommendation: 2, answered: 2, deviations: 0, malformed: 1");
    expect(printed).toMatch(/Malformed \(skipped\):\n {2}line 2: /);
  });

  test("the summary line has no malformed part when every line was read", async () => {
    expect(renderImportResult(await importBackfill(root, file(entry())))).not.toContain("malformed");
  });

  test("a file of only bad lines imports nothing and says so", async () => {
    const result = await importBackfill(root, "{broken\n[1]\n");
    expect(result).toMatchObject({ imported: 0, skipped: 0 });
    expect(result.malformed.map((m) => m.line)).toEqual([1, 2]);
    expect(await readRecords(root)).toEqual([]);
  });

  test("an open record whose answer is missing (a truncated write) gets just the answer on re-import", async () => {
    const text = file(entry({ answer: { choice: "o1" }, reason: "closer to what we do" }), entry({ id: "bf-ok" }));
    await importBackfill(root, text);
    // simulate the crash: the file keeps bf-p12-q0's open record and everything of bf-ok, but loses the answer and the reason of the first
    const kept = (await readRecords(root)).filter((r) => !(r.id === "bf-p12-q0" && r.kind !== "open"));
    const journal = path.join(root, ".metaproject", "data", "decisions", "journal.jsonl");
    await writeFile(journal, kept.map((r) => `${JSON.stringify(r)}\n`).join(""));

    const dry = await importBackfill(root, text, { dryRun: true });
    expect(dry).toMatchObject({ imported: 0, skipped: 1, skippedIds: ["bf-ok"], repaired: 1, repairedIds: ["bf-p12-q0"], answered: 1, deviations: 1 });
    expect(await readRecords(root)).toEqual(kept);

    const again = await importBackfill(root, text);
    expect(again).toMatchObject({ imported: 0, repaired: 1, repairedIds: ["bf-p12-q0"] });
    expect(renderImportResult(again).split("\n")[0]).toBe("Imported: 0, skipped: 1, with recommendation: 0, answered: 1, deviations: 1, repaired: 1");
    const records = await readRecords(root);
    expect(records.filter((r) => r.id === "bf-p12-q0").map((r) => r.kind)).toEqual(["open", "answer", "reason"]);
    expect(records.filter((r) => r.kind === "open")).toHaveLength(2);
    expect(records.find((r) => r.kind === "answer" && r.id === "bf-p12-q0")).toMatchObject({ choice: "o1", at: "2026-08-14T09:30:00.000Z", seq: 1 });

    // and a third import changes nothing
    const third = await importBackfill(root, text);
    expect(third).toMatchObject({ imported: 0, skipped: 2, repaired: 0 });
    expect(await readRecords(root)).toEqual(records);
  });

  test("a live open without an answer is never given a historical one", async () => {
    await openDecision({ cwd: root, id: "bf-p12-q0", question: "live", options: OPTIONS });
    const result = await importBackfill(root, file(entry()));
    expect(result).toMatchObject({ skipped: 1, repaired: 0 });
    expect((await readRecords(root)).map((r) => r.kind)).toEqual(["open"]);
  });

  describe("two runs at once", () => {
    const lockFile = () => journalLockFile(root);
    const exists = (file: string) => access(file).then(() => true, () => false);

    test("the same file imported twice at the same time writes every decision once", async () => {
      const text = file(entry({ id: "c-1" }), entry({ id: "c-2", answer: { choice: "o1" } }), entry({ id: "c-3", answer: null }));
      const runs = await Promise.all([importBackfill(root, text), importBackfill(root, text), importBackfill(root, text), importBackfill(root, text)]);
      expect(runs.map((r) => r.imported).sort()).toEqual([0, 0, 0, 3]);
      expect(runs.reduce((sum, r) => sum + r.skipped, 0)).toBe(9);
      const records = await readRecords(root);
      const opens = records.filter((r) => r.kind === "open").map((r) => r.id);
      expect(opens.sort()).toEqual(["c-1", "c-2", "c-3"]);
      expect(records.filter((r) => r.kind === "answer").map((r) => r.id).sort()).toEqual(["c-1", "c-2"]);
      expect((await readJournal(root)).skipped).toBe(0);
      expect(await exists(lockFile())).toBe(false);
    });

    test("a lock left by a process that no longer exists is broken", async () => {
      await mkdir(decisionsDir(root), { recursive: true });
      await writeFile(lockFile(), JSON.stringify({ pid: 99_999_999, at: new Date().toISOString(), token: "dead" }));
      const result = await importBackfill(root, file(entry()));
      expect(result.imported).toBe(1);
      expect(await exists(lockFile())).toBe(false);
      expect((await readdir(decisionsDir(root))).filter((name) => name.includes("stale"))).toEqual([]);
    });

    test("a lock that is too old is broken even when its pid is alive", async () => {
      await mkdir(decisionsDir(root), { recursive: true });
      await writeFile(lockFile(), JSON.stringify({ pid: process.pid, at: "2026-01-01T00:00:00Z", token: "hung" }));
      const longAgo = new Date(Date.now() - 10 * 60_000);
      await utimes(lockFile(), longAgo, longAgo);
      expect(await withJournalLock(root, async () => "ran")).toBe("ran");
      expect(await exists(lockFile())).toBe(false);
    });

    test("a young lock held by a live process is waited for, then reported", async () => {
      await mkdir(decisionsDir(root), { recursive: true });
      await writeFile(lockFile(), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "busy" }));
      let ran = false;
      await expect(withJournalLock(root, async () => { ran = true; }, { timeoutMs: 150, pollMs: 10 })).rejects.toThrow(/locked by another run/);
      expect(ran).toBe(false);
      expect(await exists(lockFile())).toBe(true);
      // and it is released once the holder lets go
      const waiting = withJournalLock(root, async () => "got it", { timeoutMs: 3000, pollMs: 10 });
      setTimeout(() => void rm(lockFile(), { force: true }), 60);
      expect(await waiting).toBe("got it");
    });

    test("the lock is released when the work throws, and an import with nothing to write still releases it", async () => {
      await expect(withJournalLock(root, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      expect(await exists(lockFile())).toBe(false);
      await importBackfill(root, file(entry()));
      await importBackfill(root, file(entry()));
      expect(await exists(lockFile())).toBe(false);
    });

    test("a dry run takes no lock, so it works while an import holds it", async () => {
      await mkdir(decisionsDir(root), { recursive: true });
      await writeFile(lockFile(), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "busy" }));
      expect((await importBackfill(root, file(entry()), { dryRun: true })).imported).toBe(1);
    });

    test("a lock that was broken while its holder hung is not removed from under the new holder", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let inner: Promise<string> | undefined;
      await withJournalLock(root, async () => {
        await rm(lockFile(), { force: true }); // what breaking it as stale does
        inner = withJournalLock(root, async () => { await gate; return "second"; }, { timeoutMs: 2000, pollMs: 10 });
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      // the first holder is done; the lock on disk is the second one's
      expect(await exists(lockFile())).toBe(true);
      release();
      expect(await inner).toBe("second");
      expect(await exists(lockFile())).toBe(false);
    });
  });

  test("a journal whose last line was cut short is ended with a newline before the batch, so nothing fuses", async () => {
    const journal = path.join(root, ".metaproject", "data", "decisions", "journal.jsonl");
    await mkdir(path.dirname(journal), { recursive: true });
    await writeFile(journal, '{"kind":"answer","id":"old","at":"2026-08-01T00:00:0');
    const result = await importBackfill(root, file(entry()));
    expect(result.imported).toBe(1);
    const raw = await readFile(journal, "utf8");
    expect(raw.split("\n")[0]).toBe('{"kind":"answer","id":"old","at":"2026-08-01T00:00:0');
    expect(raw.endsWith("\n")).toBe(true);
    const { records, skipped } = await readJournal(root);
    expect(skipped).toBe(1);
    expect(records.map((r) => [r.kind, r.id])).toEqual([["open", "bf-p12-q0"], ["answer", "bf-p12-q0"]]);
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
  await openDecision({ cwd: root, id, question: `live ${id}`, options: OPTIONS, recommendation: { optionId: "o0", reason: "" }, arm: mode === "blind" ? "D" : "A", now: () => now });
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

  test("naming a backfilled decision by id changes nothing: not its answer, not its reason, on any path", async () => {
    await importBackfill(root, file(entry({ answer: { choice: "o1" } })));
    const before = await readRecords(root);
    await expect(changeAnswer({ cwd: root, id: "bf-p12-q0", choice: "o0" })).rejects.toThrow(/backfilled historical record/);
    await expect(answerDecision({ cwd: root, id: "bf-p12-q0", choice: "o0" })).rejects.toThrow(/backfilled historical record; its answer is not changed/);
    await expect(recordReason(root, "bf-p12-q0", "later thought")).rejects.toThrow(/backfilled historical record; its reason is not changed/);
    await expect(recordReason(root, "bf-p12-q0", "later thought", undefined, { replace: true })).rejects.toThrow(/backfilled historical record/);
    await expect(giveReason({ cwd: root, id: "bf-p12-q0", text: "later thought" })).rejects.toThrow(/backfilled historical record/);
    expect(await readRecords(root)).toEqual(before);
  });
});

describe("the CLI knows the subcommand", () => {
  test("`keryx decisions import` is in the known first-subcommand list, so the top-level check lets it through", () => {
    expect(GROUP_SUBCOMMANDS.get("decisions")).toContain("import");
  });
});
