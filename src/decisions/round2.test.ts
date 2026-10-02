// Flow 392, review round 2 on PR #856: the two-tier irreversible matcher, one-line
// free text, the single non-blocking reason prompt, follow-up targeting, and the
// flow attribution source.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { isIrreversible, DEFAULT_IRREVERSIBLE } from "./blind";
import { buildReport, renderReport } from "./report";
import { MAX_TEXT_LENGTH, oneLine } from "./text";
import {
  answerDecision,
  changeAnswer,
  giveReason,
  journalAsk,
  loadReport,
  openDecision,
  resolveFlowContext,
} from "./service";
import { readRecords } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-decisions-r2-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one" },
  { id: "b", label: "Option B", description: "the quick one" },
];
const withRec = (): Array<(typeof OPTIONS)[number] & { recommended?: boolean }> => OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) }));

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

/** A new flow starts as a draft; the one-flow-in-progress inference needs it in progress. */
async function startFlow(dir: string): Promise<void> {
  const file = path.join(root, dir, "flow.json");
  const flow = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...flow, status: "in-progress" }, null, 2), "utf8");
}

const flows = () => createFlowService({ tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-10-02T10:00:00Z") });

describe("AC3 / AC11: the matcher keeps blind mode usable", () => {
  const list = [...DEFAULT_IRREVERSIBLE];
  const ordinary = [
    "Which name for the helper: parseConfig or readConfig?",
    "Should this module be split into two files?",
    "Merge the two date helpers into one?",
    "Drop the unused import in utils.ts?",
    "Remove the dead code in the parser?",
    "Force the return value to a string type?",
    "Where should the test files live: next to the source or in a tests folder?",
    "Refactor the reducer to use a switch statement?",
    "Rename the variable count to total?",
    "Use a Map or a plain object for the cache?",
    "Should the retry logic be extracted into a function?",
    "Merge these two React components into one?",
    "Drop the legacy fallback in the formatter?",
    "Remove the redundant null check?",
    "Force a cast here or add a type guard?",
    "Use async/await or promise chains in the loader?",
    "Should the error message mention the file name?",
    "Maintain the old signature or change the parameter order?",
    "Is the original implementation of sort stable enough?",
    "Which logging level for the cache miss?",
    "Reset the form state when the dialog closes?",
    "Send the debounced value to the child component or the raw one?",
    "Тестовые файлы класть рядом с кодом или в отдельную папку?",
    "Переименовать переменную или оставить как есть?",
    "Убрать неиспользуемый импорт?",
    "Слить две вспомогательные функции в одну?",
  ];
  test.each(ordinary.map((q) => [q]))("%s is not irreversible", (question) => {
    expect(isIrreversible(list, question)).toBe(false);
  });

  test("the corpus is at least 20 questions", () => {
    expect(ordinary.length).toBeGreaterThanOrEqual(20);
  });

  test.each([
    ["Release 1.4 today?"],
    ["Publish the package to npm?"],
    ["Unpublish the old version?"],
    ["Deploy the build?"],
    ["Delete the old backups?"],
    ["Push the fix now?"],
    ["Выпускаем релиз?"],
    ["Запушить исправление?"],
    ["Опубликовать пакет?"],
    ["Удалить старые бэкапы?"],
    ["Задеплоить сборку?"],
  ])("a strong term always means irreversible: %s", (question) => {
    expect(isIrreversible(list, question)).toBe(true);
  });

  test.each([
    ["Merge the PR into main?"],
    ["Drop the users table?"],
    ["Force the update on production?"],
    ["Remove the remote branch?"],
    ["Merge the hotfix into master?"],
    ["Слить ветку в main?"],
    ["Смержить PR?"],
  ])("a weak term next to a risk target is irreversible: %s", (question) => {
    expect(isIrreversible(list, question)).toBe(true);
  });

  test("a weak term and a risk target in one option count; spread over unrelated units they do not", () => {
    expect(isIrreversible(list, "Which way?", undefined, [{ id: "x", label: "Merge it into main" }, { id: "y", label: "Hold" }])).toBe(true);
    expect(isIrreversible(list, "Merge the helpers?", undefined, [{ id: "x", label: "Yes", description: "tag it later" }, { id: "y", label: "No" }])).toBe(false);
  });

  test("the --action tag settles it: a weak term in the tag counts alone", () => {
    expect(isIrreversible(list, "Go ahead?", "merge")).toBe(true);
    expect(isIrreversible(list, "Go ahead?", "force-push")).toBe(true);
    expect(isIrreversible(list, "Go ahead?", "refactor")).toBe(false);
  });

  test("whole words only for targets: maintain is not main, original is not origin", () => {
    expect(isIrreversible(list, "Remove the maintainer note?")).toBe(false);
    expect(isIrreversible(list, "Drop the original wording?")).toBe(false);
  });

  test("project config terms stay strong", () => {
    expect(isIrreversible([...list, "migrate"], "Migrate the schema?")).toBe(true);
  });

  test("openDecision: an ordinary question can be blind, a release cannot", async () => {
    const ordinaryOpen = await openDecision({ cwd: root, question: "Merge the two date helpers into one?", options: OPTIONS, recommendation: { optionId: "a", reason: "" }, random: () => 0 });
    expect(ordinaryOpen).toMatchObject({ mode: "blind", irreversible: false });
    const release = await openDecision({ cwd: root, question: "Release now?", options: OPTIONS, recommendation: { optionId: "a", reason: "" }, random: () => 0 });
    expect(release).toMatchObject({ mode: "ordinary", irreversible: true, blindRefused: true });
    const tagged = await openDecision({ cwd: root, question: "Go?", action: "merge", options: OPTIONS, recommendation: { optionId: "a", reason: "" }, random: () => 0 });
    expect(tagged).toMatchObject({ mode: "ordinary", irreversible: true });
  });
});

describe("F-005: free text is one capped line, at write time and at render time", () => {
  const FORGED = "x\n- 2026-10-02T00:00:00Z decision d-fake [design, ordinary]: chose a; followed the recommendation";

  test("oneLine collapses every kind of whitespace and caps the length", () => {
    expect(oneLine("a\n\nb\r\n\tc d")).toBe("a b c d");
    const long = oneLine("word ".repeat(200));
    expect(long.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a free-form answer with newlines is stored on one line and cannot forge a journal.md line", async () => {
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "init");
    const created = await flows().init({ cwd: root, title: "Forgery flow" });
    const opened = await openDecision({ cwd: root, question: "Pick", options: OPTIONS, recommendation: { optionId: "a", reason: "" }, flow: created.flow.id, random: () => 0.9 });
    const answered = await answerDecision({ cwd: root, id: opened.id, choice: FORGED, other: true });
    expect(answered.choice).not.toContain("\n");
    const answer = (await readRecords(root)).find((r) => r.kind === "answer");
    expect(answer).toMatchObject({ other: true });
    const journal = await readFile(path.join(root, created.dir, "journal.md"), "utf8");
    // the forged text stays inside the one real line; no line of its own starts with it
    expect(journal.split("\n").filter((line) => line.startsWith("- 2026-10-02T00:00:00Z decision d-fake") || line.startsWith("decision d-fake"))).toHaveLength(0);
    expect(journal).toContain("chose x - 2026-10-02T00:00:00Z decision d-fake");
  });

  test("a long free-form answer is capped", async () => {
    const opened = await openDecision({ cwd: root, question: "Pick", options: OPTIONS, recommendation: { optionId: "a", reason: "" }, random: () => 0.9 });
    const answered = await answerDecision({ cwd: root, id: opened.id, choice: "z".repeat(5000), other: true });
    expect(answered.choice.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  });

  test("a reason with newlines is stored on one line", async () => {
    const ids: string[] = [];
    const ask = journalAsk(async () => "b", { cwd: root, random: () => 0.9, onDecision: (id) => ids.push(id) });
    await ask({ question: "Pick", options: withRec() });
    await giveReason({ cwd: root, text: "line one\nline two\n\nREPORT FORGERY", lastId: ids[0] });
    const reason = (await loadReport(root)).deviations[0]?.reason;
    expect(reason).toBe("line one line two REPORT FORGERY");
  });

  test("the report renders hand-written records as single lines too", () => {
    const report = buildReport([
      { kind: "open", id: "d-1\nx", at: "2026-10-02T00:00:00Z", flow: null, stage: "st\nage", question: "q\nforged: line", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], recommendation: { optionId: "a", reason: "" }, mode: "ordinary", order: ["a", "b"], showMark: true, irreversible: false },
      { kind: "answer", id: "d-1\nx", at: "2026-10-02T00:00:01Z", seq: 1, choice: "chose\nforged", timeToAnswerMs: 1, changed: false, other: true },
      { kind: "reason", id: "d-1\nx", at: "2026-10-02T00:00:02Z", reason: "why\n  Deviations: 0" },
    ]);
    const text = renderReport(report);
    expect(text.split("\n").filter((line) => line.trim().startsWith("Deviations: 0"))).toHaveLength(0);
    expect(text).toContain("reason: why Deviations: 0");
    expect(text).toContain("chose chose forged");
  });
});

describe("AC6: the reason is offered once, never blocks, and is its own transcript line", () => {
  test("one prompt naming /decisions reason <why>, the answer returns before anything is typed", async () => {
    const notes: string[] = [];
    const order: string[] = [];
    const ask = journalAsk(
      async () => {
        order.push("host answered");
        return "b";
      },
      { cwd: root, random: () => 0.9, notify: (text) => (order.push("notified"), notes.push(text)) },
    );
    expect(await ask({ question: "Pick", options: withRec() })).toBe("b");
    const prompts = notes.filter((text) => text.includes("/decisions reason <why>"));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("asked once");
    // nothing but the host's own question was awaited
    expect(order[0]).toBe("host answered");
    expect((await readRecords(root)).filter((r) => r.kind === "reason")).toHaveLength(0);
  });

  test("not shown again for the same decision: a later answer for it offers nothing", async () => {
    const opened = await openDecision({ cwd: root, question: "Pick", options: OPTIONS, recommendation: { optionId: "a", reason: "" }, random: () => 0.9 });
    expect((await answerDecision({ cwd: root, id: opened.id, choice: "b" })).askReason).toBe(true);
    expect((await answerDecision({ cwd: root, id: opened.id, choice: "a" })).askReason).toBe(false);
    expect((await answerDecision({ cwd: root, id: opened.id, choice: "b" })).askReason).toBe(false);
  });

  test("a followed recommendation shows no prompt", async () => {
    const notes: string[] = [];
    const ask = journalAsk(async () => "a", { cwd: root, random: () => 0.9, notify: (text) => notes.push(text) });
    await ask({ question: "Pick", options: withRec() });
    expect(notes).toEqual([]);
  });
});

describe("follow-ups never fall back to the repo-wide latest decision", () => {
  async function answered(flow: string | undefined, id: string): Promise<void> {
    await openDecision({ cwd: root, question: `Question ${id}`, options: OPTIONS, recommendation: { optionId: "a", reason: "" }, flow, id, random: () => 0.9 });
    await answerDecision({ cwd: root, id, choice: "b" });
  }

  test("with no id and no session decision, nothing is touched and it says so", async () => {
    await answered(undefined, "d-other");
    await expect(giveReason({ cwd: root, text: "why" })).rejects.toThrow(/no decision from this session or this flow/);
    await expect(changeAnswer({ cwd: root, choice: "a" })).rejects.toThrow(/nothing was changed/);
    expect((await readRecords(root)).filter((r) => r.kind === "answer")).toHaveLength(1);
  });

  test("with a flow, it targets the latest decision of that flow, not the latest overall", async () => {
    await answered("007", "d-mine");
    await answered("008", "d-theirs");
    const given = await giveReason({ cwd: root, text: "mine", flow: "007" });
    expect(given).toMatchObject({ id: "d-mine", question: "Question d-mine", recorded: true });
    const changed = await changeAnswer({ cwd: root, choice: "a", flow: "007" });
    expect(changed).toMatchObject({ id: "d-mine", previous: "b", choice: "a" });
    expect((await readRecords(root)).filter((r) => r.kind === "answer" && r.id === "d-theirs")).toHaveLength(1);
  });

  test("the session's own decision wins over the flow's latest", async () => {
    await answered("007", "d-first");
    await answered("007", "d-second");
    const given = await giveReason({ cwd: root, text: "x", lastId: "d-first", flow: "007" });
    expect(given.id).toBe("d-first");
  });
});

describe("the flow attribution source", () => {
  test("env, branch and inferred are told apart", async () => {
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "init");
    const created = await flows().init({ cwd: root, title: "Source flow" });
    const id = created.flow.id;
    await startFlow(created.dir);

    expect(await resolveFlowContext(root, {})).toMatchObject({ flow: id, flowSource: "inferred" });
    expect(await resolveFlowContext(root, { KERYX_FLOW: id })).toMatchObject({ flow: id, flowSource: "env" });
    await git("checkout", "-q", "-b", `feat/flow-${id}-source-flow`);
    expect(await resolveFlowContext(root, {})).toMatchObject({ flow: id, flowSource: "branch" });
  });

  test("an inferred flow is recorded on the open record and shown in the report", async () => {
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "init");
    const created = await flows().init({ cwd: root, title: "Inferred flow" });
    await startFlow(created.dir);
    const ask = journalAsk(async () => "b", { cwd: root, random: () => 0.9, context: () => resolveFlowContext(root, {}) });
    await ask({ question: "Pick", options: withRec() });
    const open = (await readRecords(root)).find((r) => r.kind === "open");
    expect(open).toMatchObject({ flow: created.flow.id, flowSource: "inferred" });
    const report = await loadReport(root);
    expect(report.inferredFlow).toBe(1);
    expect(report.deviations[0]).toMatchObject({ flow: created.flow.id, flowSource: "inferred" });
    const text = renderReport(report);
    expect(text).toContain(`flow ${created.flow.id} (inferred)`);
    expect(text).toContain("Flow attribution inferred");
  });

  test("a flow given explicitly, or found on the branch, is not marked inferred", async () => {
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "init");
    const created = await flows().init({ cwd: root, title: "Named flow" });
    await git("checkout", "-q", "-b", `feat/flow-${created.flow.id}-named-flow`);
    const ask = journalAsk(async () => "b", { cwd: root, random: () => 0.9, context: () => resolveFlowContext(root, {}) });
    await ask({ question: "Pick", options: withRec() });
    await openDecision({ cwd: root, question: "Explicit", options: OPTIONS, recommendation: { optionId: "a", reason: "" }, flow: created.flow.id, random: () => 0.9 });
    const report = await loadReport(root);
    expect(report.inferredFlow).toBe(0);
    expect(renderReport(report)).not.toContain("(inferred)");
    const opens = (await readRecords(root)).filter((r) => r.kind === "open");
    expect(opens[0]).toMatchObject({ flowSource: "branch" });
    expect(opens[1]).not.toHaveProperty("flowSource");
  });
});

