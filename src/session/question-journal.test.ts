import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRecords } from "../decisions/store";
import type { AnswerRecord, OpenRecord, ReasonRecord } from "../decisions/types";
import { ASK_USER_CANCEL, ASK_USER_NO_HOST, type AskUserAnswer, type AskUserRequest } from "../harness/tool/builtin/ask-user-tool";
import { decisionsFollowup } from "../tui/decisions-surface";
import { createNativeQuestionJournal } from "./question-journal";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function checkout() {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-native-journal-")); roots.push(cwd);
  expect(await Bun.spawn(["git", "init", "-q", cwd], { env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).exited).toBe(0);
  return cwd;
}
const question: AskUserRequest = { question: "Which parity path should the fixture take?", recommendationReason: "A is the default path.",
  options: [{ id: "option-a", label: "Path A", description: "The default", recommended: true }, { id: "option-b", label: "Path B", description: "The other one" }] };
/** The session's own question service as the journal sees it: shows each question it is asked and answers from a script. */
function service(answers: AskUserAnswer[], admissible = true) {
  const shown: AskUserRequest[] = [];
  return { shown, admissible: () => admissible, ask: async (request: AskUserRequest) => { shown.push(request); return answers.shift() ?? ASK_USER_CANCEL; } };
}
function journal(cwd: string, questions: ReturnType<typeof service>, notes: string[] = []) {
  return createNativeQuestionJournal({ cwd, session: "hub-session-1", ask: questions.ask, admissible: questions.admissible, notify: (text) => notes.push(`notify:${text}`), note: () => notes.push("note") });
}

test("a native question is journaled before it is shown and its answer after, in the TUI's journal format, by the session that asked", async () => {
  const cwd = await checkout(); const questions = service([{ kind: "option", choice: "option-b" }]); const native = journal(cwd, questions);
  expect(await native.ask(question)).toEqual({ kind: "option", choice: "option-b" });
  const records = await readRecords(cwd);
  const open = records.find((record): record is OpenRecord => record.kind === "open");
  expect(open).toMatchObject({ question: question.question, session: "hub-session-1", channel: "hub", source: "ask_user", flow: null, reasonPrompt: false,
    recommendation: { optionId: "option-a", reason: "A is the default path." } });
  expect(records.filter((record): record is AnswerRecord => record.kind === "answer")).toMatchObject([{ id: open!.id, choice: "option-b", seq: 1 }]);
  expect(native.lastDecisionId()).toBe(open!.id);
  // One question per ask: a deviation never holds the turn for a second, reason question (the reason comes later, or with the pick).
  expect(questions.shown).toHaveLength(1);
  expect(questions.shown[0]!.options.map((option) => option.id).sort()).toEqual(["option-a", "option-b"]);
});

test("the TUI's /decisions reason and change act on the native decision through the session that asked it, and on no other session's", async () => {
  const cwd = await checkout(); const native = journal(cwd, service([{ kind: "option", choice: "option-b" }]));
  await native.ask(question);
  const deps = { cwd, lastDecisionId: native.lastDecisionId, session: native.session, flowContext: async () => ({}) };
  const id = native.lastDecisionId()!;
  expect(await decisionsFollowup({ kind: "reason", text: "the fixture said so" }, deps)).toEqual({ ok: true, decisionId: id, text: `Reason recorded for decision ${id} ("Which parity path should the fixture take?").` });
  expect(await decisionsFollowup({ kind: "change", choice: "option-a" }, deps)).toMatchObject({ ok: true, decisionId: id, text: expect.stringContaining("answer changed from option-b to option-a") });
  const records = await readRecords(cwd);
  expect(records.filter((record): record is ReasonRecord => record.kind === "reason").map((record) => record.reason)).toEqual(["the fixture said so"]);
  expect(records.filter((record): record is AnswerRecord => record.kind === "answer").map((record) => [record.choice, record.changed])).toEqual([["option-b", false], ["option-a", true]]);
  // Another session (no decision of its own) is refused and changes nothing.
  expect(await decisionsFollowup({ kind: "change", choice: "option-b" }, { cwd, lastDecisionId: () => undefined, session: "hub-session-2", flowContext: async () => ({}) })).toMatchObject({ ok: false });
  expect((await readRecords(cwd)).length).toBe(records.length);
});

test("a typed reason with the pick is recorded at once; a cancel or a question the host could not show records no answer", async () => {
  const cwd = await checkout();
  await journal(cwd, service([{ kind: "option", choice: "option-b", reason: "B fits" }])).ask(question);
  expect((await readRecords(cwd)).filter((record): record is ReasonRecord => record.kind === "reason").map((record) => record.reason)).toEqual(["B fits"]);
  const other = await checkout();
  expect(await journal(other, service([ASK_USER_CANCEL])).ask(question)).toBe(ASK_USER_CANCEL);
  expect(await journal(other, service([ASK_USER_NO_HOST])).ask({ ...question, question: "A second question?" })).toBe(ASK_USER_NO_HOST);
  expect((await readRecords(other)).filter((record) => record.kind === "answer")).toEqual([]);
});

test("a question the session would not show is passed through unrecorded, exactly as the TUI passes a hostless one", async () => {
  const cwd = await checkout(); const questions = service([ASK_USER_NO_HOST], false);
  expect(await journal(cwd, questions).ask(question)).toBe(ASK_USER_NO_HOST);
  expect(questions.shown).toEqual([question]);
  expect(await readRecords(cwd)).toEqual([]);
});
