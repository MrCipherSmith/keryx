// Flow 392 (AC1-AC7, AC9): the recommendation journal. Every test works in its own
// temp project root; the random source and the clock are injected, so a blind
// draw or a time to answer is exact, not statistical (except the 1/3 check, which
// is a seeded run).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import {
  answerDecision,
  buildReport,
  journalAsk,
  giveReason,
  journalFile,
  loadReport,
  openDecision,
  recordReason,
  renderReport,
  reportText,
  type AskRequest,
} from "./service";
import { readRecords } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-decisions-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one" },
  { id: "b", label: "Option B", description: "the quick one" },
  { id: "c", label: "Option C", description: "the odd one" },
];

function clock(...isoTimes: string[]): () => Date {
  let i = 0;
  return () => new Date(isoTimes[Math.min(i++, isoTimes.length - 1)] as string);
}

describe("AC1 and AC2: one record per question, the recommendation first", () => {
  test("open writes the question, options, recommendation, reason, mode and order; answer adds the choice and the time", async () => {
    const opened = await openDecision({
      cwd: root,
      question: "Which approach?",
      options: OPTIONS,
      recommendation: { optionId: "a", reason: "least risk" },
      stage: "design",
      arm: "A",
      now: clock("2026-10-02T10:00:00.000Z"),
      id: "d-1",
    });
    expect(opened).toMatchObject({ id: "d-1", mode: "ordinary", order: ["a", "b", "c"], showMark: true, irreversible: false });

    const answered = await answerDecision({ cwd: root, id: "d-1", choice: "a", now: clock("2026-10-02T10:00:07.500Z") });
    expect(answered).toMatchObject({ choice: "a", matched: true, deviation: false, askReason: false, timeToAnswerMs: 7500, changed: false });

    const records = await readRecords(root);
    expect(records.map((r) => r.kind)).toEqual(["open", "answer"]);
    expect(records[0]).toMatchObject({
      kind: "open",
      flow: null,
      stage: "design",
      question: "Which approach?",
      recommendation: { optionId: "a", reason: "least risk" },
      mode: "ordinary",
      order: ["a", "b", "c"],
    });
    expect(records[1]).toMatchObject({ kind: "answer", choice: "a", timeToAnswerMs: 7500, seq: 1 });
  });

  test("the record is on disk before the host shows the question", async () => {
    let seenAtDisplay: string[] = [];
    const ask = journalAsk(
      async () => {
        seenAtDisplay = (await readRecords(root)).map((r) => r.kind);
        return "a";
      },
      { cwd: root },
    );
    await ask({ question: "Pick", options: OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) })) });
    expect(seenAtDisplay).toEqual(["open"]);
    expect((await readRecords(root)).map((r) => r.kind)).toEqual(["open", "answer"]);
  });

  test("a question without a recommendation is still recorded, and is never blind", async () => {
    const opened = await openDecision({ cwd: root, question: "Any idea?", options: OPTIONS, arm: "D", random: () => 0 });
    expect(opened.mode).toBe("ordinary");
    expect(opened.showMark).toBe(false);
    expect((await readRecords(root))[0]).toMatchObject({ kind: "open", recommendation: null });
  });

  test("refuses fewer than two options, a duplicate id, and a recommendation that is not an option", async () => {
    await expect(openDecision({ cwd: root, question: "q", options: [OPTIONS[0] as (typeof OPTIONS)[number]] })).rejects.toThrow(/two options/);
    await expect(openDecision({ cwd: root, question: "q", options: [OPTIONS[0] as (typeof OPTIONS)[number], OPTIONS[0] as (typeof OPTIONS)[number]] })).rejects.toThrow(/duplicate/);
    await expect(
      openDecision({ cwd: root, question: "q", options: OPTIONS, recommendation: { optionId: "zzz", reason: "x" } }),
    ).rejects.toThrow(/not one of the options/);
  });
});

