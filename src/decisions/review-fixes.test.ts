// Flow 392, review findings F-001 .. F-011 on PR #856: one test (or more) per fix.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { stripRecommendedMarks } from "./ask";
import { isIrreversible } from "./blind";
import { journalAsk, openDecision, answerDecision, resolveFlowContext, changeAnswer, giveReason, loadReport, renderReport, DEFAULT_IRREVERSIBLE, journalFile, type AskRequest } from "./service";
import { readJournal, readRecords, resolveJournalFile } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-decisions-fix-"));
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
const REC = { optionId: "a", reason: "" };
const withRec = (): Array<(typeof OPTIONS)[number] & { recommended?: boolean }> => OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) }));

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

async function initRepo(dir: string, branch = "main"): Promise<void> {
  await git(dir, "init", "-q", "-b", branch);
  await git(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

const flows = () => createFlowService({ tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-10-02T10:00:00Z") });

/** An ask that answers the question with `choice` and the reason prompt that follows a deviation with `reason`. */
const answering = (choice: string, reason = "skip") => async (request: AskRequest) => (request.question.includes("Why?") ? reason : choice);

describe("F-001 / F-002: the reason is asked once and awaited; the TUI can add or change it later", () => {
  test("a deviation asks for the reason once, waits for it, and the question itself is not asked again", async () => {
    const shown: string[] = [];
    const ask = journalAsk(async (request: AskRequest) => (shown.push(request.question), answering("b", "too slow")(request)), { cwd: root, arm: "A" });
    expect(await ask({ question: "Pick", options: withRec() })).toBe("b");
    expect(shown).toHaveLength(2);
    expect(shown[0]).toBe("Pick");
    expect(shown[1]).toContain("Why?");
    expect((await loadReport(root)).deviations[0]?.reason).toBe("too slow");
  });

  test("a skipped or cancelled reason prompt records an absent reason", async () => {
    for (const reply of ["skip", "later", "__cancel__", "   "]) {
      const dir = await mkdtemp(path.join(tmpdir(), "keryx-decisions-skip-"));
      await mkdir(path.join(dir, ".metaproject"), { recursive: true });
      try {
        const ask = journalAsk(answering("b", reply), { cwd: dir, arm: "A" });
        expect(await ask({ question: "Pick", options: withRec() })).toBe("b");
        expect((await loadReport(dir)).deviations[0]).not.toHaveProperty("reason");
        expect((await readRecords(dir)).filter((r) => r.kind === "reason")).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("giveReason adds a reason later for the latest answered decision, and changes it (the latest wins)", async () => {
    const ids: string[] = [];
    const ask = journalAsk(answering("b"), { cwd: root, arm: "A", onDecision: (id) => ids.push(id) });
    await ask({ question: "Pick", options: withRec() });
    const given = await giveReason({ cwd: root, text: "B fits the deadline", lastId: ids[0] });
    expect(given).toMatchObject({ recorded: true, replaced: false });
    const again = await giveReason({ cwd: root, text: "B fits, and A is slow", lastId: ids[0] });
    expect(again).toMatchObject({ recorded: true, replaced: true });
    expect((await loadReport(root)).deviations[0]?.reason).toBe("B fits, and A is slow");
  });

  test("a reason needs text and a deviation", async () => {
    const ids: string[] = [];
    const ask = journalAsk(async () => "a", { cwd: root, arm: "A", onDecision: (id) => ids.push(id) });
    await ask({ question: "Pick", options: withRec() });
    await expect(giveReason({ cwd: root, text: "  ", lastId: ids[0] })).rejects.toThrow(/needs some text/);
    await expect(giveReason({ cwd: root, text: "why", lastId: ids[0] })).rejects.toThrow(/no deviation/);
  });
});

describe("F-011: the answer can be changed after the reveal", () => {
  test("changeAnswer takes an option id or a label, keeps both answers, and the share counts the first", async () => {
    const ids: string[] = [];
    const ask = journalAsk(async () => "b", { cwd: root, arm: "D", random: () => 0, onDecision: (id) => ids.push(id) });
    await ask({ question: "Pick", options: withRec() });
    const changed = await changeAnswer({ cwd: root, choice: "option a", lastId: ids[0] });
    expect(changed).toMatchObject({ changed: true, seq: 2, choice: "a", matched: true });
    const answers = (await readRecords(root)).filter((r) => r.kind === "answer");
    expect(answers).toHaveLength(2);
    const report = await loadReport(root);
    expect(report.changed).toBe(1);
    expect(report.byMode.blind).toEqual({ answered: 1, matched: 0 });
  });

  test("an unknown option is refused and lists the valid ones", async () => {
    const ids: string[] = [];
    const ask = journalAsk(async () => "b", { cwd: root, arm: "A", onDecision: (id) => ids.push(id) });
    await ask({ question: "Pick", options: withRec() });
    await expect(changeAnswer({ cwd: root, choice: "zzz", lastId: ids[0] })).rejects.toThrow(/not one of the options.*a \(Option A\)/);
  });
});

describe("F-003: the flow and the stage are resolved, and the journal.md line is written", () => {
  test("from the branch name (flow number), with the flow status as the stage", async () => {
    await initRepo(root);
    const created = await flows().init({ cwd: root, title: "Journaled" });
    await git(root, "checkout", "-q", "-b", `feat/flow-${created.flow.id}-journaled`);
    const context = await resolveFlowContext(root, {});
    expect(context.flow).toBe(created.flow.id);
    expect(context.stage).toBe(created.flow.status);

    const ask = journalAsk(async () => "b", { cwd: root, context: () => resolveFlowContext(root, {}), arm: "A" });
    await ask({ question: "Pick", options: withRec() });
    const open = (await readRecords(root)).find((r) => r.kind === "open");
    expect(open).toMatchObject({ flow: created.flow.id, stage: created.flow.status });
    const journal = await readFile(path.join(root, created.dir, "journal.md"), "utf8");
    expect(journal).toContain(`[${created.flow.status}, ordinary]: chose b; recommended a`);
  });

  test("from the flow's slug in the branch name, and from KERYX_FLOW first", async () => {
    await initRepo(root);
    const created = await flows().init({ cwd: root, title: "Recommendation journal" });
    await git(root, "checkout", "-q", "-b", "feat/flow-f-recommendation-journal");
    expect((await resolveFlowContext(root, {})).flow).toBe(created.flow.id);
    expect((await resolveFlowContext(root, { KERYX_FLOW: created.flow.id })).flow).toBe(created.flow.id);
  });

  test("no flow in the branch and no single flow in progress is no context", async () => {
    await initRepo(root);
    await flows().init({ cwd: root, title: "Alpha thing" });
    await flows().init({ cwd: root, title: "Beta thing" });
    expect(await resolveFlowContext(root, {})).toEqual({});
  });
});

describe("F-004: the irreversible list reads the options and Russian wording", () => {
  const list = [...DEFAULT_IRREVERSIBLE];
  test.each([
    ["Выпускаем релиз сегодня?"],
    ["Удалить кеш?"],
    ["Запушить в main?"],
    ["Опубликовать пакет?"],
    ["Слить ветку?"],
    ["Смержить PR?"],
    ["Unpublish the package?"],
    ["Merge the branch?"],
    ["Drop the table?"],
    ["Force push the update?"],
    ["Force the update on production?"],
  ])("%s is irreversible", (question) => {
    expect(isIrreversible(list, question)).toBe(true);
  });

  test("an option can carry the action when the question does not", () => {
    expect(isIrreversible(list, "Which way?", undefined, [{ id: "x", label: "Ship it now", description: "publish to npm" }, { id: "y", label: "Hold" }])).toBe(true);
    expect(isIrreversible(list, "Which way?", undefined, [{ id: "x", label: "Left" }, { id: "y", label: "Right" }])).toBe(false);
  });

  test("openDecision refuses blind when only an option names the action", async () => {
    const opened = await openDecision({
      cwd: root,
      question: "Which way?",
      options: [
        { id: "a", label: "Option A", description: "Merge it into main" },
        { id: "b", label: "Option B" },
      ],
      recommendation: REC,
      arm: "D", random: () => 0,
    });
    expect(opened).toMatchObject({ mode: "ordinary", blindRefused: true });
  });
});

describe("F-005: an answer must be one of the options", () => {
  test("a choice that is no option is refused and writes nothing", async () => {
    const opened = await openDecision({ cwd: root, question: "Pick", options: OPTIONS, recommendation: REC, arm: "A" });
    await expect(answerDecision({ cwd: root, id: opened.id, choice: "nope" })).rejects.toThrow(/not one of the options.*a, b, c/);
    expect((await readRecords(root)).map((r) => r.kind)).toEqual(["open"]);
  });

  test("a free-form ask_user answer is recorded as such, and counts as a deviation", async () => {
    const ask = journalAsk(async () => "something else entirely", { cwd: root, arm: "A" });
    await ask({ question: "Pick", options: withRec(), allowFreeform: true });
    const answer = (await readRecords(root)).find((r) => r.kind === "answer");
    expect(answer).toMatchObject({ choice: "something else entirely", other: true });
    expect((await loadReport(root)).deviations).toHaveLength(1);
  });
});

describe("F-006: a malformed record does not take the report down", () => {
  test("a malformed open is skipped and counted", async () => {
    await openDecision({ cwd: root, question: "Fine", options: OPTIONS, recommendation: REC, id: "d-ok", arm: "A" });
    const file = await resolveJournalFile(root);
    const bad = [
      JSON.stringify({ kind: "open", id: "d-bad", at: "2026-10-02T10:00:00Z" }),
      JSON.stringify({ kind: "open", id: "d-bad2", at: "x", flow: null, stage: "s", question: "q", options: [{}], mode: "blind", order: [], recommendation: { optionId: 1 } }),
      JSON.stringify({ kind: "answer", id: "d-ok", at: "x", seq: "one", choice: "a" }),
    ];
    await writeFile(file, `${await readFile(file, "utf8")}${bad.join("\n")}\n`, "utf8");
    const read = await readJournal(root);
    expect(read.skipped).toBe(3);
    const report = await loadReport(root);
    expect(report.total).toBe(1);
    expect(report.skipped).toBe(3);
    expect(renderReport(report)).toContain("Skipped 3 unreadable journal records.");
  });
});

describe("F-007: the recorded reason is the real one, or none", () => {
  test("ask_user records no reason for the recommendation, and the reveal does not invent one", async () => {
    const notes: string[] = [];
    const ask = journalAsk(async () => "b", { cwd: root, arm: "D", random: () => 0, notify: (t) => notes.push(t) });
    await ask({ question: "Pick", options: withRec() });
    expect((await readRecords(root))[0]).toMatchObject({ recommendation: { optionId: "a", reason: "" } });
    expect(notes[0]).not.toContain("the safe one");
  });
});

describe("F-008: a journaling failure is a visible note", () => {
  test("the bridge-style onNote receives the failure, and the question still returns", async () => {
    await writeFile(path.join(root, ".metaproject", "data"), "in the way", "utf8");
    const notes: string[] = [];
    const ask = journalAsk(async () => "a", { cwd: root, onNote: (t) => notes.push(t), arm: "D", random: () => 0 });
    expect(await ask({ question: "Pick", options: withRec() })).toBe("a");
    expect(notes[0]).toContain("decision journal: could not open a record");
  });

  test("a note sink that throws changes nothing", async () => {
    await writeFile(path.join(root, ".metaproject", "data"), "in the way", "utf8");
    const ask = journalAsk(async () => "a", {
      cwd: root,
      onNote: () => {
        throw new Error("sink down");
      },
    });
    expect(await ask({ question: "Pick", options: withRec() })).toBe("a");
  });
});

describe("F-009: worktrees share one journal under the main checkout", () => {
  test("a record written from a linked worktree is read from the main checkout", async () => {
    await initRepo(root);
    const worktree = path.join(await realpath(tmpdir()), `keryx-decisions-wt-${Date.now()}`);
    await git(root, "worktree", "add", "-q", "-b", "side", worktree);
    try {
      await openDecision({ cwd: worktree, question: "From the worktree", options: OPTIONS, recommendation: REC, id: "d-wt", arm: "A" });
      expect((await readRecords(root)).map((r) => r.id)).toEqual(["d-wt"]);
      expect(await resolveJournalFile(worktree)).toBe(await resolveJournalFile(root));
      expect(await resolveJournalFile(worktree)).toBe(journalFile(await realpath(root)));
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("outside a git repository the journal stays under cwd", async () => {
    expect(await resolveJournalFile(root)).toBe(journalFile(root));
  });
});

describe("F-010: blind mode hides recommended marks written into labels", () => {
  test.each([
    ["Option A (Recommended)", "Option A"],
    ["Option A [recommended]", "Option A"],
    ["Option A - recommended", "Option A"],
    ["Recommended: Option A", "Option A"],
    ["Option A (рекомендуется)", "Option A"],
    ["Option A ⭐", "Option A"],
    ["Option A", "Option A"],
  ])("%s -> %s", (label, expected) => {
    expect(stripRecommendedMarks(label)).toBe(expected);
  });

  test("the labels shown in a blind question carry no mark; an ordinary question keeps them", async () => {
    const marked = [
      { id: "a", label: "Option A (Recommended)", description: "the safe one", recommended: true },
      { id: "b", label: "Option B", description: "the quick one" },
    ];
    const blindShown: AskRequest[] = [];
    await journalAsk(async (r) => (blindShown.push(r), "a"), { cwd: root, arm: "D", random: () => 0 })({ question: "Pick", options: marked });
    expect(blindShown[0]?.options.map((o) => o.label).sort()).toEqual(["Option A", "Option B"]);

    const ordinaryShown: AskRequest[] = [];
    await journalAsk(async (r) => (ordinaryShown.push(r), "a"), { cwd: root, arm: "A" })({ question: "Pick", options: marked });
    expect(ordinaryShown[0]?.options[0]?.label).toBe("Option A (Recommended)");
  });
});
