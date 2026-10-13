// Flow 400 (AC11): the records from before the arms. `import` stamps them `legacy: true`
// (ordinary into arm A, blind into arm D); a record already in the journal without an
// `arm` is read the same way; the report shows them apart and a flag leaves them out.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { effectiveArm, isLegacy, stampLegacy } from "./legacy";
import { importBackfill } from "./import";
import { answerDecision, openDecision } from "./journal";
import { buildReport, renderReport } from "./report";
import { readJournal, resolveJournalFile } from "./store";
import type { DecisionRecord, OpenRecord } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-legacy-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "o0", label: "First" },
  { id: "o1", label: "Second" },
];

const entry = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "bf-1",
    at: "2026-08-14T09:30:00.000Z",
    flow: "392",
    stage: "design",
    question: "Which way?",
    options: OPTIONS,
    recommendation: { optionId: "o0", reason: "simpler" },
    source: "poll 1",
    answer: { choice: "o0" },
    ...overrides,
  });

/** A record exactly as the journal wrote it before the arms: no arm, seed, preselected, forced, channel or legacy. */
function oldOpen(id: string, mode: "ordinary" | "blind", recommended = "o0"): OpenRecord {
  return {
    kind: "open",
    id,
    at: "2026-09-01T10:00:00.000Z",
    flow: "392",
    stage: "design",
    question: "Old question?",
    options: OPTIONS,
    recommendation: { optionId: recommended, reason: "because" },
    mode,
    order: mode === "blind" ? ["o1", "o0"] : ["o0", "o1"],
    showMark: mode === "ordinary",
    irreversible: false,
  };
}

const oldAnswer = (id: string, choice: string): DecisionRecord => ({ kind: "answer", id, at: "2026-09-01T10:00:09.000Z", seq: 1, choice, timeToAnswerMs: 9000, changed: false });

describe("AC11: importing the pre-v2 records stamps legacy", () => {
  test("an imported ordinary record is legacy and goes to arm A", async () => {
    await importBackfill(root, `${entry()}\n`);
    const open = (await readJournal(root)).records[0] as OpenRecord;
    expect(open).toMatchObject({ backfilled: true, legacy: true, arm: "A", mode: "ordinary", showMark: true });
  });

  test("an imported record marked blind is legacy and goes to arm D, with no mark", async () => {
    await importBackfill(root, `${entry({ id: "bf-2", mode: "blind" })}\n`);
    const open = (await readJournal(root)).records[0] as OpenRecord;
    expect(open).toMatchObject({ backfilled: true, legacy: true, arm: "D", mode: "blind", showMark: false });
  });

  test("a mode that is neither is a malformed line, not silently ordinary", async () => {
    const result = await importBackfill(root, `${entry({ id: "bf-3", mode: "partial" })}\n`);
    expect(result.imported).toBe(0);
    expect(result.malformed[0]?.message).toMatch(/"mode" must be/);
  });

  test("importing the same file again changes nothing: the stamp is idempotent", async () => {
    const text = `${entry()}\n${entry({ id: "bf-2", mode: "blind" })}\n`;
    await importBackfill(root, text);
    const file = await resolveJournalFile(root);
    const once = await readFile(file, "utf8");
    const again = await importBackfill(root, text);
    expect(again).toMatchObject({ imported: 0, skipped: 2 });
    expect(await readFile(file, "utf8")).toBe(once);
  });
});

describe("AC11: a record already in the journal without an arm is read as legacy", () => {
  test("ordinary becomes A, blind becomes D, and stamping twice is the same as once", () => {
    const ordinary = stampLegacy(oldOpen("old-1", "ordinary"));
    const blind = stampLegacy(oldOpen("old-2", "blind"));
    expect(ordinary).toMatchObject({ arm: "A", legacy: true });
    expect(blind).toMatchObject({ arm: "D", legacy: true });
    expect(stampLegacy(ordinary)).toEqual(ordinary);
    expect(stampLegacy(blind)).toEqual(blind);
    expect(effectiveArm(oldOpen("old-3", "blind"))).toBe("D");
    expect(isLegacy(oldOpen("old-1", "ordinary"))).toBe(true);
  });

  test("a record the arms drew is never legacy, whatever its arm", async () => {
    const result = await openDecision({ cwd: root, question: "Fresh?", options: OPTIONS, recommendation: { optionId: "o0", reason: "r" }, arm: "C", salt: "s", seq: 1 });
    const open = (await readJournal(root)).records[0] as OpenRecord;
    expect(result.arm).toBe("C");
    expect(isLegacy(open)).toBe(false);
    expect(stampLegacy(open)).toBe(open);
  });
});

describe("AC11: the report shows legacy separately and a flag excludes it", () => {
  async function journalWithOldAndNew(): Promise<readonly DecisionRecord[]> {
    // 3 old records written the way the journal wrote them before the arms: 2 ordinary (1 followed), 1 blind (followed)
    const file = await resolveJournalFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    const old: DecisionRecord[] = [
      oldOpen("old-1", "ordinary"),
      oldAnswer("old-1", "o0"),
      oldOpen("old-2", "ordinary"),
      oldAnswer("old-2", "o1"),
      oldOpen("old-3", "blind"),
      oldAnswer("old-3", "o0"),
    ];
    await appendFile(file, old.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
    await importBackfill(root, `${entry()}\n`);
    // one decision of the new kind, in arm C
    await openDecision({ cwd: root, id: "new-1", question: "Fresh?", options: OPTIONS, recommendation: { optionId: "o0", reason: "r" }, arm: "C", salt: "s", seq: 4 });
    await answerDecision({ cwd: root, id: "new-1", choice: "o1" });
    return (await readJournal(root)).records;
  }

  test("legacy is a block of its own, split by the arm the old mode stands for, and never in an arm table", async () => {
    const report = buildReport(await journalWithOldAndNew());
    expect(report.legacy).toMatchObject({ total: 3, answered: 3, byArm: { A: { answered: 2, matched: 1 }, D: { answered: 1, matched: 1 } } });
    expect(report.byArm.C.decisions).toBe(1);
    expect(report.byArm.A.decisions).toBe(0);
    expect(report.byArm.D.decisions).toBe(0);
    // the imported historical record keeps its own block
    expect(report.backfilled.total).toBe(1);
    const text = renderReport(report);
    expect(text).toContain("Legacy, before the arms (3 decisions; not randomized");
    expect(text).toContain("A (was ordinary) 50% (1/2), D (was blind) 100% (1/1)");
  });

  test("--exclude-legacy leaves legacy and the imported records out of every number", async () => {
    const records = await journalWithOldAndNew();
    const report = buildReport(records, 0, { excludeLegacy: true });
    expect(report.excludeLegacy).toBe(true);
    expect(report.total).toBe(1);
    expect(report.legacy.total).toBe(0);
    expect(report.backfilled.total).toBe(0);
    expect(report.byMode.ordinary.answered).toBe(0);
    expect(report.byArm.C.decisions).toBe(1);
    expect(renderReport(report)).not.toContain("Legacy, before the arms");
    expect(renderReport(report)).toContain("left out of this report");
  });

  test("without the flag the old totals still count the old records, as before", async () => {
    const report = buildReport(await journalWithOldAndNew());
    expect(report.total).toBe(4);
    expect(report.byMode.ordinary.answered).toBe(2);
    expect(report.byMode.blind.answered).toBe(1);
  });
});