describe("AC3: blind mode", () => {
  test("blind hides the mark, shuffles the order and reveals the recommendation right after the answer", async () => {
    const shown: AskRequest[] = [];
    const notes: string[] = [];
    const ask = journalAsk(
      async (request) => {
        shown.push(request);
        // the question is answered "b"; the reason prompt that follows the deviation is skipped
        return request.question === "Pick" ? "b" : "skip";
      },
      { cwd: root, notify: (text) => notes.push(text), arm: "D", random: sequence([0.1, 0.0, 0.0]) },
    );
    const chosen = await ask({ question: "Pick", options: OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) })) });
    expect(chosen).toBe("b");
    const request = shown[0];
    expect(request?.options.some((o) => o.recommended === true)).toBe(false);
    // The shuffle moved the options: it is a permutation, and not the given order.
    expect(request?.options.map((o) => o.id).sort()).toEqual(["a", "b", "c"]);
    expect(request?.options.map((o) => o.id)).not.toEqual(["a", "b", "c"]);
    // the reveal is one transcript line; the reason is asked as its own awaited question (the answer deviated)
    expect(notes).toHaveLength(1);
    expect(shown).toHaveLength(2);
    expect(notes[0]).toContain("Option A");
    // ask_user options carry a description of the option, not a reason for recommending it (F-007)
    expect(notes[0]).not.toContain("the safe one");
    expect((await readRecords(root))[0]).toMatchObject({ recommendation: { optionId: "a", reason: "" } });
    expect((await readRecords(root))[0]).toMatchObject({ mode: "blind", showMark: false });
  });

  test("an ordinary question keeps the order and the mark", async () => {
    const shown: AskRequest[] = [];
    const ask = journalAsk(
      async (request) => {
        shown.push(request);
        return "a";
      },
      { cwd: root, arm: "A" },
    );
    await ask({ question: "Pick", options: OPTIONS.map((o, i) => ({ ...o, ...(i === 1 ? { recommended: true } : {}) })) });
    expect(shown[0]?.options.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(shown[0]?.options.find((o) => o.recommended === true)?.id).toBe("b");
  });

  test("about a third of the questions are blind (seeded run)", async () => {
    let blind = 0;
    const runs = 900;
    for (let i = 0; i < runs; i += 1) {
      const opened = await openDecision({ cwd: root, question: `Q${i}`, options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, salt: "fixed-test-salt", seq: i + 1 });
      if (opened.mode === "blind") blind += 1;
    }
    expect(blind / runs).toBeGreaterThan(0.16);
    expect(blind / runs).toBeLessThan(0.24);
  });
});

describe("AC4: irreversible actions are never blind", () => {
  test("a release, a delete and a push are asked in the ordinary way, even when the draw says blind", async () => {
    const draw = "D" as const; // always "blind"
    for (const [question, action] of [
      ["Ship version 1.4 now?", "release"],
      ["Remove the old branch?", "delete"],
      ["Push the fix to the shared repo?", undefined],
      ["Delete the cache directory?", undefined],
    ] as const) {
      const opened = await openDecision({ cwd: root, question, options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, action, arm: draw });
      expect(opened.mode).toBe("ordinary");
      expect(opened.blindRefused).toBe(true);
      expect(opened.showMark).toBe(true);
      expect(opened.irreversible).toBe(true);
    }
    const plain = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, arm: draw });
    expect(plain.mode).toBe("blind");
  });

  test("the config list adds actions, and cannot remove the built-in ones", async () => {
    await writeFile(path.join(root, ".metaproject", "decisions.config.json"), JSON.stringify({ irreversible: ["migrate prod"] }), "utf8");
    const custom = await openDecision({ cwd: root, question: "Migrate prod tonight?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, arm: "D", random: () => 0 });
    expect(custom.mode).toBe("ordinary");
    const builtin = await openDecision({ cwd: root, question: "Release it?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, arm: "D", random: () => 0 });
    expect(builtin.mode).toBe("ordinary");
  });

  test("a broken config falls back to the built-in list", async () => {
    await writeFile(path.join(root, ".metaproject", "decisions.config.json"), "{ not json", "utf8");
    const opened = await openDecision({ cwd: root, question: "Deploy now?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, arm: "D", random: () => 0 });
    expect(opened.mode).toBe("ordinary");
  });
});

describe("AC5: a changed answer", () => {
  test("keeps both answers and says the second one was changed", async () => {
    await openDecision({ cwd: root, question: "Which?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, arm: "D", random: () => 0, id: "d-2", now: clock("2026-10-02T10:00:00Z") });
    const first = await answerDecision({ cwd: root, id: "d-2", choice: "b", now: clock("2026-10-02T10:00:05Z") });
    const second = await answerDecision({ cwd: root, id: "d-2", choice: "a", now: clock("2026-10-02T10:00:20Z") });
    expect(first.changed).toBe(false);
    expect(second).toMatchObject({ changed: true, seq: 2, choice: "a", matched: true });
    const answers = (await readRecords(root)).filter((r) => r.kind === "answer");
    expect(answers).toHaveLength(2);
    expect(answers.map((r) => (r.kind === "answer" ? r.choice : ""))).toEqual(["b", "a"]);

    const report = await loadReport(root);
    expect(report.changed).toBe(1);
    // The share counts the first (unprompted) answer, so the change does not hide the deviation.
    expect(report.byMode.blind).toEqual({ answered: 1, matched: 0 });
    expect(report.deviations[0]).toMatchObject({ id: "d-2", chose: "b", changed: true });
  });
});

describe("AC6: the reason for a deviation, asked once", () => {
  test("answer says to ask, the reason is recorded, and a second ask is refused", async () => {
    await openDecision({ cwd: root, question: "Which?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, id: "d-3", arm: "A" });
    const answered = await answerDecision({ cwd: root, id: "d-3", choice: "c" });
    expect(answered).toMatchObject({ deviation: true, askReason: true });
    expect(await recordReason(root, "d-3", "A is too slow for this")).toBe(true);
    expect(await recordReason(root, "d-3", "second try")).toBe(false);
    expect((await answerDecision({ cwd: root, id: "d-3", choice: "b" })).askReason).toBe(false);
    expect((await loadReport(root)).deviations[0]?.reason).toBe("A is too slow for this");
  });

  test("an empty reason is recorded as absent", async () => {
    await openDecision({ cwd: root, question: "Which?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, id: "d-4", arm: "A" });
    await answerDecision({ cwd: root, id: "d-4", choice: "b" });
    expect(await recordReason(root, "d-4", "   ")).toBe(true);
    const reason = (await readRecords(root)).find((r) => r.kind === "reason");
    expect(reason).toBeDefined();
    expect(reason && "reason" in reason).toBe(false);
    expect((await loadReport(root)).deviations[0]).not.toHaveProperty("reason");
  });

  test("through ask_user: the tool result waits once for the reason, and an empty answer releases it", async () => {
    const questions: string[] = [];
    let release: (answer: string) => void = () => {};
    const ask = journalAsk(
      (request) => {
        questions.push(request.question);
        if (questions.length === 1) return Promise.resolve("b");
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      { cwd: root, arm: "A" },
    );
    const options = OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) }));
    let settled = false;
    const pending = ask({ question: "First?", options }).then((value) => {
      settled = true;
      return value;
    });
    // the reason prompt is open and the tool result is held, with no timeout
    for (let i = 0; i < 40 && questions.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(questions).toHaveLength(2);
    expect(questions[1]).toContain("Why?");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    release("");
    expect(await pending).toBe("b");
    // an empty answer is recorded as absent and counts as the one ask
    const reasons = (await readRecords(root)).filter((r) => r.kind === "reason");
    expect(reasons).toHaveLength(1);
    expect(reasons[0] && "reason" in reasons[0]).toBe(false);
    expect((await loadReport(root)).deviations[0]).not.toHaveProperty("reason");
  });

  test("through ask_user: a typed reason is recorded, and a later answer to the same decision asks nothing more", async () => {
    const questions: string[] = [];
    const ask = journalAsk(
      async (request) => {
        questions.push(request.question);
        return questions.length === 1 ? "b" : "A is too slow";
      },
      { cwd: root, arm: "A" },
    );
    const options = OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) }));
    expect(await ask({ question: "First?", options })).toBe("b");
    expect(questions).toHaveLength(2);
    expect((await loadReport(root)).deviations[0]?.reason).toBe("A is too slow");
    // a second answer to the same decision is not asked about again
    const id = (await readRecords(root)).find((r) => r.kind === "open")?.id ?? "";
    expect((await answerDecision({ cwd: root, id, choice: "c" })).askReason).toBe(false);
  });

  test("through ask_user: a failing reason prompt never throws into the question", async () => {
    let calls = 0;
    const ask = journalAsk(
      async () => {
        calls += 1;
        if (calls === 2) throw new Error("prompt closed");
        return "b";
      },
      { cwd: root, arm: "A" },
    );
    const options = OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) }));
    expect(await ask({ question: "First?", options })).toBe("b");
    expect(calls).toBe(2);
  });

  test("/decisions reason can still add or change a reason later (the latest wins)", async () => {
    await openDecision({ cwd: root, question: "Which?", options: OPTIONS, recommendation: { optionId: "a", reason: "r" }, id: "d-5", arm: "A" });
    await answerDecision({ cwd: root, id: "d-5", choice: "b" });
    await recordReason(root, "d-5", undefined);
    const added = await giveReason({ cwd: root, id: "d-5", text: "B fits the deadline" });
    expect(added).toMatchObject({ recorded: true, replaced: false });
    const changed = await giveReason({ cwd: root, id: "d-5", text: "B fits, and A is slow" });
    expect(changed).toMatchObject({ recorded: true, replaced: true });
    expect((await loadReport(root)).deviations[0]?.reason).toBe("B fits, and A is slow");
  });

  test("through ask_user: a followed recommendation says nothing about a reason", async () => {
    const notes: string[] = [];
    const ask = journalAsk(async () => "a", { cwd: root, arm: "A", notify: (text) => notes.push(text) });
    await ask({ question: "Pick", options: OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) })) });
    expect(notes).toEqual([]);
  });
});

describe("AC7: the report is deterministic and has the pieces", () => {
  async function seed() {
    // id, stage, mode draw (0 = blind, .9 = ordinary), recommended, chose, ms
    const plan: Array<[string, string, number, string, string, number]> = [
      ["d-r1", "design", 0.9, "a", "a", 4000],
      ["d-r2", "design", 0.9, "a", "b", 6000],
      ["d-r3", "build", 0, "a", "a", 3000],
      ["d-r4", "build", 0, "a", "c", 9000],
    ];
    for (const [id, stage, draw, rec, chose, ms] of plan) {
      await openDecision({ cwd: root, question: `Question ${id}`, options: OPTIONS, recommendation: { optionId: rec, reason: "r" }, stage, id, arm: draw === 0 ? "D" : "A", now: clock("2026-10-02T10:00:00Z") });
      await answerDecision({ cwd: root, id, choice: chose, now: clock(new Date(Date.parse("2026-10-02T10:00:00Z") + ms).toISOString()) });
    }
    await recordReason(root, "d-r2", "B fits the deadline");
    await openDecision({ cwd: root, question: "Still open", options: OPTIONS, id: "d-open", arm: "A" });
  }

  test("prints the match share by mode and by stage, and the deviations with their reasons", async () => {
    await seed();
    const report = await loadReport(root);
    expect(report.total).toBe(5);
    expect(report.answered).toBe(4);
    expect(report.unanswered).toBe(1);
    expect(report.byMode.ordinary).toEqual({ answered: 2, matched: 1 });
    expect(report.byMode.blind).toEqual({ answered: 2, matched: 1 });
    expect(report.byStage.map((s) => s.stage)).toEqual(["build", "design"]);
    expect(report.deviations.map((d) => d.id)).toEqual(["d-r2", "d-r4"]);

    const text = renderReport(report);
    expect(text).toContain("ordinary  50% (1/2)");
    expect(text).toContain("blind     50% (1/2)");
    expect(text).toContain("design: ordinary 50% (1/2), blind n/a");
    expect(text).toContain("build: ordinary n/a, blind 50% (1/2)");
    expect(text).toContain("reason: B fits the deadline");
    expect(text).toContain("reason: (none given)");
  });

  test("the same journal always gives the same text, and reading it never writes", async () => {
    await seed();
    const before = await readFile(journalFile(root), "utf8");
    const one = await reportText(root);
    const two = await reportText(root);
    expect(one).toBe(two);
    expect(buildReport(await readRecords(root))).toEqual(buildReport(await readRecords(root)));
    expect(await readFile(journalFile(root), "utf8")).toBe(before);
  });

  test("an empty journal says so", async () => {
    expect(await reportText(root)).toBe("No decisions recorded yet.");
  });

  test("a damaged line is skipped, not fatal", async () => {
    await seed();
    await writeFile(journalFile(root), `not json\n${await readFile(journalFile(root), "utf8")}{"half":\n`, "utf8");
    const report = await loadReport(root);
    expect(report.total).toBe(5);
    expect(report.skipped).toBe(2);
    expect(renderReport(report)).toContain("Skipped 2 unreadable journal records.");
  });
});

describe("AC9: never blocks the question; project journal and flow journal", () => {
  test("a journal that cannot be written leaves a note and the question goes on", async () => {
    // `.metaproject/data` is a FILE, so creating `.metaproject/data/decisions` fails.
    await writeFile(path.join(root, ".metaproject", "data"), "in the way", "utf8");
    const notes: string[] = [];
    let asked = 0;
    const ask = journalAsk(
      async () => {
        asked += 1;
        return "b";
      },
      { cwd: root, onNote: (text) => notes.push(text), arm: "D", random: () => 0 },
    );
    const result = await ask({ question: "Pick", options: OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) })) });
    expect(result).toBe("b");
    expect(asked).toBe(1);
    expect(notes.length).toBeGreaterThan(0);
  });

  test("a question outside a flow goes to the project journal only", async () => {
    const ask = journalAsk(async () => "a", { cwd: root, arm: "A" });
    await ask({ question: "Pick", options: OPTIONS });
    expect((await readRecords(root))[0]).toMatchObject({ flow: null });
  });

  test("a question inside a flow is also a line in that flow's journal.md", async () => {
    const flows = createFlowService({ tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-10-02T10:00:00Z") });
    const created = await flows.init({ cwd: root, title: "Journaled" });
    const ask = journalAsk(async () => "b", { cwd: root, flow: created.flow.id, stage: "design", arm: "A" });
    await ask({ question: "Pick", options: OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) })) });
    const journal = await readFile(path.join(root, created.dir, "journal.md"), "utf8");
    expect(journal).toContain("decision d-");
    expect(journal).toContain("[design, ordinary]: chose b; recommended a");
    const records = await readRecords(root);
    expect(records.find((r) => r.kind === "open")).toMatchObject({ flow: created.flow.id });
  });

  test("a flow that does not exist does not break the answer", async () => {
    const opened = await openDecision({ cwd: root, question: "Pick", options: OPTIONS, flow: "9999", arm: "A" });
    const answered = await answerDecision({ cwd: root, id: opened.id, choice: "a" });
    expect(answered.choice).toBe("a");
  });

  test("a cancelled question writes no answer", async () => {
    const ask = journalAsk(async () => "__cancel__", { cwd: root, arm: "A" });
    expect(await ask({ question: "Pick", options: OPTIONS })).toBe("__cancel__");
    expect((await readRecords(root)).map((r) => r.kind)).toEqual(["open"]);
  });
});

/** A random source that returns the given values in turn, then 0.5. */
function sequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0.5;
}
